import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import {
  Channel,
  fireAndForget,
  invoke,
  isElectronRuntime,
  listenServerMessage,
  onBrowserTransportEvent,
} from '../../lib/ipc';
import { dispatchByType, type DispatchByTypeHandlerMap } from '../../lib/dispatch-by-type';
import { getTerminalFontFamily } from '../../lib/fonts';
import {
  detectProbeInOutput,
  getTerminalTraceTimestampMs,
  hasTerminalTraceClockAlignment,
  hasPendingProbes,
  recordOutputReceived,
} from '../../lib/terminalLatency';
import {
  recordTerminalRenderEvent,
  recordTerminalRenderResize,
} from '../../lib/terminal-output-diagnostics';
import { createTerminalFitLifecycle } from '../../lib/terminalFitLifecycle';
import {
  registerTerminal,
  scheduleFitIfDirty,
  unregisterTerminal,
} from '../../lib/terminalFitManager';
import { getTerminalShortcutAction } from '../../lib/terminal-shortcuts';
import { matchesGlobalShortcut } from '../../lib/shortcuts';
import { getTerminalTheme } from '../../lib/theme';
import { acquireWebglAddon, releaseWebglAddon } from '../../lib/webglPool';
import { isMac } from '../../lib/platform';
import {
  recordTerminalFitExecution,
  recordTerminalFitSchedule,
  recordTerminalRendererSwap,
  type TerminalFitExecutionSource,
  type TerminalFitScheduleReason,
} from '../../app/runtime-diagnostics';
import { showNotification } from '../../store/notification';
import { store } from '../../store/store';
import { subscribeTaskCommandControllerChanges } from '../../store/task-command-controllers';
import { getRuntimeClientId } from '../../lib/runtime-client-id';
import type { PtyExitData, PtyOutput } from '../../ipc/types';
import { createTerminalInputPipeline } from './terminal-input-pipeline';
import { createTerminalOutputPipeline } from './terminal-output-pipeline';
import { createTerminalRenderHibernationController } from './terminal-render-hibernation';
import {
  createTerminalRecoveryRuntime,
  type TerminalRecoveryRuntime,
} from './terminal-recovery-runtime';
import type { TerminalViewProps, TerminalViewStatus } from './types';
import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';

const INITIAL_COMMAND_DELAY_MS = 50;
const PROBE_TEXT_DECODER = new TextDecoder();
const TASK_CONTROLLED_AGENT_ERROR_MESSAGE = 'Task is controlled by another client';
type TerminalFitEnsureReason = 'attach' | 'renderer-loss' | 'restore' | 'spawn-ready';
interface TerminalGeometry {
  cols: number;
  rows: number;
}

function decodeTerminalOutputData(data: Extract<PtyOutput, { type: 'Data' }>['data']): Uint8Array {
  if (typeof data !== 'string') {
    return data;
  }

  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

export interface TerminalSession {
  cleanup(): void;
  fitAddon: FitAddon;
  flushPendingResize(): void;
  isRestoreBlocked(): boolean;
  prewarmRenderHibernation(): void;
  requestInputTakeover(): Promise<boolean>;
  term: Terminal;
  updateOutputPriority(): void;
}

export interface StartTerminalSessionOptions {
  canAcceptInput?: () => boolean;
  containerRef: HTMLDivElement;
  getOutputPriority: () => TerminalOutputPriority;
  getRenderHibernationDelayMs?: () => number | null;
  isSelectedRecoveryProtected?: () => boolean;
  onAttachBound?: () => void;
  onBlockedInputAttempt?: () => void;
  onRenderHibernationChange?: (isHibernating: boolean) => void;
  onReadOnlyInputAttempt?: () => void;
  onRestoreBlockedChange?: (isBlocked: boolean) => void;
  onSelectedRecoverySettle?: () => void;
  onSelectedRecoveryStart?: () => void;
  onShouldKeepRenderLive?: () => boolean;
  onStatusChange?: (status: TerminalViewStatus) => void;
  props: TerminalViewProps;
  shouldCommitResize?: () => boolean;
}

function shouldTrackKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.isComposing) {
    return false;
  }

  switch (event.key) {
    case 'Alt':
    case 'CapsLock':
    case 'Control':
    case 'Fn':
    case 'Meta':
    case 'NumLock':
    case 'ScrollLock':
    case 'Shift':
      return false;
    default:
      return true;
  }
}

export function startTerminalSession(options: StartTerminalSessionOptions): TerminalSession {
  const { containerRef, onReadOnlyInputAttempt, onStatusChange, props } = options;
  const taskId = props.taskId;
  const agentId = props.agentId;
  const initialFontSize = props.fontSize ?? 13;
  const browserMode = !isElectronRuntime();
  const runtimeClientId = getRuntimeClientId();
  const cleanupCallbacks: Array<() => void> = [];
  const outputChannel = new Channel<PtyOutput>();

  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: getTerminalFontFamily(store.terminalFont),
    fontSize: initialFontSize,
    scrollback: 3000,
    theme: getTerminalTheme(store.themePreset),
  });
  const fitAddon = new FitAddon();

  let browserTransportCleanup: (() => void) | undefined;
  let currentStatus: TerminalViewStatus = 'binding';
  let disposed = false;
  let fitReady = false;
  let initialCommandSent = false;
  let initialCommandTimer: number | undefined;
  let pendingExitPayload: PtyExitData | null = null;
  let processExited = false;
  let readyFallbackTimer: number | undefined;
  let readyRequested = false;
  let spawnFailed = false;
  let spawnReady = false;
  let attachBound = false;
  let recoveryRuntime: TerminalRecoveryRuntime | null = null;
  let hasDeferredSessionFitStabilization = false;

  function setStatus(status: TerminalViewStatus): void {
    currentStatus = status;
    onStatusChange?.(status);
  }

  function markAttachBound(): void {
    if (attachBound) {
      return;
    }

    attachBound = true;
    options.onAttachBound?.();
  }

  function getOutputPriority(): TerminalOutputPriority {
    return options.getOutputPriority();
  }

  function getRenderHibernationDelayMs(): number | null {
    return options.getRenderHibernationDelayMs?.() ?? null;
  }

  function isRestoreBlockingRenderHibernation(): boolean {
    return recoveryRuntime?.isRestoreBlocked() === true;
  }

  function syncRenderHibernationAfterIdle(): void {
    flushPendingExitWhenIdle();
    renderHibernation.sync();
  }

  function handleResizeTransactionChange(active: boolean): void {
    if (!active) {
      runDeferredSessionFitStabilization();
      scheduleFitIfDirty(agentId);
    }
  }

  function clearReadyFallback(): void {
    if (readyFallbackTimer === undefined) {
      return;
    }

    clearTimeout(readyFallbackTimer);
    readyFallbackTimer = undefined;
  }

  function clearInitialCommandTimer(): void {
    if (initialCommandTimer === undefined) {
      return;
    }

    window.clearTimeout(initialCommandTimer);
    initialCommandTimer = undefined;
  }

  function flushReadyState(): void {
    if (
      disposed ||
      spawnFailed ||
      !readyRequested ||
      !fitReady ||
      isRestoreBlockingRenderHibernation()
    ) {
      return;
    }

    readyRequested = false;
    clearReadyFallback();
    setStatus('ready');
    runDeferredSessionFitStabilization();
  }

  function runTerminalFit(source: TerminalFitExecutionSource): void {
    const previousCols = term.cols;
    const previousRows = term.rows;
    fitAddon.fit();
    recordTerminalFitExecution({
      geometryChanged: previousCols !== term.cols || previousRows !== term.rows,
      source,
    });
  }

  function canRunSessionFitStabilization(): boolean {
    return (
      currentStatus === 'ready' &&
      !isRestoreBlockingRenderHibernation() &&
      options.shouldCommitResize?.() !== false &&
      !inputPipeline.isResizeTransactionPending()
    );
  }

  function runDeferredSessionFitStabilization(): void {
    if (disposed || !fitReady || !hasDeferredSessionFitStabilization) {
      return;
    }

    if (!canRunSessionFitStabilization()) {
      return;
    }

    hasDeferredSessionFitStabilization = false;
    runTerminalFit('session-immediate');
    requestAnimationFrame(() => {
      if (!disposed && canRunSessionFitStabilization()) {
        runTerminalFit('session-raf');
      }
    });
  }

  function applyCommittedResizeFit(geometry: TerminalGeometry): void {
    if (disposed) {
      return;
    }

    const proposedGeometry = fitAddon.proposeDimensions();
    if (!proposedGeometry) {
      return;
    }

    if (proposedGeometry.cols !== geometry.cols || proposedGeometry.rows !== geometry.rows) {
      return;
    }

    if (term.cols === geometry.cols && term.rows === geometry.rows) {
      return;
    }

    runTerminalFit('resize-commit');
  }

  function scheduleTerminalFitStabilization(reason: TerminalFitScheduleReason): void {
    recordTerminalFitSchedule(reason);
    if (fitReady) {
      if (!canRunSessionFitStabilization()) {
        hasDeferredSessionFitStabilization = true;
        return;
      }

      runTerminalFit('session-immediate');
      requestAnimationFrame(() => {
        if (!disposed && canRunSessionFitStabilization()) {
          runTerminalFit('session-raf');
        }
      });
      return;
    }

    fitLifecycle.scheduleStabilize();
  }

  async function ensureTerminalFitReady(reason: TerminalFitEnsureReason): Promise<boolean> {
    scheduleTerminalFitStabilization(reason);
    const ready = await fitLifecycle.ensureReady();
    fitReady = ready;
    if (!fitReady) {
      return false;
    }

    inputPipeline.flushPendingResize();
    flushReadyState();
    if (!isRestoreBlockingRenderHibernation() && outputPipeline.hasQueuedOutput()) {
      outputPipeline.scheduleOutputFlush();
    }
    return true;
  }

  async function waitForTerminalFitReady(reason: TerminalFitEnsureReason): Promise<boolean> {
    while (!disposed && !spawnFailed) {
      if (await ensureTerminalFitReady(reason)) {
        return true;
      }
    }

    return false;
  }

  function markTerminalReady(): void {
    if (disposed || spawnFailed) {
      return;
    }

    const wasReadyRequested = readyRequested;
    readyRequested = true;
    flushReadyState();
    if (readyRequested && !wasReadyRequested) {
      scheduleTerminalFitStabilization('ready');
    }
  }

  function scheduleReadyFallback(): void {
    if (readyFallbackTimer !== undefined || disposed || spawnFailed) {
      return;
    }

    readyFallbackTimer = window.setTimeout(() => {
      readyFallbackTimer = undefined;
      markTerminalReady();
    }, 500);
  }

  function emitExit(payload: PtyExitData): void {
    processExited = true;
    term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
    props.onExit?.(payload);
  }

  function clearSelectionAfterCopy(): void {
    queueMicrotask(() => term.clearSelection());
  }

  async function copySelectionToClipboard(): Promise<void> {
    const selection = term.getSelection();
    if (!selection) {
      return;
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(selection);
        term.clearSelection();
        return;
      } catch (error) {
        console.warn('[terminal] Failed to write clipboard text', error);
      }
    }

    try {
      if (document.execCommand('copy')) {
        term.clearSelection();
        return;
      }
    } catch (error) {
      console.warn('[terminal] execCommand(copy) failed', error);
    }

    showNotification('Copy failed. Use your browser copy shortcut or the context menu.');
  }

  async function pasteFromClipboard(): Promise<void> {
    if (!navigator.clipboard?.readText) {
      showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        return;
      }

      inputPipeline.setNextProgrammaticInputTrace(text);
      term.paste(text);
    } catch (error) {
      console.warn('[terminal] Failed to read clipboard text', error);
      showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
    }
  }

  function flushPendingExitWhenIdle(): void {
    if (
      !pendingExitPayload ||
      outputPipeline.hasWriteInFlight() ||
      outputPipeline.hasQueuedOutput()
    ) {
      return;
    }

    const exitPayload = pendingExitPayload;
    pendingExitPayload = null;
    emitExit(exitPayload);
  }

  const fitLifecycle = createTerminalFitLifecycle({
    fit: () => {
      runTerminalFit('lifecycle');
    },
    getMeasuredSize: () => ({
      height: containerRef.clientHeight,
      width: containerRef.clientWidth,
    }),
    getTerminalSize: () => ({
      cols: term.cols,
      rows: term.rows,
    }),
    onReady: () => {
      fitReady = true;
      inputPipeline.flushPendingResize();
      flushReadyState();
      if (!recoveryRuntime?.isOutputFlushBlocked() && outputPipeline.hasQueuedOutput()) {
        outputPipeline.scheduleOutputFlush();
      }
    },
  });

  const outputPipeline = createTerminalOutputPipeline({
    agentId,
    canFlushOutput: () => fitReady && !recoveryRuntime?.isOutputFlushBlocked(),
    channelId: outputChannel.id,
    getOutputPriority,
    isDisposed: () => disposed,
    isSpawnFailed: () => spawnFailed,
    markTerminalReady,
    onChunkRendered: (outputRenderedAtMs) => {
      inputPipeline.finalizePendingInputTraceEchoes(outputRenderedAtMs);
    },
    onQueueEmpty: syncRenderHibernationAfterIdle,
    props,
    taskId,
    term,
  });

  const renderHibernation = createTerminalRenderHibernationController({
    getOutputPriority,
    getRenderHibernationDelayMs,
    hasQueuedOutput: () => outputPipeline.hasQueuedOutput(),
    hasSuppressedOutputSinceHibernation: () => outputPipeline.hasSuppressedOutputSinceHibernation(),
    hasWriteInFlight: () => outputPipeline.hasWriteInFlight(),
    isDisposed: () => disposed,
    isRestoreBlocked: isRestoreBlockingRenderHibernation,
    isSpawnFailed: () => spawnFailed,
    isSpawnReady: () => spawnReady,
    onRenderHibernationChange: (isHibernating) => {
      options.onRenderHibernationChange?.(isHibernating);
      outputPipeline.setRenderHibernating(isHibernating);
    },
    onShouldKeepRenderLive: options.onShouldKeepRenderLive,
    restoreTerminalOutput: async () => {
      await recoveryRuntime?.restoreTerminalOutput('hibernate');
    },
    scheduleOutputFlush: () => {
      outputPipeline.scheduleOutputFlush();
    },
  });

  const inputPipeline = createTerminalInputPipeline({
    agentId,
    armInteractiveEchoFastPath: outputPipeline.armInteractiveEchoFastPath,
    canAcceptInput: options.canAcceptInput,
    isDisposed: () => disposed,
    isProcessExited: () => processExited,
    isRestoreBlocked: isRestoreBlockingRenderHibernation,
    isSpawnFailed: () => spawnFailed,
    isSpawnReady: () => spawnReady,
    onBlockedInputAttempt: options.onBlockedInputAttempt,
    onReadOnlyInputAttempt,
    onResizeCommitted: applyCommittedResizeFit,
    onResizeTransactionChange: handleResizeTransactionChange,
    props,
    runtimeClientId,
    shouldCommitResize: options.shouldCommitResize,
    taskId,
    term,
  });

  recoveryRuntime = createTerminalRecoveryRuntime({
    agentId,
    channelId: outputChannel.id,
    ensureTerminalFitReady,
    getCurrentStatus: () => currentStatus,
    getOutputPriority,
    isSelectedRecoveryProtected: () => options.isSelectedRecoveryProtected?.() === true,
    inputPipeline,
    isRenderHibernating: () => renderHibernation.isRecoveryVisible(),
    isDisposed: () => disposed,
    isSpawnFailed: () => spawnFailed,
    isSpawnReady: () => spawnReady,
    markTerminalReady,
    onRestoreBlockedChange: options.onRestoreBlockedChange,
    onRestoreSettled: syncRenderHibernationAfterIdle,
    onSelectedRecoverySettle: options.onSelectedRecoverySettle,
    onSelectedRecoveryStart: options.onSelectedRecoveryStart,
    outputPipeline,
    setStatus,
    taskId,
    term,
  });

  const outputHandlers = {
    Data(message: Extract<PtyOutput, { type: 'Data' }>): void {
      const receiveTs = recordOutputReceived();
      const outputReceivedAtMs = getTerminalTraceTimestampMs();
      const decoded = decodeTerminalOutputData(message.data);
      if (hasPendingProbes()) {
        detectProbeInOutput(PROBE_TEXT_DECODER.decode(decoded));
      }
      inputPipeline.detectPendingInputTraceEcho(decoded, outputReceivedAtMs);
      outputPipeline.enqueueOutput(decoded, receiveTs);
      if (!initialCommandSent && props.initialCommand) {
        initialCommandSent = true;
        initialCommandTimer = window.setTimeout(() => {
          initialCommandTimer = undefined;
          if (disposed) {
            return;
          }
          inputPipeline.enqueueProgrammaticInput(`${props.initialCommand}\r`);
        }, INITIAL_COMMAND_DELAY_MS);
      }
    },
    Exit(message: Extract<PtyOutput, { type: 'Exit' }>): void {
      pendingExitPayload = message.data;
      outputPipeline.flushOutputQueue();
      if (
        fitReady &&
        !outputPipeline.hasWriteInFlight() &&
        !outputPipeline.hasQueuedOutput() &&
        pendingExitPayload
      ) {
        flushPendingExitWhenIdle();
      }
    },
    RecoveryRequired(message: Extract<PtyOutput, { type: 'RecoveryRequired' }>): void {
      void recoveryRuntime.restoreTerminalOutput(message.reason);
    },
  } satisfies DispatchByTypeHandlerMap<PtyOutput>;

  outputChannel.onmessage = (message) => dispatchByType(outputHandlers, message);

  term.loadAddon(fitAddon);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          window.open(uri, '_blank');
        }
      } catch {
        // ignore invalid URL
      }
    }),
  );
  term.open(containerRef);
  setStatus('binding');
  props.onReady?.(() => term.focus());
  props.onBufferReady?.(() => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index <= buffer.length - 1; index += 1) {
      const line = buffer.getLine(index);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  });

  if (browserMode) {
    containerRef.addEventListener('copy', clearSelectionAfterCopy);
    cleanupCallbacks.push(() => {
      containerRef.removeEventListener('copy', clearSelectionAfterCopy);
    });
  }

  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== 'keydown') {
      return true;
    }
    if (matchesGlobalShortcut(event)) {
      return false;
    }

    const shortcutAction = getTerminalShortcutAction(event, {
      browserMode,
      hasSelection: term.hasSelection(),
      isMac,
    });
    if (shortcutAction.preventDefault) {
      event.preventDefault();
    }

    if (
      shortcutAction.kind === 'allow' &&
      hasTerminalTraceClockAlignment() &&
      shouldTrackKeyboardEvent(event)
    ) {
      inputPipeline.recordKeyboardTraceStart();
    }

    switch (shortcutAction.kind) {
      case 'allow':
        return true;
      case 'block':
        return false;
      case 'copy':
        void copySelectionToClipboard();
        return false;
      case 'paste':
        void pasteFromClipboard();
        return false;
    }
  });

  registerTerminal(
    agentId,
    containerRef,
    fitAddon,
    term,
    () => {
      return (
        options.shouldCommitResize?.() !== false && !inputPipeline.isResizeTransactionPending()
      );
    },
    ({ cols, rows }) => {
      inputPipeline.handleTerminalResize(cols, rows);
    },
  );
  scheduleTerminalFitStabilization('startup');

  const handleVisibilityResume = (): void => {
    if (document.visibilityState === 'hidden') {
      return;
    }

    scheduleTerminalFitStabilization('visibility');
  };

  document.addEventListener('visibilitychange', handleVisibilityResume);
  window.addEventListener('pageshow', handleVisibilityResume);
  cleanupCallbacks.push(
    subscribeTaskCommandControllerChanges((snapshot) => {
      if (snapshot.taskId !== taskId) {
        return;
      }

      inputPipeline.handleControllerChange(snapshot.controllerId);
    }),
    () => {
      document.removeEventListener('visibilitychange', handleVisibilityResume);
      window.removeEventListener('pageshow', handleVisibilityResume);
    },
  );

  term.onData((data) => {
    inputPipeline.handleTerminalData(data);
  });

  term.onResize(({ cols, rows }) => {
    recordTerminalRenderResize({
      agentId,
      taskId,
    });
    inputPipeline.handleTerminalResize(cols, rows);
  });

  term.onRender(({ end, start }) => {
    recordTerminalRenderEvent({
      agentId,
      endRow: end,
      startRow: start,
      taskId,
      term,
    });
  });

  if (
    acquireWebglAddon(agentId, term, () => recoveryRuntime.restoreTerminalOutput('renderer-loss'))
  ) {
    recordTerminalRendererSwap('attach');
  }

  if (!isElectronRuntime()) {
    cleanupCallbacks.push(
      listenServerMessage('agent-error', (message) => {
        if (
          message.agentId !== agentId ||
          !String(message.message).includes(TASK_CONTROLLED_AGENT_ERROR_MESSAGE)
        ) {
          return;
        }

        inputPipeline.handleTaskControlLoss();
      }),
    );
    browserTransportCleanup = onBrowserTransportEvent((event) => {
      if (event.kind !== 'connection') {
        return;
      }

      switch (event.state) {
        case 'connected':
        case 'disconnected':
        case 'reconnecting':
          recoveryRuntime?.handleBrowserTransportConnectionState(event.state);
          return;
        case 'auth-expired':
          recoveryRuntime?.handleBrowserTransportConnectionState('disconnected');
          return;
        case 'connecting':
          return;
      }
    });
  }

  void (async () => {
    try {
      await outputChannel.ready;
      if (disposed) {
        return;
      }

      setStatus('attaching');
      const attachFitReady = await waitForTerminalFitReady('attach');
      if (!attachFitReady || disposed) {
        return;
      }
      const spawnResult = await invoke(IPC.SpawnAgent, {
        adapter: props.adapter,
        agentId,
        args: props.args,
        cols: term.cols,
        command: props.command,
        controllerId: runtimeClientId,
        cwd: props.cwd,
        env: props.env ?? {},
        isShell: props.isShell,
        onOutput: outputChannel,
        resumeOnStart: props.resumeOnStart === true,
        rows: term.rows,
        taskId,
      });
      spawnReady = true;
      markAttachBound();
      void waitForTerminalFitReady('spawn-ready');
      if (spawnResult.attachedExistingSession) {
        await recoveryRuntime.restoreTerminalOutput('attach');
      }
      outputPipeline.recoverFlowControlIfIdle();
      scheduleReadyFallback();
      inputPipeline.flushPendingResize();
      inputPipeline.flushPendingInput();
      inputPipeline.drainInputQueue();
      renderHibernation.sync();
    } catch (error) {
      if (disposed) {
        return;
      }

      spawnFailed = true;
      setStatus('error');
      // eslint-disable-next-line no-control-regex -- intentionally stripping control characters from terminal error output
      const safeError = String(error).replace(/[\x00-\x1f\x7f]/g, '');
      term.write(`\x1b[31mFailed to spawn: ${safeError}\x1b[0m\r\n`);
      props.onExit?.({
        exit_code: null,
        last_output: [`Failed to spawn: ${safeError}`],
        signal: 'spawn_failed',
      });
    }
  })();

  return {
    cleanup(): void {
      clearInitialCommandTimer();
      options.onRestoreBlockedChange?.(false);
      renderHibernation.cleanup();
      disposed = true;
      clearReadyFallback();
      inputPipeline.cleanup();
      outputPipeline.cleanup();
      fireAndForget(IPC.ResumeAgent, {
        agentId,
        channelId: outputChannel.id,
        reason: 'flow-control',
      });
      fireAndForget(IPC.DetachAgentOutput, { agentId, channelId: outputChannel.id });
      outputChannel.cleanup?.();
      browserTransportCleanup?.();
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
      fitLifecycle.cleanup();
      releaseWebglAddon(agentId);
      unregisterTerminal(agentId);
      term.dispose();
    },
    fitAddon,
    flushPendingResize(): void {
      inputPipeline.flushPendingResize();
      runDeferredSessionFitStabilization();
    },
    isRestoreBlocked(): boolean {
      return recoveryRuntime?.isRestoreBlocked() ?? false;
    },
    prewarmRenderHibernation(): void {
      void renderHibernation.prewarm();
    },
    requestInputTakeover(): Promise<boolean> {
      return inputPipeline.requestInputTakeover();
    },
    term,
    updateOutputPriority(): void {
      outputPipeline.updateOutputPriority();
      renderHibernation.sync();
      scheduleFitIfDirty(agentId);
      inputPipeline.flushPendingResize();
      runDeferredSessionFitStabilization();
    },
  };
}
