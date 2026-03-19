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
  sendTerminalInput,
  sendTerminalInputTraceUpdate,
} from '../../lib/ipc';
import {
  detectProbeInOutput,
  getTerminalTraceTimestampMs,
  hasTerminalTraceClockAlignment,
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
import {
  requestReconnectTerminalRecovery,
  requestTerminalRecovery,
} from '../../lib/scrollbackRestore';
import { matchesGlobalShortcut } from '../../lib/shortcuts';
import { getTerminalTheme } from '../../lib/theme';
import { acquireWebglAddon, releaseWebglAddon } from '../../lib/webglPool';
import { isMac } from '../../lib/platform';
import { getRuntimeClientId } from '../../lib/runtime-client-id';
import { stripAnsi } from '../../lib/prompt-detection';
import { registerTerminalOutputCandidate } from '../../app/terminal-output-scheduler';
import { createTaskCommandLeaseSession } from '../../app/task-command-lease';
import { showNotification } from '../../store/notification';
import { store } from '../../store/store';
import {
  getTaskCommandController,
  subscribeTaskCommandControllerChanges,
} from '../../store/task-command-controllers';
import type { TerminalInputTraceKind } from '../../domain/terminal-input-tracing';
import type { PtyOutput, TerminalRecoveryBatchEntry } from '../../ipc/types';
import type { TerminalViewProps, TerminalViewStatus } from './types';
import {
  getTerminalStatusFlushDelayMs,
  type TerminalOutputPriority,
} from '../../lib/terminal-output-priority';
import {
  DEFAULT_MAX_PENDING_CHARS,
  getTerminalInputBatchPlan,
  hasImmediateFlushTerminalInput,
  mergePendingInputCharLimit,
  splitTerminalInputChunks,
  takeQueuedTerminalInputBatch,
} from '../../lib/terminal-input-batching';

const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

const PROBE_TEXT_DECODER = new TextDecoder();
const TRACE_TEXT_DECODER = new TextDecoder();
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;
const INPUT_RETRY_DELAY_MS = 50;
const INITIAL_COMMAND_DELAY_MS = 50;
const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;
const OUTPUT_DIRECT_WRITE_MAX_BYTES = 1024;
const INTERACTIVE_ECHO_IMMEDIATE_DRAIN_MAX_BYTES = 8 * 1024;
const INTERACTIVE_ECHO_FAST_PATH_WINDOW_MS = 180;
const RESIZE_FLUSH_DELAY_MS = 33;
const RESTORE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const RESTORE_CHUNK_BYTES_BY_PRIORITY = [96 * 1024, 64 * 1024, 32 * 1024, 16 * 1024] as const;
const TASK_CONTROLLED_AGENT_ERROR_MESSAGE = 'Task is controlled by another client';
const INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS = 4 * 1024;

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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    for (const value of chunk) {
      binary += String.fromCharCode(value);
    }
  }

  return btoa(binary);
}

interface TerminalSession {
  cleanup(): void;
  fitAddon: FitAddon;
  requestInputTakeover(): Promise<boolean>;
  term: Terminal;
  updateOutputPriority(): void;
}

interface QueuedInputChunk {
  bufferedAtMs: number;
  data: string;
  inputKind: TerminalInputTraceKind;
  queuedAt: number;
  startedAtMs: number;
}

interface InFlightInputBatch {
  batch: string;
  bufferedAtMs: number;
  count: number;
  inputKind: TerminalInputTraceKind;
  queuedAt: number;
  requestId: string;
  startedAtMs: number;
  traceEchoText: string | null;
}

interface StartTerminalSessionOptions {
  containerRef: HTMLDivElement;
  getOutputPriority: () => TerminalOutputPriority;
  onReadOnlyInputAttempt?: () => void;
  onStatusChange?: (status: TerminalViewStatus) => void;
  props: TerminalViewProps;
}

function classifyTerminalInputTraceKind(data: string): TerminalInputTraceKind {
  if (getTerminalInputBatchPlan(data).flushMode === 'bulk') {
    return 'paste';
  }

  if (data.length <= 1) {
    return hasImmediateFlushTerminalInput(data) ? 'control' : 'interactive';
  }

  return hasImmediateFlushTerminalInput(data) ? 'control' : 'burst';
}

function coalesceTerminalInputTraceKind(
  currentKind: TerminalInputTraceKind,
  nextKind: TerminalInputTraceKind,
  hadPendingInput: boolean,
): TerminalInputTraceKind {
  if (!hadPendingInput) {
    return nextKind;
  }

  if (currentKind === 'paste' || nextKind === 'paste') {
    return 'paste';
  }

  return 'burst';
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

function getTraceEchoText(data: string): string | null {
  const printableText = Array.from(data)
    .filter((char) => {
      const charCode = char.charCodeAt(0);
      return charCode >= 32 || char === '\t' || char === '\n' || char === '\r';
    })
    .join('')
    .replace(/\r/g, '');
  return printableText.length > 0 ? printableText : null;
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
  let outputQueue: Uint8Array[] = [];
  let outputQueuedBytes = 0;
  let outputQueueFirstReceiveTs = 0;
  let outputWriteInFlight = false;
  let outputWriteWatchdog: number | undefined;
  let backgroundStatusDispatchTimer: number | undefined;
  let pendingBackgroundStatusPayload: Uint8Array | null = null;
  let lastBackgroundStatusDispatchAt = 0;
  let outputRegistration: ReturnType<typeof registerTerminalOutputCandidate> | undefined;
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
  let pendingInputStartedAtMs = -1;
  let pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
  let pendingInputKind: TerminalInputTraceKind = 'interactive';
  const pendingKeyboardTraceStarts: number[] = [];
  let nextProgrammaticInputTrace: {
    inputKind: TerminalInputTraceKind;
    startedAtMs: number;
  } | null = null;
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
  let renderedOutputCursor = 0;
  let renderedOutputHistory = new Uint8Array(0);
  let recentInteractiveEchoDeadlineAt = 0;
  let pendingInputTraceOutputTail = '';
  const pendingInputTraceEchoes = new Map<
    string,
    {
      expectedText: string;
      outputReceivedAtMs: number | null;
    }
  >();
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
  let currentStatus: TerminalViewStatus = 'binding';

  function setStatus(status: TerminalViewStatus): void {
    currentStatus = status;
    onStatusChange?.(status);
  }

  function getOutputPriority(): TerminalOutputPriority {
    return options.getOutputPriority();
  }

  function shouldUseDirectOutputWrite(chunkLength: number): boolean {
    return getOutputPriority() === 'focused' && chunkLength < OUTPUT_DIRECT_WRITE_MAX_BYTES;
  }

  function hasRecentInteractiveEchoPriority(): boolean {
    return (
      getOutputPriority() === 'focused' && performance.now() <= recentInteractiveEchoDeadlineAt
    );
  }

  function armInteractiveEchoFastPath(batch: InFlightInputBatch): void {
    if (batch.inputKind === 'paste') {
      return;
    }

    recentInteractiveEchoDeadlineAt = performance.now() + INTERACTIVE_ECHO_FAST_PATH_WINDOW_MS;
  }

  function shouldDrainQueuedInteractiveEchoImmediately(): boolean {
    if (!hasRecentInteractiveEchoPriority()) {
      return false;
    }

    return outputQueuedBytes > 0 && outputQueuedBytes <= INTERACTIVE_ECHO_IMMEDIATE_DRAIN_MAX_BYTES;
  }

  function clearBackgroundStatusDispatch(): void {
    if (backgroundStatusDispatchTimer === undefined) {
      return;
    }

    clearTimeout(backgroundStatusDispatchTimer);
    backgroundStatusDispatchTimer = undefined;
  }

  function dispatchStatusPayload(statusPayload: Uint8Array): void {
    if (statusPayload.length === 0) {
      return;
    }

    const delayMs = getTerminalStatusFlushDelayMs(getOutputPriority());
    if (delayMs <= 0) {
      clearBackgroundStatusDispatch();
      pendingBackgroundStatusPayload = null;
      lastBackgroundStatusDispatchAt = performance.now();
      props.onData?.(statusPayload);
      return;
    }

    pendingBackgroundStatusPayload = mergeStatusPayload(
      pendingBackgroundStatusPayload,
      statusPayload,
    );
    const now = performance.now();
    const elapsedMs = now - lastBackgroundStatusDispatchAt;
    if (elapsedMs >= delayMs) {
      lastBackgroundStatusDispatchAt = now;
      const nextPayload = pendingBackgroundStatusPayload;
      pendingBackgroundStatusPayload = null;
      if (nextPayload) {
        props.onData?.(nextPayload);
      }
      return;
    }

    if (backgroundStatusDispatchTimer !== undefined) {
      return;
    }

    backgroundStatusDispatchTimer = window.setTimeout(
      () => {
        backgroundStatusDispatchTimer = undefined;
        lastBackgroundStatusDispatchAt = performance.now();
        const nextPayload = pendingBackgroundStatusPayload;
        pendingBackgroundStatusPayload = null;
        if (nextPayload) {
          props.onData?.(nextPayload);
        }
      },
      Math.max(0, delayMs - elapsedMs),
    );
  }

  function mergeStatusPayload(
    previousPayload: Uint8Array | null,
    nextPayload: Uint8Array,
  ): Uint8Array {
    if (!previousPayload || previousPayload.length === 0) {
      return nextPayload;
    }

    if (nextPayload.length >= STATUS_ANALYSIS_MAX_BYTES) {
      return nextPayload.subarray(nextPayload.length - STATUS_ANALYSIS_MAX_BYTES);
    }

    const previousBytesToKeep = Math.min(
      previousPayload.length,
      STATUS_ANALYSIS_MAX_BYTES - nextPayload.length,
    );
    const mergedPayload = new Uint8Array(previousBytesToKeep + nextPayload.length);
    if (previousBytesToKeep > 0) {
      mergedPayload.set(previousPayload.subarray(previousPayload.length - previousBytesToKeep), 0);
    }
    mergedPayload.set(nextPayload, previousBytesToKeep);
    return mergedPayload;
  }

  function clearQueuedInputState(): void {
    inputQueue.length = 0;
    inFlightInputBatch = null;
    inputBuffer = '';
    pendingInput = '';
    pendingInputQueuedAt = -1;
    pendingInputStartedAtMs = -1;
    pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
    pendingInputKind = 'interactive';
    pendingKeyboardTraceStarts.length = 0;
    nextProgrammaticInputTrace = null;
    pendingInputTraceEchoes.clear();
    pendingInputTraceOutputTail = '';
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
    pendingInputTraceEchoes.delete(inFlightInputBatch.requestId);
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
    if (
      disposed ||
      spawnFailed ||
      !readyRequested ||
      !fitReady ||
      restoreInFlight ||
      restoringScrollback
    ) {
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
      renderedOutputCursor += chunk.length;
      appendRenderedOutputHistory(chunk);
      recordOutputWritten(receiveTs);
      finalizePendingInputTraceEchoes(getTerminalTraceTimestampMs());
      if (chunk.length > 0) {
        markTerminalReady();
      }
      if (watermark < FLOW_LOW && flowPauseApplied) {
        requestPtyResume();
      }
      if (disposed) return;
      dispatchStatusPayload(statusPayload);
      if (outputQueue.length > 0) {
        if (shouldDrainQueuedInteractiveEchoImmediately()) {
          flushOutputQueueSlice(INTERACTIVE_ECHO_IMMEDIATE_DRAIN_MAX_BYTES);
          return;
        }

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
  }

  function setRenderedOutputHistory(history: Uint8Array): void {
    if (history.length <= RESTORE_HISTORY_MAX_BYTES) {
      renderedOutputHistory = history.slice();
      return;
    }

    renderedOutputHistory = history.slice(history.length - RESTORE_HISTORY_MAX_BYTES);
  }

  function getRenderedHistoryForRecoveryRequest(): string | null {
    if (renderedOutputHistory.length === 0) {
      return null;
    }

    return uint8ArrayToBase64(renderedOutputHistory);
  }

  function getTerminalRecoveryRequestState(): {
    outputCursor: number;
    renderedTail: string | null;
  } {
    return {
      outputCursor: renderedOutputCursor,
      renderedTail: getRenderedHistoryForRecoveryRequest(),
    };
  }

  function shouldUseHiddenRestoreYield(): boolean {
    if (getOutputPriority() === 'hidden') {
      return true;
    }

    return document.visibilityState === 'hidden';
  }

  async function waitForRestoreYield(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (shouldUseHiddenRestoreYield()) {
        window.setTimeout(resolve, 0);
        return;
      }

      requestAnimationFrame(() => resolve());
    });
  }

  async function writeTerminalRestoreChunk(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finishWrite = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        resolve();
      };
      const timeoutId = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
      term.write(chunk, finishWrite);
    });
  }

  async function writeTerminalPayloadChunked(
    payload: Uint8Array,
    chunkSize: number,
  ): Promise<void> {
    if (payload.length === 0) {
      return;
    }

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, Math.min(payload.length, offset + chunkSize));
      await writeTerminalRestoreChunk(chunk);
      if (offset + chunkSize < payload.length) {
        await waitForRestoreYield();
      }
    }
  }

  function getRestoreChunkSize(): number {
    switch (getOutputPriority()) {
      case 'focused':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[0];
      case 'active-visible':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[1];
      case 'visible-background':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[2];
      case 'hidden':
        return RESTORE_CHUNK_BYTES_BY_PRIORITY[3];
    }
  }

  async function restoreTerminalScrollbackData(scrollback: Uint8Array): Promise<void> {
    term.reset();
    scheduleTerminalFitStabilization();
    await writeTerminalPayloadChunked(scrollback, getRestoreChunkSize());
    setRenderedOutputHistory(scrollback);
  }

  function buildTerminalRecoveryHistory(overlapBytes: number, delta: Uint8Array): Uint8Array {
    const safeOverlapBytes = Math.min(Math.max(overlapBytes, 0), renderedOutputHistory.length);
    if (safeOverlapBytes === 0) {
      return delta.slice();
    }

    const preservedHistory = renderedOutputHistory.subarray(
      renderedOutputHistory.length - safeOverlapBytes,
    );
    const nextHistory = new Uint8Array(preservedHistory.length + delta.length);
    nextHistory.set(preservedHistory, 0);
    nextHistory.set(delta, preservedHistory.length);
    return nextHistory;
  }

  function shouldShowBlockingRestoreUI(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'snapshot' && currentStatus !== 'attaching';
  }

  function shouldScrollToBottomAfterRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'snapshot';
  }

  async function applyTerminalRecoveryEntry(entry: TerminalRecoveryBatchEntry): Promise<void> {
    switch (entry.recovery.kind) {
      case 'noop':
        renderedOutputCursor = entry.outputCursor;
        return;
      case 'delta': {
        const delta = base64ToUint8Array(entry.recovery.data);
        if (delta.length > 0) {
          await writeTerminalPayloadChunked(delta, getRestoreChunkSize());
        }
        if (entry.recovery.source === 'cursor') {
          appendRenderedOutputHistory(delta);
        } else {
          setRenderedOutputHistory(
            buildTerminalRecoveryHistory(entry.recovery.overlapBytes, delta),
          );
        }
        renderedOutputCursor = entry.outputCursor;
        return;
      }
      case 'snapshot': {
        const scrollback = entry.recovery.data
          ? base64ToUint8Array(entry.recovery.data)
          : new Uint8Array(0);
        await restoreTerminalScrollbackData(scrollback);
        renderedOutputCursor = entry.outputCursor;
        return;
      }
    }
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
        if (hasTerminalTraceClockAlignment()) {
          nextProgrammaticInputTrace = {
            inputKind: classifyTerminalInputTraceKind(text),
            startedAtMs: getTerminalTraceTimestampMs(),
          };
        }
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

    if (
      shortcutAction.kind === 'allow' &&
      hasTerminalTraceClockAlignment() &&
      shouldTrackKeyboardEvent(event)
    ) {
      pendingKeyboardTraceStarts.push(getTerminalTraceTimestampMs());
      while (pendingKeyboardTraceStarts.length > 64) {
        pendingKeyboardTraceStarts.shift();
      }
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
  outputRegistration = registerTerminalOutputCandidate(
    `${taskId}:${agentId}`,
    () => getOutputPriority(),
    () => (restoringScrollback ? 0 : outputQueuedBytes),
    (budgetBytes) => flushOutputQueueSlice(budgetBytes),
  );

  const handleVisibilityResume = (): void => {
    if (document.visibilityState === 'hidden') {
      return;
    }

    scheduleTerminalFitStabilization();
  };

  document.addEventListener('visibilitychange', handleVisibilityResume);
  window.addEventListener('pageshow', handleVisibilityResume);
  cleanupCallbacks.push(() => {
    clearBackgroundStatusDispatch();
    pendingBackgroundStatusPayload = null;
    outputRegistration?.unregister();
    outputRegistration = undefined;
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

  function sendFlowControlResumeRequest(allowRecoveryWhenIdle = false): void {
    if (disposed || flowResumeInFlight) return;
    if (!allowRecoveryWhenIdle && !flowPauseApplied) return;
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

  function requestPtyResume(): void {
    sendFlowControlResumeRequest();
  }

  function recoverFlowControlIfIdle(): void {
    if (disposed || outputQueuedBytes > 0 || watermark >= FLOW_LOW) {
      return;
    }

    sendFlowControlResumeRequest(true);
  }

  function takeOutputQueueSlice(
    maxBytes: number,
  ): { payload: Uint8Array; receiveTs: number } | null {
    if (outputQueue.length === 0 || maxBytes <= 0) {
      return null;
    }

    const receiveTs = outputQueueFirstReceiveTs;
    if (outputQueue.length === 1) {
      const onlyChunk = outputQueue[0];
      if (!onlyChunk) {
        return null;
      }

      if (onlyChunk.length <= maxBytes) {
        outputQueue = [];
        outputQueuedBytes = 0;
        outputQueueFirstReceiveTs = 0;
        return {
          payload: onlyChunk,
          receiveTs,
        };
      }

      outputQueue[0] = onlyChunk.subarray(maxBytes);
      outputQueuedBytes -= maxBytes;
      return {
        payload: onlyChunk.subarray(0, maxBytes),
        receiveTs,
      };
    }

    const totalBytes = Math.min(outputQueuedBytes, maxBytes);
    const payload = new Uint8Array(totalBytes);
    let payloadOffset = 0;

    while (payloadOffset < totalBytes && outputQueue.length > 0) {
      const nextChunk = outputQueue[0];
      if (!nextChunk) {
        outputQueue.shift();
        continue;
      }

      const writableBytes = Math.min(nextChunk.length, totalBytes - payloadOffset);
      payload.set(nextChunk.subarray(0, writableBytes), payloadOffset);
      payloadOffset += writableBytes;

      if (writableBytes === nextChunk.length) {
        outputQueue.shift();
      } else {
        outputQueue[0] = nextChunk.subarray(writableBytes);
      }
    }

    outputQueuedBytes = Math.max(0, outputQueuedBytes - payloadOffset);
    outputQueueFirstReceiveTs = outputQueue.length > 0 ? receiveTs : 0;
    return {
      payload: payloadOffset === payload.length ? payload : payload.subarray(0, payloadOffset),
      receiveTs,
    };
  }

  function flushOutputQueueSlice(maxBytes: number): number {
    if (!canFlushTerminalOutput() || outputWriteInFlight || outputQueue.length === 0) {
      return 0;
    }

    const batch = takeOutputQueueSlice(maxBytes);
    if (!batch) {
      return 0;
    }

    writeOutputChunk(batch.payload, batch.receiveTs);
    return batch.payload.length;
  }

  function flushOutputQueue(): void {
    flushOutputQueueSlice(Number.POSITIVE_INFINITY);
  }

  function scheduleOutputFlush(): void {
    outputRegistration?.requestDrain();
  }

  function enqueueOutput(chunk: Uint8Array, receiveTs = 0): void {
    watermark += chunk.length;
    if (watermark > FLOW_HIGH && !flowPauseApplied) {
      requestPtyPause();
    }

    if (
      canFlushTerminalOutput() &&
      shouldUseDirectOutputWrite(chunk.length) &&
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
      const outputReceivedAtMs = getTerminalTraceTimestampMs();
      const decoded =
        typeof message.data === 'string' ? base64ToUint8Array(message.data) : message.data;
      if (hasPendingProbes()) {
        detectProbeInOutput(PROBE_TEXT_DECODER.decode(decoded));
      }
      detectPendingInputTraceEcho(decoded, outputReceivedAtMs);
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

    if (message.type === 'RecoveryRequired') {
      void restoreTerminalOutput(message.reason);
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

  function takeInputTraceContext(data: string): {
    inputKind: TerminalInputTraceKind;
    startedAtMs: number;
  } {
    if (nextProgrammaticInputTrace) {
      const traceContext = nextProgrammaticInputTrace;
      nextProgrammaticInputTrace = null;
      return traceContext;
    }

    const startedAtMs = hasTerminalTraceClockAlignment()
      ? (pendingKeyboardTraceStarts.shift() ?? getTerminalTraceTimestampMs())
      : -1;
    return {
      inputKind: classifyTerminalInputTraceKind(data),
      startedAtMs,
    };
  }

  function summarizeQueuedInputTrace(queueEntries: readonly QueuedInputChunk[]): {
    bufferedAtMs: number;
    inputKind: TerminalInputTraceKind;
    startedAtMs: number;
  } {
    let startedAtMs = queueEntries[0]?.startedAtMs ?? getTerminalTraceTimestampMs();
    let bufferedAtMs = queueEntries[0]?.bufferedAtMs ?? startedAtMs;
    let inputKind = queueEntries[0]?.inputKind ?? 'interactive';

    for (const [index, entry] of queueEntries.entries()) {
      startedAtMs =
        startedAtMs < 0 || entry.startedAtMs < 0 ? -1 : Math.min(startedAtMs, entry.startedAtMs);
      bufferedAtMs =
        bufferedAtMs < 0 || entry.bufferedAtMs < 0
          ? -1
          : Math.min(bufferedAtMs, entry.bufferedAtMs);
      if (index === 0) {
        continue;
      }

      inputKind = coalesceTerminalInputTraceKind(inputKind, entry.inputKind, true);
    }

    return {
      bufferedAtMs,
      inputKind,
      startedAtMs,
    };
  }

  function detectPendingInputTraceEcho(chunk: Uint8Array, outputReceivedAtMs: number): void {
    if (pendingInputTraceEchoes.size === 0) {
      return;
    }

    const decodedText = TRACE_TEXT_DECODER.decode(chunk);
    const combinedText = pendingInputTraceOutputTail + decodedText;
    pendingInputTraceOutputTail = combinedText.slice(-INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS);
    const visibleTail = stripAnsi(pendingInputTraceOutputTail).replace(/\r/g, '');
    const pendingEntries = Array.from(pendingInputTraceEchoes.entries()).filter(
      ([, pendingTrace]) => pendingTrace.outputReceivedAtMs === null,
    );
    let matchedCount = 0;
    let expectedSuffix = '';

    for (const [index, [, pendingTrace]] of pendingEntries.entries()) {
      expectedSuffix += pendingTrace.expectedText;
      if (visibleTail.endsWith(expectedSuffix)) {
        matchedCount = index + 1;
      }
    }

    for (const [, pendingTrace] of pendingEntries.slice(0, matchedCount)) {
      pendingTrace.outputReceivedAtMs = outputReceivedAtMs;
    }
  }

  function finalizePendingInputTraceEchoes(outputRenderedAtMs: number): void {
    for (const [requestId, pendingTrace] of pendingInputTraceEchoes) {
      const outputReceivedAtMs = pendingTrace.outputReceivedAtMs;
      if (outputReceivedAtMs === null || !hasTerminalTraceClockAlignment()) {
        continue;
      }

      sendTerminalInputTraceUpdate({
        agentId,
        outputReceivedAtMs,
        outputRenderedAtMs,
        requestId,
      });
      pendingInputTraceEchoes.delete(requestId);
    }
  }

  function getOrCreateInFlightInputBatch(): InFlightInputBatch | null {
    if (inFlightInputBatch) {
      return inFlightInputBatch;
    }

    const nextBatch = takeQueuedTerminalInputBatch(inputQueue);
    if (!nextBatch) {
      return null;
    }

    const queuedEntries = inputQueue.slice(0, nextBatch.count);
    const traceSummary = summarizeQueuedInputTrace(queuedEntries);
    inFlightInputBatch = {
      ...nextBatch,
      bufferedAtMs: traceSummary.bufferedAtMs,
      inputKind: traceSummary.inputKind,
      queuedAt: inputQueue[0]?.queuedAt ?? 0,
      requestId: crypto.randomUUID(),
      startedAtMs: traceSummary.startedAtMs,
      traceEchoText: getTraceEchoText(nextBatch.batch),
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
    if (restoreInFlight || restoringScrollback) {
      retryInputDrain();
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

        return sendQueuedInputBatch(queuedBatch);
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

  function sendQueuedInputBatch(batch: InFlightInputBatch): Promise<boolean> {
    const sendStartedAtMs = getTerminalTraceTimestampMs();
    armInteractiveEchoFastPath(batch);
    const trace =
      batch.traceEchoText &&
      batch.bufferedAtMs >= 0 &&
      batch.startedAtMs >= 0 &&
      hasTerminalTraceClockAlignment()
        ? {
            bufferedAtMs: batch.bufferedAtMs,
            inputChars: batch.batch.length,
            inputKind: batch.inputKind,
            sendStartedAtMs,
            startedAtMs: batch.startedAtMs,
          }
        : null;
    if (trace && batch.traceEchoText) {
      pendingInputTraceEchoes.set(batch.requestId, {
        expectedText: batch.traceEchoText,
        outputReceivedAtMs: null,
      });
    }

    return sendTerminalInput({
      agentId,
      controllerId: runtimeClientId,
      data: batch.batch,
      requestId: batch.requestId,
      taskId,
      ...(trace ? { trace } : {}),
    }).then(() => {
      recordInputSent(batch.queuedAt);
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
    const bufferedAtMs = hasTerminalTraceClockAlignment() ? getTerminalTraceTimestampMs() : -1;
    inputQueue.push(
      ...splitTerminalInputChunks(pendingInput).map((chunk) => ({
        ...chunk,
        bufferedAtMs,
        inputKind: pendingInputKind,
        queuedAt,
        startedAtMs: pendingInputStartedAtMs >= 0 ? pendingInputStartedAtMs : bufferedAtMs,
      })),
    );
    pendingInput = '';
    pendingInputQueuedAt = -1;
    pendingInputStartedAtMs = -1;
    pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
    pendingInputKind = 'interactive';
  }

  function enqueueInput(data: string): void {
    if (processExited) {
      return;
    }
    const plan = getTerminalInputBatchPlan(data);
    const wasIdle = pendingInput.length === 0 && inputQueue.length === 0 && !inputSendInFlight;
    const hadPendingInput = pendingInput.length > 0;
    const traceContext = takeInputTraceContext(data);
    if (pendingInputQueuedAt < 0) {
      pendingInputQueuedAt = recordInputQueued();
      pendingInputStartedAtMs = traceContext.startedAtMs;
    }
    pendingInput += data;
    pendingInputCharLimit = mergePendingInputCharLimit(pendingInputCharLimit, data);
    pendingInputKind = coalesceTerminalInputTraceKind(
      pendingInputKind,
      traceContext.inputKind,
      hadPendingInput,
    );
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
    if (restoreInFlight || restoringScrollback) {
      scheduleResizeFlush();
      return;
    }
    if (!spawnReady && !spawnFailed && !disposed) {
      scheduleResizeFlush();
      return;
    }

    const { cols, rows } = pendingResize;
    const controller = getTaskCommandController(taskId);
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

  async function restoreTerminalOutput(
    reason: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss' = 'renderer-loss',
  ): Promise<void> {
    if (disposed || restoreInFlight) return;
    restoreInFlight = true;
    // Any structured recovery must temporarily stop live flush/input drain so we
    // can reconcile against backend-owned terminal state. Only snapshot fallback
    // should surface the blocking restore UI.
    restoringScrollback = true;
    try {
      if (reason === 'renderer-loss') {
        await ensureTerminalFitReady();
        term.refresh(0, Math.max(term.rows - 1, 0));
        markTerminalReady();
        return;
      }

      await ensureTerminalFitReady();
      while ((outputWriteInFlight || flowPauseInFlight || flowResumeInFlight) && !disposed) {
        await waitForRestoreYield();
      }
      if (disposed) return;

      await invoke(IPC.PauseAgent, { agentId, reason: 'restore', channelId: onOutput.id });
      restorePauseApplied = true;
      const recoveryRequest =
        reason === 'reconnect' ? requestReconnectTerminalRecovery : requestTerminalRecovery;
      const recoveryEntry = await recoveryRequest(agentId, getTerminalRecoveryRequestState());
      if (disposed) return;

      if (shouldShowBlockingRestoreUI(recoveryEntry)) {
        setStatus('restoring');
      }

      const droppedBytes = outputQueuedBytes;
      outputQueue = [];
      outputQueuedBytes = 0;
      watermark = Math.max(watermark - droppedBytes, 0);
      outputQueueFirstReceiveTs = 0;

      await applyTerminalRecoveryEntry(recoveryEntry);
      await ensureTerminalFitReady();
      if (shouldScrollToBottomAfterRecovery(recoveryEntry)) {
        term.scrollToBottom();
      }
    } catch (error) {
      console.warn('[terminal] Failed to restore scrollback', error);
    } finally {
      if (restorePauseApplied) {
        try {
          await invoke(IPC.ResumeAgent, { agentId, reason: 'restore', channelId: onOutput.id });
        } catch (error) {
          console.warn('[terminal] Failed to resume after scrollback restore', error);
        } finally {
          restorePauseApplied = false;
        }
      }

      restoringScrollback = false;
      restoreInFlight = false;
      if (outputQueue.length > 0) {
        scheduleOutputFlush();
      }
      if (pendingExitPayload && !outputWriteInFlight && outputQueue.length === 0) {
        const exit = pendingExitPayload;
        pendingExitPayload = null;
        emitExit(exit);
      }
      if (!disposed && !spawnFailed && !restoringScrollback) {
        markTerminalReady();
        flushPendingResize();
        flushPendingInput();
        drainInputQueue();
      }
      recoverFlowControlIfIdle();
    }
  }

  acquireWebglAddon(agentId, term, () => restoreTerminalOutput('renderer-loss'));

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
          void restoreTerminalOutput('reconnect');
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
      const spawnResult = await invoke(IPC.SpawnAgent, {
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
      if (spawnResult.attachedExistingSession) {
        await restoreTerminalOutput('attach');
      }
      recoverFlowControlIfIdle();
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
    updateOutputPriority(): void {
      outputRegistration?.updatePriority();
    },
    cleanup(): void {
      flushPendingInput();
      disposed = true;
      cancelInFlightInputBatch();
      cancelInFlightResizeRequest();
      clearQueuedInputState();
      flushPendingResize();
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (resizeFlushTimer !== undefined) clearTimeout(resizeFlushTimer);
      clearReadyFallback();
      if (flowRetryTimer !== undefined) clearTimeout(flowRetryTimer);
      clearOutputWriteWatchdog();
      fireAndForget(IPC.ResumeAgent, {
        agentId,
        reason: 'flow-control',
        channelId: onOutput.id,
      });
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
