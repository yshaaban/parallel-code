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
import { createTaskCommandLeaseSession } from '../../app/task-command-lease';
import { getTaskCommandController } from '../../store/task-command-controllers';
import type { TerminalInputTraceKind } from '../../domain/terminal-input-tracing';
import type { TerminalViewProps } from './types';
import {
  DEFAULT_MAX_PENDING_CHARS,
  getTerminalInputBatchPlan,
  hasImmediateFlushTerminalInput,
  mergePendingInputCharLimit,
  splitTerminalInputChunks,
  takeQueuedTerminalInputBatch,
} from '../../lib/terminal-input-batching';

const INPUT_RETRY_DELAY_MS = 50;
const RESIZE_FLUSH_DELAY_MS = 33;
const TASK_CONTROLLED_AGENT_ERROR_MESSAGE = 'Task is controlled by another client';
const INPUT_TRACE_OUTPUT_TAIL_MAX_CHARS = 4 * 1024;

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

export interface TerminalInputPipeline {
  cleanup(): void;
  detectPendingInputTraceEcho(chunk: Uint8Array, outputReceivedAtMs: number): void;
  drainInputQueue(): void;
  enqueueProgrammaticInput(data: string): void;
  finalizePendingInputTraceEchoes(outputRenderedAtMs: number): void;
  flushPendingInput(): void;
  flushPendingResize(): void;
  handleControllerChange(controllerId: string | null): void;
  handleTaskControlLoss(): void;
  handleTerminalData(data: string): void;
  handleTerminalResize(cols: number, rows: number): void;
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
  onReadOnlyInputAttempt?: () => void;
  props: TerminalViewProps;
  runtimeClientId: string;
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
  let inFlightInputBatch: InFlightInputBatch | null = null;
  let inputLifecycleGeneration = 0;
  let inputFlushTimer: number | undefined;
  let inputSendInFlight = false;
  let resizeFlushTimer: number | undefined;
  let resizeSendInFlight = false;
  let resizeInFlightRequestId: string | null = null;
  let resizeLifecycleGeneration = 0;
  let pendingResize: { cols: number; rows: number } | null = null;
  let lastSentCols = -1;
  let lastSentRows = -1;
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

  function scheduleInputFlush(delay = 8): void {
    if (options.isDisposed() || inputFlushTimer !== undefined) {
      return;
    }

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

    const combinedText = pendingInputTraceOutputTail + new TextDecoder().decode(chunk);
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

  function sendQueuedInputBatch(batch: InFlightInputBatch): Promise<boolean> {
    const sendStartedAtMs = getTerminalTraceTimestampMs();
    if (batch.inputKind !== 'paste') {
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
      return true;
    });
  }

  function drainInputQueue(): void {
    if (
      options.isDisposed() ||
      options.isSpawnFailed() ||
      options.isProcessExited() ||
      inputSendInFlight ||
      inputQueue.length === 0
    ) {
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

        if (!options.isDisposed() && !options.isSpawnFailed() && !options.isProcessExited()) {
          retryInputDrain();
        }
      })
      .finally(() => {
        inputSendInFlight = false;
        if (!options.isDisposed() && !options.isProcessExited() && inputQueue.length > 0) {
          if (options.isSpawnReady()) {
            drainInputQueue();
          } else {
            retryInputDrain();
          }
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
    if (options.isProcessExited()) {
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

  function handleTerminalData(data: string): void {
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
    if (resizeFlushTimer !== undefined) {
      return;
    }

    resizeFlushTimer = window.setTimeout(() => {
      resizeFlushTimer = undefined;
      flushPendingResize();
    }, delayMs);
  }

  function flushPendingResize(): void {
    if (!pendingResize || resizeSendInFlight) {
      return;
    }
    if (options.isRestoreBlocked()) {
      scheduleResizeFlush();
      return;
    }
    if (!options.isSpawnReady() && !options.isSpawnFailed() && !options.isDisposed()) {
      scheduleResizeFlush();
      return;
    }

    const { cols, rows } = pendingResize;
    const controller = getTaskCommandController(taskId);
    if (controller && controller.controllerId !== runtimeClientId) {
      return;
    }

    pendingResize = null;
    if (cols === lastSentCols && rows === lastSentRows) {
      return;
    }

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
        if (!options.isDisposed() && !options.isSpawnFailed()) {
          scheduleResizeFlush();
        }
      })
      .finally(() => {
        if (resizeInFlightRequestId === requestId) {
          resizeInFlightRequestId = null;
        }
        resizeSendInFlight = false;
        if (!options.isDisposed() && pendingResize) {
          flushPendingResize();
        }
      });
  }

  return {
    cleanup(): void {
      flushPendingInput();
      cancelInFlightInputBatch();
      cancelInFlightResizeRequest();
      clearQueuedInputState();
      flushPendingResize();
      if (inputFlushTimer !== undefined) {
        clearTimeout(inputFlushTimer);
      }
      if (resizeFlushTimer !== undefined) {
        clearTimeout(resizeFlushTimer);
      }
      inputLeaseSession.cleanup();
    },
    detectPendingInputTraceEcho,
    drainInputQueue,
    enqueueProgrammaticInput(data: string): void {
      enqueueInput(data);
    },
    finalizePendingInputTraceEchoes,
    flushPendingInput,
    flushPendingResize,
    handleControllerChange(controllerId: string | null): void {
      if (controllerId !== runtimeClientId) {
        handleTaskControlLoss();
        return;
      }

      if (options.term.cols <= 0 || options.term.rows <= 0) {
        return;
      }

      pendingResize = {
        cols: options.term.cols,
        rows: options.term.rows,
      };
      flushPendingResize();
    },
    handleTaskControlLoss,
    handleTerminalData,
    handleTerminalResize(cols: number, rows: number): void {
      pendingResize = { cols, rows };
      scheduleResizeFlush();
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
          flushPendingResize();
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
