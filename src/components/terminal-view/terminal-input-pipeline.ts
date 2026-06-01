import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { MAX_CLIENT_INPUT_DATA_LENGTH } from '../../../electron/remote/protocol';
import {
  BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE,
  cancelBrowserAgentCommandRequest,
  invoke,
  sendTerminalInput,
  sendTerminalInputTraceUpdate,
} from '../../lib/ipc';
import { createRandomId } from '../../lib/random-id';
import {
  getTerminalTraceTimestampMs,
  hasTerminalTraceClockAlignment,
  recordInputAccepted,
  recordInputBuffered,
  recordInputCommandResultReceived,
  recordInputDispatched,
  recordInputLeaseRequested,
  recordInputLeaseResolved,
  recordInputQueued,
  recordInputSent,
} from '../../lib/terminalLatency';
import { stripAnsi } from '../../lib/prompt-detection';
import { noteTerminalFocusedInput } from '../../app/terminal-focused-input';
import { activateTerminalSwitchEchoGrace } from '../../app/terminal-switch-echo-grace';
import {
  createTaskCommandLeaseSession,
  hasTaskCommandLeaseTransportAvailability,
} from '../../app/task-command-lease-session';
import {
  isRendererRuntimeDiagnosticsEnabled,
  recordTerminalInputBatchSent,
  recordTerminalInputDroppedSuffixBatches,
  recordTerminalInputFlush,
  recordTerminalInputQueueState,
  recordTerminalInputRetryScheduled,
  recordTerminalResizeCommitAttempt,
  recordTerminalResizeCommitDeferred,
  recordTerminalResizeCommitNoopSkip,
  recordTerminalResizeCommitSuccess,
  recordTerminalResizeFlush,
  recordTerminalResizePendingState,
  recordTerminalResizeQueued,
  type TerminalResizeDeferReason,
  type TerminalResizePendingReason,
} from '../../app/runtime-diagnostics';
import { getTaskCommandController } from '../../store/task-command-controllers';
import type { TerminalInputTraceKind } from '../../domain/terminal-input-tracing';
import type { TerminalViewProps } from './types';
import {
  DEFAULT_MAX_PENDING_CHARS,
  MAX_SEND_BATCH_CHARS,
  getTerminalInputBatchPlan,
  hasImmediateFlushTerminalInput,
  mergePendingInputCharLimit,
  splitTerminalInputChunks,
  takeQueuedTerminalInputBatch,
} from '../../lib/terminal-input-batching';

const INPUT_RETRY_DELAY_MS = 50;
const MAX_CONCURRENT_INPUT_BATCHES = 16;
const MAX_CONCURRENT_INTERACTIVE_INPUT_BATCHES = MAX_CONCURRENT_INPUT_BATCHES;
const MAX_CONCURRENT_CONTROL_INPUT_BATCHES = 1;
const MAX_INITIAL_INTERACTIVE_SEND_BATCH_CHARS = 4;
const RESIZE_FLUSH_DELAY_MS = 48;
const ALTERNATE_BUFFER_RESIZE_FLUSH_DELAY_MS = 120;
const TASK_CONTROLLED_AGENT_ERROR_MESSAGE = 'Task is controlled by another client';
const INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS = 4 * 1024;
const INPUT_TRACE_BACKEND_ECHO_TEXT_MAX_CHARS = 512;
const MAX_PENDING_INPUT_TRACE_ECHOES = 256;
const KEYBOARD_TRACE_START_MAX_AGE_MS = 250;

interface QueuedInputChunk {
  bufferedUntilInputAccepted: boolean;
  bufferedAtMs: number;
  data: string;
  inputKind: TerminalInputTraceKind;
  queuedAt: number;
  requiresInputAcceptance: boolean;
  startedAtMs: number;
}

interface InFlightInputBatch {
  batch: string;
  bufferedUntilInputAccepted: boolean;
  bufferedAtMs: number;
  count: number;
  inputEpoch: string;
  inputKind: TerminalInputTraceKind;
  inputSeq: number;
  queueBacked: boolean;
  queuedAt: number;
  requiresInputAcceptance: boolean;
  requestId: string;
  startedAtMs: number;
  status: 'accepted' | 'sending';
  traceEchoText: string | null;
}

interface KeyboardTraceEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

interface PendingKeyboardTraceStart {
  event: KeyboardTraceEventLike;
  startedAtMs: number;
}

interface FlushPendingInputOptions {
  traceAsImmediate?: boolean;
}

interface EnqueueInputOptions {
  bufferedUntilInputAccepted?: boolean;
  requiresInputAcceptance?: boolean;
}

interface TerminalGeometry {
  cols: number;
  rows: number;
}

type TerminalResizeState =
  | { kind: 'idle'; lastSent: TerminalGeometry | null }
  | {
      kind: 'deferred';
      lastSent: TerminalGeometry | null;
      pending: TerminalGeometry;
      reason: TerminalResizeDeferReason;
    }
  | { kind: 'scheduled'; lastSent: TerminalGeometry | null; pending: TerminalGeometry }
  | {
      generation: number;
      inFlight: TerminalGeometry;
      kind: 'sending';
      lastSent: TerminalGeometry | null;
      pending: TerminalGeometry | null;
      requestId: string;
    };

export interface TerminalInputPipeline {
  adoptBackendResizeForRecovery(geometry: TerminalGeometry): void;
  cleanup(): void;
  detectPendingInputTraceEcho(
    chunk: Uint8Array,
    outputReceivedAtMs: number,
    outputTransportReceivedAtMs?: number,
  ): void;
  drainInputQueue(): void;
  enqueueProgrammaticInput(data: string): void;
  finalizePendingInputTraceEchoes(outputRenderedAtMs: number): void;
  flushPendingResizeForRecoveryAlignment(): Promise<void>;
  flushPendingInput(): void;
  flushPendingResize(): Promise<void>;
  handleControllerChange(controllerId: string | null): void;
  handleTaskControlLoss(): void;
  handleTerminalData(data: string): void;
  handleTerminalResize(cols: number, rows: number): void;
  isResizeTransactionPending(): boolean;
  recordKeyboardTraceStart(event: KeyboardTraceEventLike): void;
  requestInputTakeover(): Promise<boolean>;
  setNextProgrammaticInputTrace(data: string): void;
}

interface CreateTerminalInputPipelineOptions {
  agentId: string;
  armInteractiveEchoFastPath: () => void;
  isDisposed: () => boolean;
  isProcessExited: () => boolean;
  isRestoreBlocked: () => boolean;
  isSpawnFailed: () => boolean;
  isSpawnReady: () => boolean;
  canAcceptInput?: () => boolean;
  canBufferInputWhileInteractionPending?: () => boolean;
  onBlockedInputAttempt?: () => void;
  onInputAccepted?: () => void;
  onInputActivity?: () => void;
  onLocalInputFeedback?: (data: string) => void;
  onReadOnlyInputAttempt?: () => void;
  onResizeCommitted?: (geometry: TerminalGeometry) => void;
  onResizeTransactionChange?: (active: boolean) => void;
  props: TerminalViewProps;
  runtimeClientId: string;
  shouldCommitResize?: () => boolean;
  taskId: string;
  term: Terminal;
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

function isTraceEchoTextChar(char: string): boolean {
  const charCode = char.charCodeAt(0);
  return (
    (charCode >= 32 && charCode < 127) ||
    charCode > 159 ||
    char === '\t' ||
    char === '\n' ||
    char === '\r'
  );
}

function getTraceEchoText(data: string): string | null {
  const printableText = Array.from(stripAnsi(data))
    .filter(isTraceEchoTextChar)
    .join('')
    .replace(/\r/g, '');
  return printableText.length > 0 ? printableText : null;
}

function getBackendTraceEchoText(echoText: string): string | undefined {
  return echoText.length <= INPUT_TRACE_BACKEND_ECHO_TEXT_MAX_CHARS ? echoText : undefined;
}

function getControlTracePrefix(event: KeyboardTraceEventLike): string | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }

  const normalizedKey = event.key.toLowerCase();
  if (normalizedKey.length === 1 && normalizedKey >= 'a' && normalizedKey <= 'z') {
    return String.fromCharCode(normalizedKey.charCodeAt(0) - 96);
  }

  switch (normalizedKey) {
    case '[':
      return '\x1b';
    case '\\':
      return '\x1c';
    case ']':
      return '\x1d';
    case '^':
    case '6':
      return '\x1e';
    case '_':
    case '-':
      return '\x1f';
    default:
      return null;
  }
}

function getSingleCharacterKeyInput(key: string): string | null {
  return key.length === 1 ? key : null;
}

function getKeyboardTraceInputPrefix(event: KeyboardTraceEventLike): string | null {
  const controlPrefix = getControlTracePrefix(event);
  if (controlPrefix !== null) {
    return controlPrefix;
  }

  if (event.ctrlKey || event.metaKey) {
    return null;
  }

  switch (event.key) {
    case 'Backspace':
      return '\x7f';
    case 'Enter':
      return '\r';
    case 'Escape':
      return '\x1b';
    case 'Tab':
      return '\t';
    default:
      break;
  }

  if (event.altKey) {
    const keyInput = getSingleCharacterKeyInput(event.key);
    return keyInput === null ? null : `\x1b${keyInput}`;
  }

  return getSingleCharacterKeyInput(event.key);
}

function doesKeyboardTraceMatchInput(
  traceStart: PendingKeyboardTraceStart,
  data: string,
  nowMs: number,
): boolean {
  if (nowMs - traceStart.startedAtMs > KEYBOARD_TRACE_START_MAX_AGE_MS) {
    return false;
  }

  const prefix = getKeyboardTraceInputPrefix(traceStart.event);
  return prefix !== null && data.startsWith(prefix);
}

export function createTerminalInputPipeline(
  options: CreateTerminalInputPipelineOptions,
): TerminalInputPipeline {
  const { agentId, onReadOnlyInputAttempt, props, runtimeClientId, taskId } = options;

  let inputBuffer = '';
  let pendingInput = '';
  let pendingInputQueuedAt = -1;
  let pendingInputStartedAtMs = -1;
  let pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
  let pendingInputKind: TerminalInputTraceKind = 'interactive';
  let pendingInputBufferedUntilAccepted = false;
  let pendingInputRequiresAcceptance = false;
  const pendingKeyboardTraceStarts: PendingKeyboardTraceStart[] = [];
  let nextProgrammaticInputTrace: {
    inputKind: TerminalInputTraceKind;
    startedAtMs: number;
  } | null = null;
  const inputQueue: QueuedInputChunk[] = [];
  const pendingRetryInputBatches: InFlightInputBatch[] = [];
  const inFlightInputBatches: InFlightInputBatch[] = [];
  let inputEpoch = createRandomId();
  let nextInputSeq = 0;
  let resizeEpoch = createRandomId();
  let nextResizeSeq = 0;
  let inputLifecycleGeneration = 0;
  let inputFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let inputLeaseAcquirePromise: Promise<boolean> | null = null;
  let resizeFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let resizeLifecycleGeneration = 0;
  let resizeState: TerminalResizeState = { kind: 'idle', lastSent: null };
  let pendingResizeStartedAtMs: number | null = null;
  let inFlightResizeCommitPromise: Promise<void> | null = null;
  let peerDeferredResize: TerminalGeometry | null = null;
  let pendingInputTraceOutputTail = '';
  let inputTraceTextDecoder = new TextDecoder();
  const pendingInputTraceEchoes = new Map<
    string,
    {
      expectedText: string;
      outputReceivedAtMs: number | null;
      outputTransportReceivedAtMs: number | null;
    }
  >();
  const inputLeaseSession = createTaskCommandLeaseSession(taskId, 'type in the terminal', {
    confirmTakeover: false,
  });

  function isCanceledBrowserAgentCommandError(error: unknown): boolean {
    return String(error).includes(BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE);
  }

  function isTaskControlledAgentError(error: unknown): boolean {
    return String(error).includes(TASK_CONTROLLED_AGENT_ERROR_MESSAGE);
  }

  function clearQueuedInputState(): void {
    inputQueue.length = 0;
    pendingRetryInputBatches.length = 0;
    inFlightInputBatches.length = 0;
    inputBuffer = '';
    resetPendingInputState();
    pendingKeyboardTraceStarts.length = 0;
    nextProgrammaticInputTrace = null;
    clearPendingInputTraceEchoes();
    rotateInputOrderingEpoch();
    updateInputQueueDiagnostics();
  }

  function resetInputTraceDecoder(): void {
    inputTraceTextDecoder = new TextDecoder();
  }

  function clearPendingInputTraceEchoes(): void {
    pendingInputTraceEchoes.clear();
    pendingInputTraceOutputTail = '';
    resetInputTraceDecoder();
  }

  function resetInputTraceEchoStateIfIdle(): void {
    if (pendingInputTraceEchoes.size > 0) {
      return;
    }

    pendingInputTraceOutputTail = '';
    resetInputTraceDecoder();
  }

  function deletePendingInputTraceEcho(requestId: string): void {
    pendingInputTraceEchoes.delete(requestId);
    resetInputTraceEchoStateIfIdle();
  }

  function rotateInputOrderingEpoch(): void {
    inputEpoch = createRandomId();
    nextInputSeq = 0;
  }

  function rotateResizeOrderingEpoch(): void {
    resizeEpoch = createRandomId();
    nextResizeSeq = 0;
  }

  function resetPendingInputState(): void {
    pendingInput = '';
    pendingInputQueuedAt = -1;
    pendingInputStartedAtMs = -1;
    pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
    pendingInputKind = 'interactive';
    pendingInputBufferedUntilAccepted = false;
    pendingInputRequiresAcceptance = false;
  }

  function getBufferedInputChars(): number {
    return (
      pendingInput.length +
      inputQueue.reduce((totalChars, entry) => totalChars + entry.data.length, 0) +
      pendingRetryInputBatches.reduce((totalChars, entry) => totalChars + entry.batch.length, 0)
    );
  }

  function updateInputQueueDiagnostics(): void {
    if (!isRendererRuntimeDiagnosticsEnabled()) {
      return;
    }

    recordTerminalInputQueueState({
      bufferedChars: getBufferedInputChars(),
      inFlightBatches: inFlightInputBatches.length,
      queuedChunks: inputQueue.length + pendingRetryInputBatches.length,
    });
  }

  function cancelInFlightInputBatch(): void {
    if (inFlightInputBatches.length === 0) {
      return;
    }

    for (const batch of inFlightInputBatches) {
      cancelBrowserAgentCommandRequest(batch.requestId);
      deletePendingInputTraceEcho(batch.requestId);
    }
    inFlightInputBatches.length = 0;
    rotateInputOrderingEpoch();
    inputLifecycleGeneration += 1;
    updateInputQueueDiagnostics();
  }

  function cancelInFlightResizeRequest(): void {
    if (resizeState.kind !== 'sending') {
      return;
    }

    cancelBrowserAgentCommandRequest(resizeState.requestId);
    setResizeIdle();
    rotateResizeOrderingEpoch();
    resizeLifecycleGeneration += 1;
  }

  function isSameResizeGeometry(
    left: TerminalGeometry | null,
    right: TerminalGeometry | null,
  ): boolean {
    if (!left || !right) {
      return false;
    }

    return left.cols === right.cols && left.rows === right.rows;
  }

  function hasLastSentResizeGeometry(cols: number, rows: number): boolean {
    return isSameResizeGeometry(resizeState.lastSent, { cols, rows });
  }

  function hasPeerDeferredResizeGeometry(cols: number, rows: number): boolean {
    return isSameResizeGeometry(peerDeferredResize, { cols, rows });
  }

  function getCurrentTerminalGeometry(): TerminalGeometry | null {
    if (options.term.cols <= 0 || options.term.rows <= 0) {
      return null;
    }

    return {
      cols: options.term.cols,
      rows: options.term.rows,
    };
  }

  function isTerminalInputRetryAllowed(): boolean {
    return !options.isDisposed() && !options.isSpawnFailed() && !options.isProcessExited();
  }

  function getResizeDiagnosticsNowMs(): number {
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
      return Date.now();
    }

    return performance.now();
  }

  function getResizePendingReason(state: TerminalResizeState): TerminalResizePendingReason | null {
    switch (state.kind) {
      case 'idle':
        return null;
      case 'deferred':
        return state.reason;
      case 'scheduled':
        return 'scheduled';
      case 'sending':
        return 'sending';
    }
  }

  function syncResizePendingDiagnostics(nextState: TerminalResizeState): void {
    const pendingReason = getResizePendingReason(nextState);
    if (!pendingReason) {
      pendingResizeStartedAtMs = null;
      recordTerminalResizePendingState({ agentId, pending: false });
      return;
    }

    pendingResizeStartedAtMs ??= getResizeDiagnosticsNowMs();
    recordTerminalResizePendingState({
      agentId,
      pending: true,
      pendingSinceMs: pendingResizeStartedAtMs,
      reason: pendingReason,
    });
  }

  function setResizeState(nextState: TerminalResizeState): void {
    const wasActive = resizeState.kind !== 'idle';
    const isActive = nextState.kind !== 'idle';
    resizeState = nextState;
    syncResizePendingDiagnostics(nextState);
    if (wasActive !== isActive) {
      options.onResizeTransactionChange?.(isActive);
    }
  }

  function setResizeIdle(lastSent: TerminalGeometry | null = resizeState.lastSent): void {
    setResizeState({
      kind: 'idle',
      lastSent,
    });
  }

  function getPendingResize(): TerminalGeometry | null {
    switch (resizeState.kind) {
      case 'idle':
        return null;
      case 'deferred':
      case 'scheduled':
        return resizeState.pending;
      case 'sending':
        return resizeState.pending;
    }
  }

  function getInFlightResize(): TerminalGeometry | null {
    if (resizeState.kind !== 'sending') {
      return null;
    }

    return resizeState.inFlight;
  }

  function deferResize(pending: TerminalGeometry, reason: TerminalResizeDeferReason): void {
    if (resizeState.kind === 'sending') {
      setResizeState({
        ...resizeState,
        pending,
      });
      return;
    }

    setResizeState({
      kind: 'deferred',
      lastSent: resizeState.lastSent,
      pending,
      reason,
    });
  }

  function scheduleResize(pending: TerminalGeometry): void {
    if (resizeState.kind === 'sending') {
      setResizeState({
        ...resizeState,
        pending,
      });
      return;
    }

    setResizeState({
      kind: 'scheduled',
      lastSent: resizeState.lastSent,
      pending,
    });
  }

  function ensureCurrentTerminalGeometryResizeScheduled(): void {
    const currentGeometry = getCurrentTerminalGeometry();
    if (!currentGeometry) {
      return;
    }

    if (getPendingResize() || getInFlightResize() || peerDeferredResize) {
      return;
    }

    if (hasLastSentResizeGeometry(currentGeometry.cols, currentGeometry.rows)) {
      return;
    }

    scheduleResize(currentGeometry);
  }

  function clearPendingResize(): void {
    setResizeIdle();
  }

  function clearDuplicatePendingResize(): void {
    if (resizeState.kind === 'sending') {
      setResizeState({
        ...resizeState,
        pending: null,
      });
      return;
    }

    clearPendingResize();
  }

  function preserveResizeForPeerControl(geometry: TerminalGeometry): void {
    peerDeferredResize = geometry;
    setResizeIdle();
  }

  function notifyResizeCommitted(geometry: TerminalGeometry): void {
    options.onResizeCommitted?.(geometry);
  }

  function handleTaskControlLoss(): void {
    const pendingResize = getPendingResize() ?? getInFlightResize() ?? peerDeferredResize;
    if (inputFlushTimer !== undefined) {
      clearTimeout(inputFlushTimer);
      inputFlushTimer = undefined;
    }
    cancelInFlightInputBatch();
    cancelInFlightResizeRequest();
    peerDeferredResize = pendingResize;
    setResizeState({ kind: 'idle', lastSent: null });
    clearQueuedInputState();
    onReadOnlyInputAttempt?.();
  }

  function scheduleInputFlush(delay = 8): void {
    if (options.isDisposed() || inputFlushTimer !== undefined) {
      return;
    }

    inputFlushTimer = globalThis.setTimeout(() => {
      inputFlushTimer = undefined;
      flushPendingInput();
      drainInputQueue();
    }, delay);
  }

  function retryInputDrain(): void {
    recordTerminalInputRetryScheduled();
    scheduleInputFlush(INPUT_RETRY_DELAY_MS);
  }

  function takeKeyboardTraceStartForData(data: string): number | null {
    const nowMs = getTerminalTraceTimestampMs();
    while (pendingKeyboardTraceStarts.length > 0) {
      const traceStart = pendingKeyboardTraceStarts.shift();
      if (!traceStart) {
        continue;
      }

      if (doesKeyboardTraceMatchInput(traceStart, data, nowMs)) {
        return traceStart.startedAtMs;
      }
    }

    return null;
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
      ? (takeKeyboardTraceStartForData(data) ?? getTerminalTraceTimestampMs())
      : -1;
    return {
      inputKind: classifyTerminalInputTraceKind(data),
      startedAtMs,
    };
  }

  function getPendingInputBufferedTraceTimestamp(options: FlushPendingInputOptions): number {
    if (!hasTerminalTraceClockAlignment()) {
      return -1;
    }

    if (options.traceAsImmediate === true && pendingInputStartedAtMs >= 0) {
      return pendingInputStartedAtMs;
    }

    return getTerminalTraceTimestampMs();
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

  function getQueuedInputSendBatchMaxChars(
    queueEntries: readonly QueuedInputChunk[],
    hasInFlightInputBatch: boolean,
  ): number {
    const firstEntry = queueEntries[0];
    if (!firstEntry) {
      return DEFAULT_MAX_PENDING_CHARS;
    }

    if (firstEntry.bufferedUntilInputAccepted) {
      return MAX_SEND_BATCH_CHARS;
    }

    switch (firstEntry.inputKind) {
      case 'interactive':
      case 'control':
        if (hasInFlightInputBatch) {
          return firstEntry.data.length;
        }
        return Math.max(firstEntry.data.length, MAX_INITIAL_INTERACTIVE_SEND_BATCH_CHARS);
      case 'burst':
        if (hasInFlightInputBatch) {
          return Math.min(8, Math.max(firstEntry.data.length, 1));
        }
        return Math.min(16, Math.max(firstEntry.data.length, 1));
      case 'paste':
        return MAX_SEND_BATCH_CHARS;
    }
  }

  function getQueuedInputConcurrencyLimit(queueEntries: readonly QueuedInputChunk[]): number {
    const firstEntry = queueEntries[0];
    if (!firstEntry) {
      return MAX_CONCURRENT_INPUT_BATCHES;
    }

    if (firstEntry.bufferedUntilInputAccepted) {
      return 1;
    }

    return getInputBatchConcurrencyLimit(firstEntry.inputKind);
  }

  function getInputBatchConcurrencyLimit(inputKind: TerminalInputTraceKind): number {
    switch (inputKind) {
      case 'interactive':
        return MAX_CONCURRENT_INTERACTIVE_INPUT_BATCHES;
      case 'control':
        return MAX_CONCURRENT_CONTROL_INPUT_BATCHES;
      case 'burst':
      case 'paste':
        return MAX_CONCURRENT_INPUT_BATCHES;
    }
  }

  function trackPendingInputTraceEcho(requestId: string, expectedText: string): void {
    while (pendingInputTraceEchoes.size >= MAX_PENDING_INPUT_TRACE_ECHOES) {
      const oldestRequestId = pendingInputTraceEchoes.keys().next().value;
      if (typeof oldestRequestId !== 'string') {
        break;
      }

      pendingInputTraceEchoes.delete(oldestRequestId);
    }

    pendingInputTraceEchoes.set(requestId, {
      expectedText,
      outputReceivedAtMs: null,
      outputTransportReceivedAtMs: null,
    });
  }

  function detectPendingInputTraceEcho(
    chunk: Uint8Array,
    outputReceivedAtMs: number,
    outputTransportReceivedAtMs?: number,
  ): void {
    if (pendingInputTraceEchoes.size === 0) {
      return;
    }

    const combinedText =
      pendingInputTraceOutputTail + inputTraceTextDecoder.decode(chunk, { stream: true });
    pendingInputTraceOutputTail = combinedText.slice(-INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS);
    const visibleTail = stripAnsi(pendingInputTraceOutputTail).replace(/\r/g, '');
    const pendingEntries = Array.from(pendingInputTraceEchoes.entries()).filter(
      ([, pendingTrace]) => pendingTrace.outputReceivedAtMs === null,
    );
    let searchStartIndex = 0;

    for (const [, pendingTrace] of pendingEntries) {
      const matchIndex = visibleTail.indexOf(pendingTrace.expectedText, searchStartIndex);
      if (matchIndex < 0) {
        continue;
      }

      pendingTrace.outputReceivedAtMs = outputReceivedAtMs;
      pendingTrace.outputTransportReceivedAtMs = outputTransportReceivedAtMs ?? null;
      searchStartIndex = matchIndex + pendingTrace.expectedText.length;
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
        ...(pendingTrace.outputTransportReceivedAtMs !== null
          ? { outputTransportReceivedAtMs: pendingTrace.outputTransportReceivedAtMs }
          : {}),
        requestId,
      });
      pendingInputTraceEchoes.delete(requestId);
    }

    resetInputTraceEchoStateIfIdle();
  }

  function getOrCreateInFlightInputBatch(): InFlightInputBatch | null {
    const dispatchedCount = getDispatchedInputCount();
    const queuedEntries = inputQueue.slice(dispatchedCount);
    const maxBatchChars = getQueuedInputSendBatchMaxChars(
      queuedEntries,
      inFlightInputBatches.length > 0,
    );
    const nextBatch = takeQueuedTerminalInputBatch(queuedEntries, maxBatchChars);
    if (!nextBatch) {
      return null;
    }

    const queuedBatchEntries = queuedEntries.slice(0, nextBatch.count);
    const traceSummary = summarizeQueuedInputTrace(queuedBatchEntries);
    const batch = {
      ...nextBatch,
      bufferedAtMs: traceSummary.bufferedAtMs,
      inputEpoch,
      inputKind: traceSummary.inputKind,
      inputSeq: nextInputSeq,
      bufferedUntilInputAccepted: queuedBatchEntries.some(
        (entry) => entry.bufferedUntilInputAccepted,
      ),
      queueBacked: true,
      queuedAt: queuedBatchEntries[0]?.queuedAt ?? 0,
      requiresInputAcceptance: queuedBatchEntries.some((entry) => entry.requiresInputAcceptance),
      requestId: createRandomId(),
      startedAtMs: traceSummary.startedAtMs,
      status: 'sending' as const,
      traceEchoText: getTraceEchoText(nextBatch.batch),
    };
    nextInputSeq += Math.max(
      1,
      splitTerminalInputChunks(batch.batch, MAX_CLIENT_INPUT_DATA_LENGTH).length,
    );
    inFlightInputBatches.push(batch);
    updateInputQueueDiagnostics();
    return batch;
  }

  function ensureInputLease(): Promise<boolean> {
    if (inputLeaseSession.touch()) {
      return Promise.resolve(true);
    }

    if (inputLeaseAcquirePromise) {
      return inputLeaseAcquirePromise;
    }

    inputLeaseAcquirePromise = inputLeaseSession.acquire().finally(() => {
      inputLeaseAcquirePromise = null;
    });
    return inputLeaseAcquirePromise;
  }

  function getDispatchedInputCount(): number {
    let count = 0;
    for (const batch of inFlightInputBatches) {
      if (batch.queueBacked) {
        count += batch.count;
      }
    }
    return count;
  }

  function hasUndispatchedInput(): boolean {
    return pendingRetryInputBatches.length > 0 || inputQueue.length > getDispatchedInputCount();
  }

  function hasQueuedInputAwaitingAcceptance(): boolean {
    if (pendingRetryInputBatches.some((batch) => batch.requiresInputAcceptance)) {
      return true;
    }

    return inputQueue
      .slice(getDispatchedInputCount())
      .some((entry) => entry.requiresInputAcceptance);
  }

  function isQueuedInputAcceptanceBlocked(): boolean {
    return options.canAcceptInput?.() === false && hasQueuedInputAwaitingAcceptance();
  }

  function getLatestTargetResizeGeometry(): TerminalGeometry | null {
    return getPendingResize() ?? getInFlightResize() ?? peerDeferredResize ?? resizeState.lastSent;
  }

  function getInFlightInputBatch(requestId: string): InFlightInputBatch | null {
    return inFlightInputBatches.find((batch) => batch.requestId === requestId) ?? null;
  }

  function releaseAcceptedInputBatches(): void {
    while (inFlightInputBatches[0]?.status === 'accepted') {
      const batch = inFlightInputBatches.shift();
      if (!batch) {
        break;
      }

      if (batch.queueBacked) {
        inputQueue.splice(0, batch.count);
      }
    }
    updateInputQueueDiagnostics();
  }

  function getQueueBackedInputCountBeforeBatch(batchIndex: number): number {
    let count = 0;
    for (let index = 0; index < batchIndex; index += 1) {
      const batch = inFlightInputBatches[index];
      if (batch?.queueBacked) {
        count += batch.count;
      }
    }

    return count;
  }

  function createRetryInputBatch(batch: InFlightInputBatch): InFlightInputBatch {
    return {
      ...batch,
      queueBacked: false,
      requestId: createRandomId(),
      status: 'sending',
    };
  }

  function dropDispatchedInputSuffix(requestId: string): boolean {
    const batchIndex = inFlightInputBatches.findIndex((batch) => batch.requestId === requestId);
    if (batchIndex < 0) {
      return false;
    }

    const queueStartIndex = getQueueBackedInputCountBeforeBatch(batchIndex);
    const droppedBatches = inFlightInputBatches.splice(batchIndex);
    let queueBackedDroppedCount = 0;
    const retryBatches: InFlightInputBatch[] = [];
    for (const [index, batch] of droppedBatches.entries()) {
      if (batch.queueBacked) {
        queueBackedDroppedCount += batch.count;
      }

      deletePendingInputTraceEcho(batch.requestId);
      retryBatches.push(createRetryInputBatch(batch));
      if (index > 0 && batch.status === 'sending') {
        cancelBrowserAgentCommandRequest(batch.requestId);
      }
    }

    if (queueBackedDroppedCount > 0) {
      inputQueue.splice(queueStartIndex, queueBackedDroppedCount);
    }
    pendingRetryInputBatches.unshift(...retryBatches);
    recordTerminalInputDroppedSuffixBatches(droppedBatches.length);
    updateInputQueueDiagnostics();
    return retryBatches.length > 0;
  }

  function sendQueuedInputBatch(batch: InFlightInputBatch): Promise<boolean> {
    const inputDispatchedAt = recordInputDispatched(batch.queuedAt);
    const sendStartedAtMs = getTerminalTraceTimestampMs();
    if (batch.inputKind !== 'paste') {
      noteTerminalFocusedInput(taskId, agentId);
      activateTerminalSwitchEchoGrace(taskId);
      options.armInteractiveEchoFastPath();
    }
    const backendEchoText = batch.traceEchoText
      ? getBackendTraceEchoText(batch.traceEchoText)
      : undefined;
    const trace =
      batch.traceEchoText &&
      batch.bufferedAtMs >= 0 &&
      batch.startedAtMs >= 0 &&
      hasTerminalTraceClockAlignment()
        ? {
            bufferedAtMs: batch.bufferedAtMs,
            ...(backendEchoText ? { echoText: backendEchoText } : {}),
            inputChars: batch.batch.length,
            inputKind: batch.inputKind,
            sendStartedAtMs,
            startedAtMs: batch.startedAtMs,
          }
        : null;

    if (trace && batch.traceEchoText) {
      trackPendingInputTraceEcho(batch.requestId, batch.traceEchoText);
    }

    let commandResultReceivedAtMs = -1;
    return sendTerminalInput(
      {
        agentId,
        controllerId: runtimeClientId,
        data: batch.batch,
        inputEpoch: batch.inputEpoch,
        inputSeq: batch.inputSeq,
        requestId: batch.requestId,
        taskId,
        ...(trace ? { trace } : {}),
      },
      {
        onBrowserCommandResultReceived: (receivedAtMs) => {
          commandResultReceivedAtMs = recordInputCommandResultReceived(
            inputDispatchedAt,
            receivedAtMs,
          );
        },
      },
    ).then(() => {
      recordInputSent(batch.queuedAt);
      recordInputAccepted(inputDispatchedAt, commandResultReceivedAtMs);
      recordTerminalInputBatchSent(batch.batch.length);
      options.onInputAccepted?.();
      return true;
    });
  }

  function startSendingQueuedInputBatch(batch: InFlightInputBatch, inputGeneration: number): void {
    let retryAfterFlight = false;
    void sendQueuedInputBatch(batch)
      .then((sent) => {
        if (inputGeneration !== inputLifecycleGeneration) {
          return;
        }

        const currentBatch = getInFlightInputBatch(batch.requestId);
        if (!currentBatch) {
          return;
        }

        if (!sent) {
          retryAfterFlight = dropDispatchedInputSuffix(batch.requestId);
          return;
        }

        currentBatch.status = 'accepted';
        releaseAcceptedInputBatches();
      })
      .catch((error) => {
        if (
          inputGeneration !== inputLifecycleGeneration ||
          isCanceledBrowserAgentCommandError(error)
        ) {
          return;
        }

        if (isTaskControlledAgentError(error)) {
          void dropDispatchedInputSuffix(batch.requestId);
          handleTaskControlLoss();
          return;
        }

        retryAfterFlight = dropDispatchedInputSuffix(batch.requestId);
        if (isTerminalInputRetryAllowed()) {
          retryAfterFlight ||= hasUndispatchedInput();
        }
      })
      .finally(() => {
        if (
          inputGeneration !== inputLifecycleGeneration ||
          options.isDisposed() ||
          options.isProcessExited()
        ) {
          return;
        }

        if (retryAfterFlight || !options.isSpawnReady()) {
          if (hasUndispatchedInput()) {
            retryInputDrain();
          }
          return;
        }

        if (hasUndispatchedInput()) {
          drainInputQueue();
        }
      });
  }

  function drainInputQueue(): void {
    if (options.isDisposed() || options.isSpawnFailed() || options.isProcessExited()) {
      return;
    }
    if (!hasUndispatchedInput()) {
      return;
    }
    if (options.isRestoreBlocked()) {
      retryInputDrain();
      return;
    }
    if (isQueuedInputAcceptanceBlocked()) {
      retryInputDrain();
      return;
    }
    if (!options.isSpawnReady()) {
      retryInputDrain();
      return;
    }

    const inputGeneration = inputLifecycleGeneration;
    const inputLeaseRequestedAt = recordInputLeaseRequested();
    ensureInputLease()
      .then((acquired) => {
        recordInputLeaseResolved(inputLeaseRequestedAt);
        if (inputGeneration !== inputLifecycleGeneration || !isTerminalInputRetryAllowed()) {
          return;
        }

        if (!acquired) {
          if (!hasTaskCommandLeaseTransportAvailability()) {
            retryInputDrain();
            return;
          }
          onReadOnlyInputAttempt?.();
          clearQueuedInputState();
          return;
        }

        while (hasUndispatchedInput()) {
          const retryBatch = pendingRetryInputBatches.shift();
          if (retryBatch) {
            const concurrencyLimit = retryBatch.bufferedUntilInputAccepted
              ? 1
              : getInputBatchConcurrencyLimit(retryBatch.inputKind);
            if (inFlightInputBatches.length >= concurrencyLimit) {
              pendingRetryInputBatches.unshift(retryBatch);
              break;
            }

            inFlightInputBatches.push(retryBatch);
            updateInputQueueDiagnostics();
            startSendingQueuedInputBatch(retryBatch, inputGeneration);
            continue;
          }

          const queuedEntries = inputQueue.slice(getDispatchedInputCount());
          const concurrencyLimit = getQueuedInputConcurrencyLimit(queuedEntries);
          if (inFlightInputBatches.length >= concurrencyLimit) {
            break;
          }

          const queuedBatch = getOrCreateInFlightInputBatch();
          if (!queuedBatch) {
            return;
          }

          startSendingQueuedInputBatch(queuedBatch, inputGeneration);
        }
      })
      .catch((error) => {
        recordInputLeaseResolved(inputLeaseRequestedAt);
        if (
          inputGeneration !== inputLifecycleGeneration ||
          !isTerminalInputRetryAllowed() ||
          isCanceledBrowserAgentCommandError(error)
        ) {
          return;
        }

        if (isTaskControlledAgentError(error)) {
          handleTaskControlLoss();
          return;
        }

        if (isTerminalInputRetryAllowed()) {
          retryInputDrain();
        }
      });
  }

  function flushPendingInput(options: FlushPendingInputOptions = {}): void {
    if (inputFlushTimer !== undefined) {
      clearTimeout(inputFlushTimer);
      inputFlushTimer = undefined;
    }
    if (!pendingInput) {
      return;
    }

    recordTerminalInputFlush(false);
    const queuedAt = recordInputBuffered(pendingInputQueuedAt);
    const traceStartedAtMs = pendingInputStartedAtMs;
    const bufferedAtMs = getPendingInputBufferedTraceTimestamp(options);
    inputQueue.push(
      ...splitTerminalInputChunks(pendingInput).map((chunk) => ({
        ...chunk,
        bufferedUntilInputAccepted: pendingInputBufferedUntilAccepted,
        bufferedAtMs,
        inputKind: pendingInputKind,
        queuedAt,
        requiresInputAcceptance: pendingInputRequiresAcceptance,
        startedAtMs: traceStartedAtMs >= 0 ? traceStartedAtMs : bufferedAtMs,
      })),
    );
    resetPendingInputState();
    updateInputQueueDiagnostics();
  }

  function enqueueInput(data: string, enqueueOptions: EnqueueInputOptions = {}): void {
    if (options.isProcessExited()) {
      return;
    }

    const plan = getTerminalInputBatchPlan(data);
    if (pendingInput && hasImmediateFlushTerminalInput(data)) {
      flushPendingInput({ traceAsImmediate: true });
      drainInputQueue();
    }

    const wasIdle =
      pendingInput.length === 0 && inputQueue.length === 0 && inFlightInputBatches.length === 0;
    const hadPendingInput = pendingInput.length > 0;
    const traceContext = takeInputTraceContext(data);
    if (pendingInputQueuedAt < 0) {
      pendingInputQueuedAt = recordInputQueued();
      pendingInputStartedAtMs = traceContext.startedAtMs;
    }

    pendingInput += data;
    pendingInputCharLimit = hadPendingInput
      ? mergePendingInputCharLimit(pendingInputCharLimit, data)
      : plan.maxPendingChars;
    pendingInputKind = coalesceTerminalInputTraceKind(
      pendingInputKind,
      traceContext.inputKind,
      hadPendingInput,
    );
    pendingInputBufferedUntilAccepted ||= enqueueOptions.bufferedUntilInputAccepted === true;
    pendingInputRequiresAcceptance ||=
      enqueueOptions.requiresInputAcceptance === true && traceContext.inputKind !== 'paste';
    if (
      plan.flushImmediately ||
      pendingInput.length >= pendingInputCharLimit ||
      (plan.preferImmediateFlushWhenIdle && wasIdle)
    ) {
      flushPendingInput({ traceAsImmediate: true });
      drainInputQueue();
      return;
    }

    recordTerminalInputFlush(true);
    scheduleInputFlush(plan.flushDelayMs);
    updateInputQueueDiagnostics();
  }

  function recordPromptInput(data: string): void {
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
  }

  function enqueueAcceptedInput(data: string, enqueueOptions: EnqueueInputOptions): void {
    recordPromptInput(data);
    if (data.length > 0) {
      options.onInputActivity?.();
    }
    enqueueInput(data, enqueueOptions);
  }

  function canBufferInteractionPendingInput(): boolean {
    return options.canBufferInputWhileInteractionPending?.() === true;
  }

  function handleTerminalData(data: string): void {
    if (options.canAcceptInput?.() === false) {
      if (canBufferInteractionPendingInput()) {
        enqueueAcceptedInput(data, {
          bufferedUntilInputAccepted: true,
          requiresInputAcceptance: true,
        });
        return;
      }

      options.onBlockedInputAttempt?.();
      return;
    }

    options.onLocalInputFeedback?.(data);
    enqueueAcceptedInput(data, { requiresInputAcceptance: true });
  }

  function scheduleResizeFlush(delayMs = RESIZE_FLUSH_DELAY_MS): void {
    const hadScheduledFlush = resizeFlushTimer !== undefined;
    clearResizeFlushTimer();

    const pendingResize = getPendingResize();
    if (pendingResize) {
      scheduleResize(pendingResize);
    }
    recordTerminalResizeQueued(hadScheduledFlush);
    resizeFlushTimer = globalThis.setTimeout(() => {
      resizeFlushTimer = undefined;
      void flushPendingResize();
    }, delayMs);
  }

  function clearResizeFlushTimer(): void {
    if (resizeFlushTimer === undefined) {
      return;
    }

    clearTimeout(resizeFlushTimer);
    resizeFlushTimer = undefined;
  }

  function waitForResizeFlushRetryDelay(): Promise<void> {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, getResizeFlushDelayMs());
    });
  }

  function isAlternateBufferActive(): boolean {
    return options.term.buffer?.active?.type === 'alternate';
  }

  function getResizeFlushDelayMs(): number {
    return isAlternateBufferActive()
      ? ALTERNATE_BUFFER_RESIZE_FLUSH_DELAY_MS
      : RESIZE_FLUSH_DELAY_MS;
  }

  function canCommitResizeNow(): boolean {
    return options.shouldCommitResize?.() !== false;
  }

  function canRetainPendingResizeAfterFlight(): boolean {
    return !options.isDisposed() && !options.isSpawnFailed() && !options.isProcessExited();
  }

  async function flushPendingResize(forceRecoveryAlignmentCommit = false): Promise<void> {
    recordTerminalResizeFlush();
    const pendingResize = getPendingResize();
    if (!pendingResize) {
      await (inFlightResizeCommitPromise ?? Promise.resolve());
      return;
    }
    if (isSameResizeGeometry(pendingResize, getInFlightResize())) {
      clearDuplicatePendingResize();
      recordTerminalResizeCommitNoopSkip();
      await (inFlightResizeCommitPromise ?? Promise.resolve());
      return;
    }
    if (resizeState.kind === 'sending') {
      recordTerminalResizeCommitDeferred('in-flight');
      await (inFlightResizeCommitPromise ?? Promise.resolve());
      return;
    }
    if (options.isDisposed() || options.isSpawnFailed() || options.isProcessExited()) {
      clearPendingResize();
      return;
    }
    if (options.isRestoreBlocked() && !forceRecoveryAlignmentCommit) {
      recordTerminalResizeCommitDeferred('restore-blocked');
      deferResize(pendingResize, 'restore-blocked');
      scheduleResizeFlush(getResizeFlushDelayMs());
      return;
    }
    if (!options.isSpawnReady() && !options.isSpawnFailed() && !options.isDisposed()) {
      recordTerminalResizeCommitDeferred('spawn-pending');
      deferResize(pendingResize, 'spawn-pending');
      scheduleResizeFlush(getResizeFlushDelayMs());
      return;
    }
    if (!canCommitResizeNow() && !forceRecoveryAlignmentCommit) {
      recordTerminalResizeCommitDeferred('not-live');
      deferResize(pendingResize, 'not-live');
      return;
    }

    const { cols, rows } = pendingResize;
    const controller = getTaskCommandController(taskId);
    if (controller && controller.controllerId !== runtimeClientId) {
      recordTerminalResizeCommitDeferred('peer-controlled');
      preserveResizeForPeerControl(pendingResize);
      return;
    }

    if (hasLastSentResizeGeometry(cols, rows)) {
      clearPendingResize();
      if (hasPeerDeferredResizeGeometry(cols, rows)) {
        peerDeferredResize = null;
      }
      recordTerminalResizeCommitNoopSkip();
      notifyResizeCommitted({ cols, rows });
      return;
    }

    if (!inputLeaseSession.touch()) {
      if (!controller || controller.controllerId !== runtimeClientId) {
        recordTerminalResizeCommitDeferred('not-live');
        setResizeIdle();
        return;
      }

      const leaseAcquired = await ensureInputLease();
      if (!leaseAcquired) {
        if (!hasTaskCommandLeaseTransportAvailability()) {
          deferResize(pendingResize, 'not-live');
          scheduleResizeFlush(getResizeFlushDelayMs());
          return;
        }

        recordTerminalResizeCommitDeferred('peer-controlled');
        handleTaskControlLoss();
        return;
      }

      if (getInFlightResize() || !isSameResizeGeometry(getPendingResize(), pendingResize)) {
        await flushPendingResize(forceRecoveryAlignmentCommit);
        return;
      }
    }

    recordTerminalResizeCommitAttempt();
    const requestId = createRandomId();
    const resizeSeq = nextResizeSeq;
    nextResizeSeq += 1;
    const resizeGeneration = resizeLifecycleGeneration;
    setResizeState({
      generation: resizeGeneration,
      inFlight: { cols, rows },
      kind: 'sending',
      lastSent: resizeState.lastSent,
      pending: null,
      requestId,
    });
    const commitPromise = invoke(IPC.ResizeAgent, {
      agentId,
      cols,
      controllerId: runtimeClientId,
      requestId,
      resizeEpoch,
      resizeSeq,
      rows,
      taskId,
    })
      .then(() => {
        if (
          resizeGeneration !== resizeLifecycleGeneration ||
          resizeState.kind !== 'sending' ||
          resizeState.requestId !== requestId
        ) {
          return;
        }

        setResizeState({
          ...resizeState,
          lastSent: { cols, rows },
        });
        if (hasPeerDeferredResizeGeometry(cols, rows)) {
          peerDeferredResize = null;
        }
        recordTerminalResizeCommitSuccess();
        notifyResizeCommitted({ cols, rows });
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

        rotateResizeOrderingEpoch();
        if (resizeState.kind === 'sending' && resizeState.requestId === requestId) {
          setResizeState({
            ...resizeState,
            pending: resizeState.pending ?? { cols, rows },
          });
        }
        if (canRetainPendingResizeAfterFlight()) {
          scheduleResizeFlush(getResizeFlushDelayMs());
        }
      })
      .finally(() => {
        const pendingAfterFlight =
          resizeState.kind === 'sending' && resizeState.requestId === requestId
            ? resizeState.pending
            : getPendingResize();
        const shouldDeferPendingAfterFlight =
          canRetainPendingResizeAfterFlight() && pendingAfterFlight !== null;
        if (resizeState.kind === 'sending' && resizeState.requestId === requestId) {
          if (shouldDeferPendingAfterFlight) {
            setResizeState({
              kind: 'deferred',
              lastSent: resizeState.lastSent,
              pending: pendingAfterFlight,
              reason: 'in-flight',
            });
          } else {
            setResizeIdle();
          }
        } else if (shouldDeferPendingAfterFlight) {
          deferResize(pendingAfterFlight, 'in-flight');
        }
        if (shouldDeferPendingAfterFlight) {
          scheduleResizeFlush(getResizeFlushDelayMs());
        }
      });
    inFlightResizeCommitPromise = commitPromise.finally(() => {
      if (inFlightResizeCommitPromise === commitPromise) {
        inFlightResizeCommitPromise = null;
      }
    });
    await commitPromise;
  }

  async function flushPendingResizeAndWait(forceRecoveryAlignmentCommit = false): Promise<void> {
    while (true) {
      await flushPendingResize(forceRecoveryAlignmentCommit);
      if (
        resizeState.kind !== 'deferred' ||
        resizeState.reason !== 'in-flight' ||
        options.isDisposed() ||
        options.isSpawnFailed() ||
        options.isProcessExited()
      ) {
        return;
      }

      clearResizeFlushTimer();
      await waitForResizeFlushRetryDelay();
    }
  }

  return {
    adoptBackendResizeForRecovery(geometry: TerminalGeometry): void {
      clearResizeFlushTimer();
      cancelInFlightResizeRequest();
      peerDeferredResize = null;
      setResizeIdle({ cols: geometry.cols, rows: geometry.rows });
    },
    cleanup(): void {
      flushPendingInput();
      cancelInFlightInputBatch();
      cancelInFlightResizeRequest();
      clearQueuedInputState();
      peerDeferredResize = null;
      clearPendingResize();
      if (inputFlushTimer !== undefined) {
        clearTimeout(inputFlushTimer);
      }
      clearResizeFlushTimer();
      inputLeaseSession.cleanup();
    },
    detectPendingInputTraceEcho,
    drainInputQueue,
    enqueueProgrammaticInput(data: string): void {
      if (data.length > 0) {
        options.onInputActivity?.();
      }
      enqueueInput(data);
    },
    finalizePendingInputTraceEchoes,
    flushPendingResizeForRecoveryAlignment(): Promise<void> {
      ensureCurrentTerminalGeometryResizeScheduled();
      return flushPendingResizeAndWait(true);
    },
    flushPendingInput,
    flushPendingResize(): Promise<void> {
      return flushPendingResizeAndWait(false);
    },
    handleControllerChange(controllerId: string | null): void {
      if (controllerId !== null && controllerId !== runtimeClientId) {
        handleTaskControlLoss();
        return;
      }

      const currentGeometry = getCurrentTerminalGeometry();
      if (!currentGeometry) {
        return;
      }

      const nextResize = peerDeferredResize ?? currentGeometry;
      peerDeferredResize = null;
      scheduleResize(nextResize);
      void flushPendingResize();
    },
    handleTaskControlLoss,
    handleTerminalData,
    handleTerminalResize(cols: number, rows: number): void {
      const nextResize = { cols, rows };
      if (isSameResizeGeometry(getLatestTargetResizeGeometry(), nextResize)) {
        return;
      }

      deferResize(nextResize, 'not-live');
      if (!canCommitResizeNow()) {
        return;
      }
      scheduleResizeFlush(getResizeFlushDelayMs());
    },
    isResizeTransactionPending(): boolean {
      return resizeState.kind !== 'idle';
    },
    recordKeyboardTraceStart(event: KeyboardTraceEventLike): void {
      pendingKeyboardTraceStarts.push({
        event: {
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          key: event.key,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        },
        startedAtMs: getTerminalTraceTimestampMs(),
      });
      while (pendingKeyboardTraceStarts.length > 64) {
        pendingKeyboardTraceStarts.shift();
      }
    },
    requestInputTakeover(): Promise<boolean> {
      return inputLeaseSession.takeOver().then((acquired) => {
        if (!acquired || !isTerminalInputRetryAllowed()) {
          return acquired;
        }

        if (peerDeferredResize) {
          scheduleResize(peerDeferredResize);
          peerDeferredResize = null;
        }
        void flushPendingResize();
        return acquired;
      });
    },
    setNextProgrammaticInputTrace(data: string): void {
      if (!hasTerminalTraceClockAlignment()) {
        return;
      }

      nextProgrammaticInputTrace = {
        inputKind: classifyTerminalInputTraceKind(data),
        startedAtMs: getTerminalTraceTimestampMs(),
      };
    },
  };
}
