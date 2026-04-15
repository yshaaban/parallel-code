import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import {
  BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE,
  cancelBrowserAgentCommandRequest,
  invoke,
  sendTerminalInput,
  sendTerminalInputTraceUpdate,
} from '../../lib/ipc';
import {
  getTerminalTraceTimestampMs,
  hasTerminalTraceClockAlignment,
  recordInputBuffered,
  recordInputQueued,
  recordInputSent,
} from '../../lib/terminalLatency';
import { stripAnsi } from '../../lib/prompt-detection';
import { noteTerminalFocusedInput } from '../../app/terminal-focused-input';
import { activateTerminalSwitchEchoGrace } from '../../app/terminal-switch-echo-grace';
import {
  createTaskCommandLeaseSession,
  hasTaskCommandLeaseTransportAvailability,
} from '../../app/task-command-lease';
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
  recordTerminalResizeQueued,
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
const MAX_CONCURRENT_INTERACTIVE_INPUT_BATCHES = 3;
const MAX_INITIAL_INTERACTIVE_SEND_BATCH_CHARS = 4;
const RESIZE_FLUSH_DELAY_MS = 48;
const ALTERNATE_BUFFER_RESIZE_FLUSH_DELAY_MS = 120;
const TASK_CONTROLLED_AGENT_ERROR_MESSAGE = 'Task is controlled by another client';
const INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS = 4 * 1024;
const INPUT_TRACE_TEXT_DECODER = new TextDecoder();

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
  status: 'accepted' | 'sending';
  traceEchoText: string | null;
}

interface TerminalGeometry {
  cols: number;
  rows: number;
}

type ResizeCommitDeferReason =
  | 'in-flight'
  | 'not-live'
  | 'peer-controlled'
  | 'restore-blocked'
  | 'spawn-pending';

type TerminalResizeState =
  | { kind: 'idle'; lastSent: TerminalGeometry | null }
  | {
      kind: 'deferred';
      lastSent: TerminalGeometry | null;
      pending: TerminalGeometry;
      reason: ResizeCommitDeferReason;
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
  cleanup(): void;
  detectPendingInputTraceEcho(chunk: Uint8Array, outputReceivedAtMs: number): void;
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
  recordKeyboardTraceStart(): void;
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
  onBlockedInputAttempt?: () => void;
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
  const pendingKeyboardTraceStarts: number[] = [];
  let nextProgrammaticInputTrace: {
    inputKind: TerminalInputTraceKind;
    startedAtMs: number;
  } | null = null;
  const inputQueue: QueuedInputChunk[] = [];
  const inFlightInputBatches: InFlightInputBatch[] = [];
  let inputLifecycleGeneration = 0;
  let inputFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let inputLeaseAcquirePromise: Promise<boolean> | null = null;
  let resizeFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let resizeLifecycleGeneration = 0;
  let resizeState: TerminalResizeState = { kind: 'idle', lastSent: null };
  let inFlightResizeCommitPromise: Promise<void> | null = null;
  let peerDeferredResize: TerminalGeometry | null = null;
  let pendingInputTraceOutputTail = '';
  const pendingInputTraceEchoes = new Map<
    string,
    {
      expectedText: string;
      outputReceivedAtMs: number | null;
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
    inFlightInputBatches.length = 0;
    inputBuffer = '';
    resetPendingInputState();
    pendingKeyboardTraceStarts.length = 0;
    nextProgrammaticInputTrace = null;
    pendingInputTraceEchoes.clear();
    pendingInputTraceOutputTail = '';
    updateInputQueueDiagnostics();
  }

  function resetPendingInputState(): void {
    pendingInput = '';
    pendingInputQueuedAt = -1;
    pendingInputStartedAtMs = -1;
    pendingInputCharLimit = DEFAULT_MAX_PENDING_CHARS;
    pendingInputKind = 'interactive';
  }

  function getBufferedInputChars(): number {
    return (
      pendingInput.length +
      inputQueue.reduce((totalChars, entry) => totalChars + entry.data.length, 0)
    );
  }

  function updateInputQueueDiagnostics(): void {
    if (!isRendererRuntimeDiagnosticsEnabled()) {
      return;
    }

    recordTerminalInputQueueState({
      bufferedChars: getBufferedInputChars(),
      inFlightBatches: inFlightInputBatches.length,
      queuedChunks: inputQueue.length,
    });
  }

  function cancelInFlightInputBatch(): void {
    if (inFlightInputBatches.length === 0) {
      return;
    }

    for (const batch of inFlightInputBatches) {
      cancelBrowserAgentCommandRequest(batch.requestId);
      pendingInputTraceEchoes.delete(batch.requestId);
    }
    inFlightInputBatches.length = 0;
    inputLifecycleGeneration += 1;
    updateInputQueueDiagnostics();
  }

  function cancelInFlightResizeRequest(): void {
    if (resizeState.kind !== 'sending') {
      return;
    }

    cancelBrowserAgentCommandRequest(resizeState.requestId);
    setResizeIdle();
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

  function setResizeState(nextState: TerminalResizeState): void {
    const wasActive = resizeState.kind !== 'idle';
    const isActive = nextState.kind !== 'idle';
    resizeState = nextState;
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

  function deferResize(pending: TerminalGeometry, reason: ResizeCommitDeferReason): void {
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

  function getQueuedInputSendBatchMaxChars(
    queueEntries: readonly QueuedInputChunk[],
    hasInFlightInputBatch: boolean,
  ): number {
    const firstEntry = queueEntries[0];
    if (!firstEntry) {
      return DEFAULT_MAX_PENDING_CHARS;
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

    switch (firstEntry.inputKind) {
      case 'interactive':
      case 'control':
        return MAX_CONCURRENT_INTERACTIVE_INPUT_BATCHES;
      case 'burst':
      case 'paste':
        return MAX_CONCURRENT_INPUT_BATCHES;
    }
  }

  function detectPendingInputTraceEcho(chunk: Uint8Array, outputReceivedAtMs: number): void {
    if (pendingInputTraceEchoes.size === 0) {
      return;
    }

    const combinedText = pendingInputTraceOutputTail + INPUT_TRACE_TEXT_DECODER.decode(chunk);
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
        requestId,
      });
      pendingInputTraceEchoes.delete(requestId);
    }
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
      inputKind: traceSummary.inputKind,
      queuedAt: queuedBatchEntries[0]?.queuedAt ?? 0,
      requestId: crypto.randomUUID(),
      startedAtMs: traceSummary.startedAtMs,
      status: 'sending' as const,
      traceEchoText: getTraceEchoText(nextBatch.batch),
    };
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
      count += batch.count;
    }
    return count;
  }

  function hasUndispatchedInput(): boolean {
    return inputQueue.length > getDispatchedInputCount();
  }

  function hasTrackedResizeGeometry(geometry: TerminalGeometry): boolean {
    return (
      isSameResizeGeometry(getPendingResize(), geometry) ||
      isSameResizeGeometry(getInFlightResize(), geometry) ||
      isSameResizeGeometry(peerDeferredResize, geometry)
    );
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

      inputQueue.splice(0, batch.count);
    }
    updateInputQueueDiagnostics();
  }

  function dropDispatchedInputSuffix(requestId: string): void {
    const batchIndex = inFlightInputBatches.findIndex((batch) => batch.requestId === requestId);
    if (batchIndex < 0) {
      return;
    }

    const droppedBatches = inFlightInputBatches.splice(batchIndex);
    for (const [index, batch] of droppedBatches.entries()) {
      pendingInputTraceEchoes.delete(batch.requestId);
      if (index > 0) {
        cancelBrowserAgentCommandRequest(batch.requestId);
      }
    }
    recordTerminalInputDroppedSuffixBatches(droppedBatches.length);
    updateInputQueueDiagnostics();
  }

  function sendQueuedInputBatch(batch: InFlightInputBatch): Promise<boolean> {
    const sendStartedAtMs = getTerminalTraceTimestampMs();
    if (batch.inputKind !== 'paste') {
      noteTerminalFocusedInput(taskId, agentId);
      activateTerminalSwitchEchoGrace(taskId);
      options.armInteractiveEchoFastPath();
    }
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
      recordTerminalInputBatchSent(batch.batch.length);
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
          dropDispatchedInputSuffix(batch.requestId);
          retryAfterFlight = true;
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
          dropDispatchedInputSuffix(batch.requestId);
          handleTaskControlLoss();
          return;
        }

        dropDispatchedInputSuffix(batch.requestId);
        if (isTerminalInputRetryAllowed()) {
          retryAfterFlight = true;
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
          if (inputQueue.length > 0) {
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
    if (!options.isSpawnReady()) {
      retryInputDrain();
      return;
    }

    const inputGeneration = inputLifecycleGeneration;
    ensureInputLease()
      .then((acquired) => {
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
        if (
          inputGeneration !== inputLifecycleGeneration ||
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

  function flushPendingInput(): void {
    if (inputFlushTimer !== undefined) {
      clearTimeout(inputFlushTimer);
      inputFlushTimer = undefined;
    }
    if (!pendingInput) {
      return;
    }

    recordTerminalInputFlush(false);
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
    resetPendingInputState();
    updateInputQueueDiagnostics();
  }

  function enqueueInput(data: string): void {
    if (options.isProcessExited()) {
      return;
    }

    const plan = getTerminalInputBatchPlan(data);
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
    if (
      plan.flushImmediately ||
      pendingInput.length >= pendingInputCharLimit ||
      (plan.preferImmediateFlushWhenIdle && wasIdle)
    ) {
      flushPendingInput();
      drainInputQueue();
      return;
    }

    recordTerminalInputFlush(true);
    scheduleInputFlush(plan.flushDelayMs);
    updateInputQueueDiagnostics();
  }

  function handleTerminalData(data: string): void {
    if (options.canAcceptInput?.() === false) {
      options.onBlockedInputAttempt?.();
      return;
    }

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

  function flushPendingResize(allowRestoreBlockedCommit = false): Promise<void> {
    recordTerminalResizeFlush();
    const pendingResize = getPendingResize();
    if (!pendingResize || resizeState.kind === 'sending') {
      if (resizeState.kind === 'sending') {
        recordTerminalResizeCommitDeferred('in-flight');
      }
      return inFlightResizeCommitPromise ?? Promise.resolve();
    }
    if (options.isRestoreBlocked() && !allowRestoreBlockedCommit) {
      recordTerminalResizeCommitDeferred('restore-blocked');
      deferResize(pendingResize, 'restore-blocked');
      scheduleResizeFlush(getResizeFlushDelayMs());
      return Promise.resolve();
    }
    if (!options.isSpawnReady() && !options.isSpawnFailed() && !options.isDisposed()) {
      recordTerminalResizeCommitDeferred('spawn-pending');
      deferResize(pendingResize, 'spawn-pending');
      scheduleResizeFlush(getResizeFlushDelayMs());
      return Promise.resolve();
    }
    if (!canCommitResizeNow()) {
      recordTerminalResizeCommitDeferred('not-live');
      deferResize(pendingResize, 'not-live');
      return Promise.resolve();
    }

    const { cols, rows } = pendingResize;
    const controller = getTaskCommandController(taskId);
    if (controller && controller.controllerId !== runtimeClientId) {
      recordTerminalResizeCommitDeferred('peer-controlled');
      preserveResizeForPeerControl(pendingResize);
      return Promise.resolve();
    }

    if (hasLastSentResizeGeometry(cols, rows)) {
      clearPendingResize();
      if (hasPeerDeferredResizeGeometry(cols, rows)) {
        peerDeferredResize = null;
      }
      recordTerminalResizeCommitNoopSkip();
      notifyResizeCommitted({ cols, rows });
      return Promise.resolve();
    }

    if (isSameResizeGeometry(pendingResize, getInFlightResize())) {
      clearPendingResize();
      recordTerminalResizeCommitNoopSkip();
      return Promise.resolve();
    }

    recordTerminalResizeCommitAttempt();
    const requestId = crypto.randomUUID();
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

        if (resizeState.kind === 'sending' && resizeState.requestId === requestId) {
          setResizeState({
            ...resizeState,
            pending: resizeState.pending ?? { cols, rows },
          });
        }
        if (!options.isDisposed() && !options.isSpawnFailed()) {
          scheduleResizeFlush(getResizeFlushDelayMs());
        }
      })
      .finally(() => {
        const pendingAfterFlight =
          resizeState.kind === 'sending' && resizeState.requestId === requestId
            ? resizeState.pending
            : getPendingResize();
        if (resizeState.kind === 'sending' && resizeState.requestId === requestId) {
          setResizeIdle();
        }
        if (!options.isDisposed() && pendingAfterFlight) {
          deferResize(pendingAfterFlight, 'in-flight');
          scheduleResizeFlush(getResizeFlushDelayMs());
        }
      });
    inFlightResizeCommitPromise = commitPromise.finally(() => {
      if (inFlightResizeCommitPromise === commitPromise) {
        inFlightResizeCommitPromise = null;
      }
    });
    return commitPromise;
  }

  async function flushPendingResizeAndWait(allowRestoreBlockedCommit = false): Promise<void> {
    while (true) {
      await flushPendingResize(allowRestoreBlockedCommit);
      if (
        resizeState.kind !== 'deferred' ||
        resizeState.reason !== 'in-flight' ||
        options.isDisposed()
      ) {
        return;
      }

      clearResizeFlushTimer();
    }
  }

  return {
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
      if (controllerId === null) {
        return;
      }

      if (controllerId !== runtimeClientId) {
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
      if (hasLastSentResizeGeometry(cols, rows)) {
        return;
      }

      const nextResize = { cols, rows };
      if (hasTrackedResizeGeometry(nextResize)) {
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
    recordKeyboardTraceStart(): void {
      pendingKeyboardTraceStarts.push(getTerminalTraceTimestampMs());
      while (pendingKeyboardTraceStarts.length > 64) {
        pendingKeyboardTraceStarts.shift();
      }
    },
    requestInputTakeover(): Promise<boolean> {
      return inputLeaseSession.takeOver().then((acquired) => {
        if (acquired) {
          if (peerDeferredResize) {
            scheduleResize(peerDeferredResize);
            peerDeferredResize = null;
          }
          void flushPendingResize();
        }
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
