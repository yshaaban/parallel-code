import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { getTerminalFontFamily } from '../../lib/fonts';
import {
  BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE,
  Channel,
  cancelBrowserAgentCommandRequest,
  fireAndForget,
  invoke,
  isElectronRuntime,
  listenServerMessage,
  onBrowserTransportEvent,
} from '../../lib/ipc';
import {
  detectProbeInOutput,
  hasPendingProbes,
  recordFlowEvent,
  recordInputBuffered,
  recordInputQueued,
  recordInputSent,
  recordOutputReceived,
  recordOutputWritten,
} from '../../lib/terminalLatency';
import { createTerminalFitLifecycle } from '../../lib/terminalFitLifecycle';
import { getTerminalShortcutAction } from '../../lib/terminal-shortcuts';
import { registerTerminal, unregisterTerminal } from '../../lib/terminalFitManager';
import { requestScrollbackRestore } from '../../lib/scrollbackRestore';
import { matchesGlobalShortcut } from '../../lib/shortcuts';
import { getTerminalTheme } from '../../lib/theme';
import { acquireWebglAddon, releaseWebglAddon, touchWebglAddon } from '../../lib/webglPool';
import { isMac } from '../../lib/platform';
import { getRuntimeClientId } from '../../lib/runtime-client-id';
import { createTaskCommandLeaseSession } from '../../app/task-command-lease';
import { showNotification } from '../../store/notification';
import { store } from '../../store/store';
import { subscribeTaskCommandControllerChanges } from '../../store/task-command-controllers';
import type { PtyOutput } from '../../ipc/types';
import type { TerminalViewProps, TerminalViewStatus } from './types';
import {
  DEFAULT_MAX_PENDING_CHARS,
  getTerminalInputBatchPlan,
  mergePendingInputCharLimit,
  splitTerminalInputChunks,
  takeQueuedTerminalInputBatch,
} from '../../lib/terminal-input-batching';

const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

const PROBE_TEXT_DECODER = new TextDecoder();
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;
const INPUT_RETRY_DELAY_MS = 50;
const INITIAL_COMMAND_DELAY_MS = 50;
const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;
const RESIZE_FLUSH_DELAY_MS = 33;
const RESTORE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const TASK_CONTROLLED_AGENT_ERROR_MESSAGE = 'Task is controlled by another client';

function base64ToUint8Array(base64: string): Uint8Array {
  let end = base64.length;
  while (end > 0 && base64.charCodeAt(end - 1) === 61) {
    end--;
  }
  const output = new Uint8Array((end * 3) >>> 2);
  let outputIndex = 0;
  for (let index = 0; index < end; ) {
    const a = B64_LOOKUP[base64.charCodeAt(index++)];
    const b = index < end ? B64_LOOKUP[base64.charCodeAt(index++)] : 0;
    const c = index < end ? B64_LOOKUP[base64.charCodeAt(index++)] : 0;
    const d = index < end ? B64_LOOKUP[base64.charCodeAt(index++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    output[outputIndex++] = (triplet >>> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (triplet >>> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = triplet & 0xff;
  }
  return output;
}

interface TerminalSession {
  cleanup(): void;
  fitAddon: FitAddon;
  requestInputTakeover(): Promise<boolean>;
  term: Terminal;
}

interface QueuedInputChunk {
  data: string;
  queuedAt: number;
}

interface InFlightInputBatch {
  batch: string;
  count: number;
  queuedAt: number;
  requestId: string;
}

interface StartTerminalSessionOptions {
  containerRef: HTMLDivElement;
  onReadOnlyInputAttempt?: () => void;
  onStatusChange?: (status: TerminalViewStatus) => void;
  props: TerminalViewProps;
}

export function startTerminalSession(options: StartTerminalSessionOptions): TerminalSession {
  const { containerRef, onReadOnlyInputAttempt, onStatusChange, props } = options;
  const taskId = props.taskId;
  const agentId = props.agentId;
  const initialFontSize = props.fontSize ?? 13;
  const browserMode = !isElectronRuntime();
  const runtimeClientId = getRuntimeClientId();

  const term = new Terminal({
    cursorBlink: true,
    fontSize: initialFontSize,
    fontFamily: getTerminalFontFamily(store.terminalFont),
    theme: getTerminalTheme(store.themePreset),
    allowProposedApi: true,
    scrollback: 3000,
  });

  const fitAddon = new FitAddon();
  let outputRaf: number | undefined;
  let outputQueue: Uint8Array[] = [];
  let outputQueuedBytes = 0;
  let outputQueueFirstReceiveTs = 0;
  let outputWriteInFlight = false;
  let outputWriteWatchdog: number | undefined;
  let watermark = 0;
  let flowPauseApplied = false;
  let flowPauseInFlight = false;
  let flowResumeInFlight = false;
  let flowRetryTimer: number | undefined;
  let spawnReady = false;
  let spawnFailed = false;
  let disposed = false;
  let processExited = false;
  let pendingExitPayload: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  } | null = null;
  let initialCommandSent = false;
  let inputBuffer = '';
  let pendingInput = '';
  let pendingInputQueuedAt = -1;
  let pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
  const inputQueue: QueuedInputChunk[] = [];
  let inFlightInputBatch: InFlightInputBatch | null = null;
  let inputLifecycleGeneration = 0;
  let inputFlushTimer: number | undefined;
  let inputSendInFlight = false;
  let resizeFlushTimer: number | undefined;
  let resizeSendInFlight = false;
  let resizeInFlightRequestId: string | null = null;
  let resizeLifecycleGeneration = 0;
  let readyFallbackTimer: number | undefined;
  let fitReady = false;
  let readyRequested = false;
  let pendingResize: { cols: number; rows: number } | null = null;
  let lastSentCols = -1;
  let lastSentRows = -1;
  let restoreInFlight = false;
  let restoringScrollback = false;
  let restorePauseApplied = false;
  let renderedOutputHistory = new Uint8Array(0);
  let renderedOutputHistoryTruncated = false;
  let browserTransportCleanup: (() => void) | undefined;
  const cleanupCallbacks: Array<() => void> = [];
  const inputLeaseSession = createTaskCommandLeaseSession(taskId, 'type in the terminal', {
    confirmTakeover: false,
  });
  const fitLifecycle = createTerminalFitLifecycle({
    fit: () => {
      fitAddon.fit();
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
      flushPendingResize();
      flushReadyState();
      if (outputQueue.length > 0 && !restoringScrollback) {
        scheduleOutputFlush();
      }
    },
  });

  function setStatus(status: TerminalViewStatus): void {
    onStatusChange?.(status);
  }

  function clearQueuedInputState(): void {
    inputQueue.length = 0;
    inFlightInputBatch = null;
    inputBuffer = '';
    pendingInput = '';
    pendingInputQueuedAt = -1;
    pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
  }

  function isCanceledBrowserAgentCommandError(error: unknown): boolean {
    return String(error).includes(BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE);
  }

  function isTaskControlledAgentError(error: unknown): boolean {
    return String(error).includes(TASK_CONTROLLED_AGENT_ERROR_MESSAGE);
  }

  function cancelInFlightInputBatch(): void {
    if (!inFlightInputBatch) {
      return;
    }

    cancelBrowserAgentCommandRequest(inFlightInputBatch.requestId);
    inFlightInputBatch = null;
    inputLifecycleGeneration += 1;
  }

  function cancelInFlightResizeRequest(): void {
    if (!resizeInFlightRequestId) {
      return;
    }

    cancelBrowserAgentCommandRequest(resizeInFlightRequestId);
    resizeInFlightRequestId = null;
    resizeLifecycleGeneration += 1;
  }

  function handleTaskControlLoss(): void {
    if (inputFlushTimer !== undefined) {
      clearTimeout(inputFlushTimer);
      inputFlushTimer = undefined;
    }
    cancelInFlightInputBatch();
    cancelInFlightResizeRequest();
    pendingResize = null;
    lastSentCols = -1;
    lastSentRows = -1;
    clearQueuedInputState();
    onReadOnlyInputAttempt?.();
  }

  function clearReadyFallback(): void {
    if (readyFallbackTimer === undefined) {
      return;
    }

    clearTimeout(readyFallbackTimer);
    readyFallbackTimer = undefined;
  }

  function flushReadyState(): void {
    if (disposed || spawnFailed || !readyRequested || !fitReady) {
      return;
    }

    readyRequested = false;
    clearReadyFallback();
    setStatus('ready');
  }

  function scheduleTerminalFitStabilization(): void {
    if (fitReady) {
      fitAddon.fit();
      requestAnimationFrame(() => {
        if (!disposed) {
          fitAddon.fit();
        }
      });
      return;
    }

    fitLifecycle.scheduleStabilize();
  }

  async function ensureTerminalFitReady(): Promise<boolean> {
    scheduleTerminalFitStabilization();
    const ready = await fitLifecycle.ensureReady();
    fitReady = ready;
    if (!fitReady) {
      return false;
    }

    flushPendingResize();
    flushReadyState();
    if (!restoringScrollback && outputQueue.length > 0) {
      scheduleOutputFlush();
    }
    return true;
  }

  function canFlushTerminalOutput(): boolean {
    return fitReady && !restoringScrollback;
  }

  function queuePendingOutput(chunk: Uint8Array, receiveTs: number): void {
    outputQueue.push(chunk);
    outputQueuedBytes += chunk.length;
    if (receiveTs > 0 && !outputQueueFirstReceiveTs) {
      outputQueueFirstReceiveTs = receiveTs;
    }

    if (!canFlushTerminalOutput()) {
      return;
    }

    if (outputQueuedBytes >= 64 * 1024) {
      flushOutputQueue();
      return;
    }

    scheduleOutputFlush();
  }

  function writeOutputChunk(chunk: Uint8Array, receiveTs: number): void {
    outputWriteInFlight = true;
    let writeCompleted = false;
    const statusPayload =
      chunk.length > STATUS_ANALYSIS_MAX_BYTES
        ? chunk.subarray(chunk.length - STATUS_ANALYSIS_MAX_BYTES)
        : chunk;
    const finishWrite = (): void => {
      if (writeCompleted) return;
      writeCompleted = true;
      clearOutputWriteWatchdog();
      outputWriteInFlight = false;
      watermark = Math.max(watermark - chunk.length, 0);
      appendRenderedOutputHistory(chunk);
      recordOutputWritten(receiveTs);
      if (chunk.length > 0) {
        markTerminalReady();
      }
      if (watermark < FLOW_LOW && flowPauseApplied) {
        requestPtyResume();
      }
      if (disposed) return;
      props.onData?.(statusPayload);
      if (outputQueue.length > 0) {
        scheduleOutputFlush();
      } else if (pendingExitPayload) {
        const exit = pendingExitPayload;
        pendingExitPayload = null;
        emitExit(exit);
      }
    };
    outputWriteWatchdog = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
    term.write(chunk, finishWrite);
  }

  function appendRenderedOutputHistory(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }

    if (renderedOutputHistory.length === 0) {
      if (chunk.length <= RESTORE_HISTORY_MAX_BYTES) {
        renderedOutputHistory = chunk.slice();
        return;
      }

      renderedOutputHistory = chunk.slice(chunk.length - RESTORE_HISTORY_MAX_BYTES);
      renderedOutputHistoryTruncated = true;
      return;
    }

    const combinedLength = renderedOutputHistory.length + chunk.length;
    if (combinedLength <= RESTORE_HISTORY_MAX_BYTES) {
      const nextHistory = new Uint8Array(combinedLength);
      nextHistory.set(renderedOutputHistory, 0);
      nextHistory.set(chunk, renderedOutputHistory.length);
      renderedOutputHistory = nextHistory;
      return;
    }

    const nextHistory = new Uint8Array(RESTORE_HISTORY_MAX_BYTES);
    const carryLength = Math.max(0, RESTORE_HISTORY_MAX_BYTES - chunk.length);
    if (carryLength > 0) {
      nextHistory.set(
        renderedOutputHistory.subarray(renderedOutputHistory.length - carryLength),
        0,
      );
      nextHistory.set(chunk, carryLength);
    } else {
      nextHistory.set(chunk.subarray(chunk.length - RESTORE_HISTORY_MAX_BYTES), 0);
    }
    renderedOutputHistory = nextHistory;
    renderedOutputHistoryTruncated = true;
  }

  function setRenderedOutputHistory(history: Uint8Array): void {
    if (history.length <= RESTORE_HISTORY_MAX_BYTES) {
      renderedOutputHistory = history.slice();
      renderedOutputHistoryTruncated = false;
      return;
    }

    renderedOutputHistory = history.slice(history.length - RESTORE_HISTORY_MAX_BYTES);
    renderedOutputHistoryTruncated = true;
  }

  function canApplyIncrementalRestore(scrollback: Uint8Array): boolean {
    if (renderedOutputHistoryTruncated || renderedOutputHistory.length === 0) {
      return false;
    }

    if (scrollback.length < renderedOutputHistory.length) {
      return false;
    }

    for (let index = 0; index < renderedOutputHistory.length; index += 1) {
      if (scrollback[index] !== renderedOutputHistory[index]) {
        return false;
      }
    }

    return true;
  }

  async function restoreTerminalScrollbackData(scrollback: Uint8Array): Promise<void> {
    term.reset();
    scheduleTerminalFitStabilization();
    await new Promise<void>((resolve) => {
      term.write(scrollback, resolve);
    });
    setRenderedOutputHistory(scrollback);
  }

  async function appendRestoreScrollbackDelta(scrollback: Uint8Array): Promise<void> {
    const delta = scrollback.subarray(renderedOutputHistory.length);
    if (delta.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      term.write(delta, resolve);
    });
    setRenderedOutputHistory(scrollback);
  }

  function markTerminalReady(): void {
    if (disposed || spawnFailed) {
      return;
    }

    readyRequested = true;
    flushReadyState();
    if (readyRequested) {
      scheduleTerminalFitStabilization();
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

  const FLOW_HIGH = 256 * 1024;
  const FLOW_LOW = 32 * 1024;

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
    for (let index = 0; index <= buffer.length - 1; index++) {
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

  const clearSelectionAfterCopy = (): void => {
    queueMicrotask(() => term.clearSelection());
  };

  async function copySelectionToClipboard(): Promise<void> {
    const selection = term.getSelection();
    if (!selection) return;

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
      if (text) {
        term.paste(text);
      }
    } catch (error) {
      console.warn('[terminal] Failed to read clipboard text', error);
      showNotification('Paste failed. Use your browser paste shortcut or the context menu.');
    }
  }

  if (browserMode) {
    containerRef.addEventListener('copy', clearSelectionAfterCopy);
  }

  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== 'keydown') return true;
    if (matchesGlobalShortcut(event)) return false;

    const shortcutAction = getTerminalShortcutAction(event, {
      browserMode,
      hasSelection: term.hasSelection(),
      isMac,
    });
    if (shortcutAction.preventDefault) {
      event.preventDefault();
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

  registerTerminal(agentId, containerRef, fitAddon, term);
  scheduleTerminalFitStabilization();

  const handleVisibilityResume = (): void => {
    if (document.visibilityState === 'hidden') {
      return;
    }

    scheduleTerminalFitStabilization();
  };

  document.addEventListener('visibilitychange', handleVisibilityResume);
  window.addEventListener('pageshow', handleVisibilityResume);
  cleanupCallbacks.push(() => {
    document.removeEventListener('visibilitychange', handleVisibilityResume);
    window.removeEventListener('pageshow', handleVisibilityResume);
  });

  if (props.autoFocus) {
    term.focus();
  }

  function emitExit(payload: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  }): void {
    processExited = true;
    pendingInput = '';
    pendingInputQueuedAt = -1;
    inputQueue.length = 0;
    term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
    props.onExit?.(payload);
  }

  function clearOutputWriteWatchdog(): void {
    if (outputWriteWatchdog === undefined) return;
    clearTimeout(outputWriteWatchdog);
    outputWriteWatchdog = undefined;
  }

  function scheduleFlowRetry(): void {
    if (flowRetryTimer !== undefined || disposed) return;
    flowRetryTimer = window.setTimeout(() => {
      flowRetryTimer = undefined;
      if (watermark > FLOW_HIGH && !flowPauseApplied) {
        requestPtyPause();
      } else if (watermark < FLOW_LOW && flowPauseApplied) {
        requestPtyResume();
      }
    }, INPUT_RETRY_DELAY_MS);
  }

  function requestPtyPause(): void {
    if (disposed || flowPauseApplied || flowPauseInFlight) return;
    flowPauseInFlight = true;
    recordFlowEvent('pause');
    invoke(IPC.PauseAgent, { agentId, reason: 'flow-control', channelId: onOutput.id })
      .then(() => {
        flowPauseApplied = true;
        if (watermark < FLOW_LOW) {
          requestPtyResume();
        }
      })
      .catch(() => {
        scheduleFlowRetry();
      })
      .finally(() => {
        flowPauseInFlight = false;
      });
  }

  function requestPtyResume(): void {
    if (disposed || !flowPauseApplied || flowResumeInFlight) return;
    flowResumeInFlight = true;
    recordFlowEvent('resume');
    invoke(IPC.ResumeAgent, { agentId, reason: 'flow-control', channelId: onOutput.id })
      .then(() => {
        flowPauseApplied = false;
        if (watermark > FLOW_HIGH) {
          requestPtyPause();
        }
      })
      .catch(() => {
        scheduleFlowRetry();
      })
      .finally(() => {
        flowResumeInFlight = false;
      });
  }

  function flushOutputQueue(): void {
    if (!canFlushTerminalOutput() || outputWriteInFlight || outputQueue.length === 0) return;

    const chunks = outputQueue;
    const totalBytes = outputQueuedBytes;
    const batchReceiveTs = outputQueueFirstReceiveTs;
    outputQueue = [];
    outputQueuedBytes = 0;
    outputQueueFirstReceiveTs = 0;

    let payload: Uint8Array;
    if (chunks.length === 1) {
      payload = chunks[0];
    } else {
      payload = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.length;
      }
    }
    writeOutputChunk(payload, batchReceiveTs);
  }

  function scheduleOutputFlush(): void {
    if (outputRaf !== undefined) return;
    outputRaf = requestAnimationFrame(() => {
      outputRaf = undefined;
      flushOutputQueue();
    });
  }

  function enqueueOutput(chunk: Uint8Array, receiveTs = 0): void {
    watermark += chunk.length;
    if (watermark > FLOW_HIGH && !flowPauseApplied) {
      requestPtyPause();
    }
    if (chunk.length > 0) {
      touchWebglAddon(agentId);
    }

    if (
      canFlushTerminalOutput() &&
      chunk.length < 1024 &&
      !outputWriteInFlight &&
      outputQueue.length === 0
    ) {
      writeOutputChunk(chunk, receiveTs);
      return;
    }

    queuePendingOutput(chunk, receiveTs);
  }

  const onOutput = new Channel<PtyOutput>();
  onOutput.onmessage = (message) => {
    if (message.type === 'Data') {
      const receiveTs = recordOutputReceived();
      const decoded =
        typeof message.data === 'string' ? base64ToUint8Array(message.data) : message.data;
      if (hasPendingProbes()) {
        detectProbeInOutput(PROBE_TEXT_DECODER.decode(decoded));
      }
      enqueueOutput(decoded, receiveTs);
      if (!initialCommandSent && props.initialCommand) {
        initialCommandSent = true;
        setTimeout(() => enqueueInput(props.initialCommand + '\r'), INITIAL_COMMAND_DELAY_MS);
      }
      return;
    }

    if (message.type === 'Exit') {
      pendingExitPayload = message.data;
      flushOutputQueue();
      if (
        canFlushTerminalOutput() &&
        !outputWriteInFlight &&
        outputQueue.length === 0 &&
        pendingExitPayload
      ) {
        const exit = pendingExitPayload;
        pendingExitPayload = null;
        emitExit(exit);
      }
      return;
    }

    if (message.type === 'ResetRequired') {
      void restoreScrollback('reconnect');
    }
  };

  function scheduleInputFlush(delay = 8): void {
    if (disposed) return;
    if (inputFlushTimer !== undefined) return;
    inputFlushTimer = window.setTimeout(() => {
      inputFlushTimer = undefined;
      flushPendingInput();
      drainInputQueue();
    }, delay);
  }

  function retryInputDrain(): void {
    scheduleInputFlush(INPUT_RETRY_DELAY_MS);
  }

  function getOrCreateInFlightInputBatch(): InFlightInputBatch | null {
    if (inFlightInputBatch) {
      return inFlightInputBatch;
    }

    const nextBatch = takeQueuedTerminalInputBatch(inputQueue);
    if (!nextBatch) {
      return null;
    }

    inFlightInputBatch = {
      ...nextBatch,
      queuedAt: inputQueue[0]?.queuedAt ?? 0,
      requestId: crypto.randomUUID(),
    };
    return inFlightInputBatch;
  }

  function ensureInputLease(): Promise<boolean> {
    return inputLeaseSession.touch() ? Promise.resolve(true) : inputLeaseSession.acquire();
  }

  function drainInputQueue(): void {
    if (disposed || spawnFailed || processExited || inputSendInFlight || inputQueue.length === 0) {
      return;
    }
    if (!spawnReady) {
      retryInputDrain();
      return;
    }

    const queuedBatch = getOrCreateInFlightInputBatch();
    if (!queuedBatch) {
      inputQueue.shift();
      drainInputQueue();
      return;
    }

    const inputGeneration = inputLifecycleGeneration;
    inputSendInFlight = true;
    ensureInputLease()
      .then((acquired) => {
        if (!acquired) {
          onReadOnlyInputAttempt?.();
          clearQueuedInputState();
          return false;
        }

        return sendQueuedInputBatch(queuedBatch.batch, queuedBatch.queuedAt, queuedBatch.requestId);
      })
      .then((sent) => {
        if (
          inputGeneration !== inputLifecycleGeneration ||
          inFlightInputBatch?.requestId !== queuedBatch.requestId
        ) {
          return;
        }

        if (!sent) {
          retryInputDrain();
          return;
        }

        inFlightInputBatch = null;
        inputQueue.splice(0, queuedBatch.count);
      })
      .catch((error) => {
        if (
          inputGeneration !== inputLifecycleGeneration ||
          isCanceledBrowserAgentCommandError(error)
        ) {
          return;
        }

        if (isTaskControlledAgentError(error)) {
          inFlightInputBatch = null;
          handleTaskControlLoss();
          return;
        }

        if (!disposed && !spawnFailed && !processExited) {
          retryInputDrain();
        }
      })
      .finally(() => {
        inputSendInFlight = false;
        if (!disposed && !processExited && inputQueue.length > 0) {
          if (spawnReady) {
            drainInputQueue();
          } else {
            retryInputDrain();
          }
        }
      });
  }

  function sendQueuedInputBatch(
    batch: string,
    queuedAt: number,
    requestId: string,
  ): Promise<boolean> {
    return invoke(IPC.WriteToAgent, {
      agentId,
      controllerId: runtimeClientId,
      data: batch,
      requestId,
      taskId,
    }).then(() => {
      recordInputSent(queuedAt);
      return true;
    });
  }

  function flushPendingInput(): void {
    if (inputFlushTimer !== undefined) {
      clearTimeout(inputFlushTimer);
      inputFlushTimer = undefined;
    }
    if (!pendingInput) return;
    const queuedAt = recordInputBuffered(pendingInputQueuedAt);
    inputQueue.push(
      ...splitTerminalInputChunks(pendingInput).map((chunk) => ({
        ...chunk,
        queuedAt,
      })),
    );
    pendingInput = '';
    pendingInputQueuedAt = -1;
    pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
  }

  function enqueueInput(data: string): void {
    if (processExited) {
      return;
    }
    const plan = getTerminalInputBatchPlan(data);
    const wasIdle = pendingInput.length === 0 && inputQueue.length === 0 && !inputSendInFlight;
    if (pendingInputQueuedAt < 0) {
      pendingInputQueuedAt = recordInputQueued();
    }
    pendingInput += data;
    pendingInputCharLimit = mergePendingInputCharLimit(pendingInputCharLimit, data);
    if (
      plan.flushImmediately ||
      pendingInput.length >= pendingInputCharLimit ||
      (plan.preferImmediateFlushWhenIdle && wasIdle)
    ) {
      flushPendingInput();
      drainInputQueue();
      return;
    }
    scheduleInputFlush(plan.flushDelayMs);
  }

  term.onData((data) => {
    if (props.onPromptDetected) {
      for (const char of data) {
        if (char === '\r') {
          const trimmed = inputBuffer.trim();
          if (trimmed) {
            props.onPromptDetected(trimmed);
          }
          inputBuffer = '';
        } else if (char === '\x7f') {
          inputBuffer = inputBuffer.slice(0, -1);
        } else if (char === '\x03' || char === '\x15') {
          inputBuffer = '';
        } else if (char === '\x1b') {
          break;
        } else if (char >= ' ') {
          inputBuffer += char;
        }
      }
    }
    enqueueInput(data);
  });

  function scheduleResizeFlush(delayMs = RESIZE_FLUSH_DELAY_MS): void {
    if (resizeFlushTimer !== undefined) {
      return;
    }

    resizeFlushTimer = window.setTimeout(() => {
      resizeFlushTimer = undefined;
      flushPendingResize();
    }, delayMs);
  }

  function flushPendingResize(): void {
    if (!pendingResize || resizeSendInFlight) return;
    if (!spawnReady && !spawnFailed && !disposed) {
      scheduleResizeFlush();
      return;
    }

    const { cols, rows } = pendingResize;
    const controller = store.taskCommandControllers[taskId];
    if (controller && controller.controllerId !== runtimeClientId) {
      return;
    }

    pendingResize = null;
    if (cols === lastSentCols && rows === lastSentRows) return;
    resizeSendInFlight = true;
    const requestId = crypto.randomUUID();
    const resizeGeneration = resizeLifecycleGeneration;
    resizeInFlightRequestId = requestId;
    void invoke(IPC.ResizeAgent, {
      agentId,
      cols,
      controllerId: runtimeClientId,
      requestId,
      rows,
      taskId,
    })
      .then(() => {
        if (
          resizeGeneration !== resizeLifecycleGeneration ||
          resizeInFlightRequestId !== requestId
        ) {
          return;
        }

        lastSentCols = cols;
        lastSentRows = rows;
      })
      .catch((error) => {
        if (
          resizeGeneration !== resizeLifecycleGeneration ||
          isCanceledBrowserAgentCommandError(error)
        ) {
          return;
        }

        if (isTaskControlledAgentError(error)) {
          handleTaskControlLoss();
          return;
        }

        pendingResize = pendingResize ?? { cols, rows };
        if (!disposed && !spawnFailed) {
          scheduleResizeFlush();
        }
      })
      .finally(() => {
        if (resizeInFlightRequestId === requestId) {
          resizeInFlightRequestId = null;
        }
        resizeSendInFlight = false;
        if (!disposed && pendingResize) {
          flushPendingResize();
        }
      });
  }

  term.onResize(({ cols, rows }) => {
    pendingResize = { cols, rows };
    scheduleResizeFlush();
  });

  cleanupCallbacks.push(
    subscribeTaskCommandControllerChanges((snapshot) => {
      if (snapshot.taskId !== taskId) {
        return;
      }

      if (snapshot.controllerId !== runtimeClientId) {
        handleTaskControlLoss();
        return;
      }

      if (term.cols <= 0 || term.rows <= 0) {
        return;
      }

      pendingResize = {
        cols: term.cols,
        rows: term.rows,
      };
      flushPendingResize();
    }),
  );

  async function restoreScrollback(
    reason: 'renderer-loss' | 'reconnect' = 'renderer-loss',
  ): Promise<void> {
    if (disposed || restoreInFlight) return;
    restoreInFlight = true;
    restoringScrollback = true;
    setStatus('restoring');
    try {
      if (reason === 'renderer-loss') {
        await ensureTerminalFitReady();
        term.refresh(0, Math.max(term.rows - 1, 0));
        touchWebglAddon(agentId);
        markTerminalReady();
        return;
      }

      await ensureTerminalFitReady();
      if (outputRaf !== undefined) {
        cancelAnimationFrame(outputRaf);
        outputRaf = undefined;
      }

      while ((outputWriteInFlight || flowPauseInFlight || flowResumeInFlight) && !disposed) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      if (disposed) return;

      let scrollback: string | null = null;
      if (reason === 'reconnect') {
        scrollback = (await requestScrollbackRestore(agentId)).scrollback;
      } else {
        await invoke(IPC.PauseAgent, { agentId, reason: 'restore', channelId: onOutput.id });
        restorePauseApplied = true;
        scrollback = await invoke(IPC.GetAgentScrollback, { agentId });
      }
      if (disposed || !scrollback) return;
      const scrollbackBytes = base64ToUint8Array(scrollback);

      if (reason === 'reconnect') {
        const droppedBytes = outputQueuedBytes;
        outputQueue = [];
        outputQueuedBytes = 0;
        watermark = Math.max(watermark - droppedBytes, 0);
        if (watermark < FLOW_LOW && flowPauseApplied) {
          requestPtyResume();
        }
      }
      outputQueueFirstReceiveTs = 0;

      if (canApplyIncrementalRestore(scrollbackBytes)) {
        await appendRestoreScrollbackDelta(scrollbackBytes);
      } else {
        await restoreTerminalScrollbackData(scrollbackBytes);
      }
      await ensureTerminalFitReady();
      term.scrollToBottom();
      touchWebglAddon(agentId);
      markTerminalReady();
    } catch (error) {
      console.warn('[terminal] Failed to restore scrollback', error);
    } finally {
      if (restorePauseApplied) {
        try {
          await invoke(IPC.ResumeAgent, { agentId, reason: 'restore' });
        } catch (error) {
          console.warn('[terminal] Failed to resume after scrollback restore', error);
        } finally {
          restorePauseApplied = false;
        }
      }

      restoringScrollback = false;
      restoreInFlight = false;
      if (outputQueue.length > 0) {
        flushOutputQueue();
      }
      if (pendingExitPayload && !outputWriteInFlight && outputQueue.length === 0) {
        const exit = pendingExitPayload;
        pendingExitPayload = null;
        emitExit(exit);
      }
      if (!disposed && !spawnFailed && !restoringScrollback) {
        markTerminalReady();
      }
    }
  }

  acquireWebglAddon(agentId, term, () => restoreScrollback('renderer-loss'));

  if (!isElectronRuntime()) {
    let hasConnected = false;
    let needsRestore = false;
    cleanupCallbacks.push(
      listenServerMessage('agent-error', (message) => {
        if (message.agentId !== agentId || !isTaskControlledAgentError(message.message)) {
          return;
        }

        handleTaskControlLoss();
      }),
    );
    browserTransportCleanup = onBrowserTransportEvent((event) => {
      if (event.kind !== 'connection') return;
      if (event.state === 'connected') {
        if (needsRestore && spawnReady && !disposed) {
          needsRestore = false;
          void restoreScrollback('reconnect');
        }
        hasConnected = true;
        return;
      }
      if (hasConnected && (event.state === 'disconnected' || event.state === 'reconnecting')) {
        needsRestore = true;
      }
    });
  }

  void (async () => {
    try {
      await onOutput.ready;
      if (disposed) return;
      setStatus('attaching');
      await ensureTerminalFitReady();
      await invoke(IPC.SpawnAgent, {
        taskId,
        agentId,
        command: props.command,
        args: props.args,
        adapter: props.adapter,
        controllerId: runtimeClientId,
        cwd: props.cwd,
        env: props.env ?? {},
        cols: term.cols,
        rows: term.rows,
        isShell: props.isShell,
        onOutput,
      });
      spawnReady = true;
      await ensureTerminalFitReady();
      scheduleReadyFallback();
      flushPendingResize();
      flushPendingInput();
      drainInputQueue();
    } catch (error) {
      if (disposed) return;
      spawnFailed = true;
      setStatus('error');
      // eslint-disable-next-line no-control-regex -- intentionally stripping control characters from terminal error output
      const safeError = String(error).replace(/[\x00-\x1f\x7f]/g, '');
      term.write(`\x1b[31mFailed to spawn: ${safeError}\x1b[0m\r\n`);
      props.onExit?.({
        exit_code: null,
        signal: 'spawn_failed',
        last_output: [`Failed to spawn: ${safeError}`],
      });
    }
  })();

  return {
    fitAddon,
    async requestInputTakeover(): Promise<boolean> {
      const acquired = await inputLeaseSession.takeOver();
      if (acquired) {
        flushPendingResize();
      }
      return acquired;
    },
    term,
    cleanup(): void {
      flushPendingInput();
      disposed = true;
      cancelInFlightInputBatch();
      cancelInFlightResizeRequest();
      flushPendingResize();
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (resizeFlushTimer !== undefined) clearTimeout(resizeFlushTimer);
      clearReadyFallback();
      if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
      if (flowRetryTimer !== undefined) clearTimeout(flowRetryTimer);
      clearOutputWriteWatchdog();
      if (flowPauseApplied || flowResumeInFlight || flowPauseInFlight) {
        fireAndForget(IPC.ResumeAgent, {
          agentId,
          reason: 'flow-control',
          channelId: onOutput.id,
        });
      }
      fireAndForget(IPC.DetachAgentOutput, { agentId, channelId: onOutput.id });
      onOutput.cleanup?.();
      browserTransportCleanup?.();
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
      fitLifecycle.cleanup();
      releaseWebglAddon(agentId);
      if (browserMode) {
        containerRef.removeEventListener('copy', clearSelectionAfterCopy);
      }
      inputLeaseSession.cleanup();
      unregisterTerminal(agentId);
      term.dispose();
    },
  };
}
