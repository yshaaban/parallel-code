import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import {
  getTerminalTraceTimestampMs,
  recordFlowEvent,
  recordOutputWritten,
} from '../../lib/terminalLatency';
import { registerTerminalOutputCandidate } from '../../app/terminal-output-scheduler';
import type { TerminalViewProps } from './types';
import {
  getTerminalStatusFlushDelayMs,
  type TerminalOutputPriority,
} from '../../lib/terminal-output-priority';

const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;
const INPUT_RETRY_DELAY_MS = 50;
const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;
const OUTPUT_DIRECT_WRITE_MAX_BYTES = 1024;
const INTERACTIVE_ECHO_IMMEDIATE_DRAIN_MAX_BYTES = 8 * 1024;
const INTERACTIVE_ECHO_FAST_PATH_WINDOW_MS = 180;
const RESTORE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;

export const FLOW_HIGH = 256 * 1024;
export const FLOW_LOW = 32 * 1024;

export interface TerminalOutputPipeline {
  armInteractiveEchoFastPath(): void;
  appendRenderedOutputHistory(chunk: Uint8Array): void;
  cleanup(): void;
  clearOutputWriteWatchdog(): void;
  dropQueuedOutputForRecovery(): void;
  enqueueOutput(chunk: Uint8Array, receiveTs?: number): void;
  flushOutputQueue(): void;
  flushOutputQueueSlice(maxBytes: number): number;
  getRenderedOutputCursor(): number;
  getRenderedOutputHistory(): Uint8Array;
  hasPendingFlowTransitions(): boolean;
  hasQueuedOutput(): boolean;
  hasQueuedOutputBytes(): boolean;
  hasWriteInFlight(): boolean;
  recoverFlowControlIfIdle(): void;
  scheduleOutputFlush(): void;
  setRenderedOutputCursor(cursor: number): void;
  setRenderedOutputHistory(history: Uint8Array): void;
  updateOutputPriority(): void;
}

interface CreateTerminalOutputPipelineOptions {
  agentId: string;
  canFlushOutput: () => boolean;
  channelId: string;
  getOutputPriority: () => TerminalOutputPriority;
  isDisposed: () => boolean;
  isSpawnFailed: () => boolean;
  markTerminalReady: () => void;
  onChunkRendered: (outputRenderedAtMs: number) => void;
  onQueueEmpty: () => void;
  props: TerminalViewProps;
  taskId: string;
  term: Terminal;
}

export function createTerminalOutputPipeline(
  options: CreateTerminalOutputPipelineOptions,
): TerminalOutputPipeline {
  const { agentId, props, taskId, term } = options;

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
  let recentInteractiveEchoDeadlineAt = 0;
  let renderedOutputCursor = 0;
  let renderedOutputHistory = new Uint8Array(0);

  function shouldUseDirectOutputWrite(chunkLength: number): boolean {
    return options.getOutputPriority() === 'focused' && chunkLength < OUTPUT_DIRECT_WRITE_MAX_BYTES;
  }

  function hasRecentInteractiveEchoPriority(): boolean {
    return (
      options.getOutputPriority() === 'focused' &&
      performance.now() <= recentInteractiveEchoDeadlineAt
    );
  }

  function armInteractiveEchoFastPath(): void {
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

  function dispatchStatusPayload(statusPayload: Uint8Array): void {
    if (statusPayload.length === 0) {
      return;
    }

    const delayMs = getTerminalStatusFlushDelayMs(options.getOutputPriority());
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

  function clearOutputWriteWatchdog(): void {
    if (outputWriteWatchdog === undefined) {
      return;
    }

    clearTimeout(outputWriteWatchdog);
    outputWriteWatchdog = undefined;
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

  function scheduleFlowRetry(): void {
    if (flowRetryTimer !== undefined || options.isDisposed()) {
      return;
    }

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
    if (options.isDisposed() || flowPauseApplied || flowPauseInFlight) {
      return;
    }

    flowPauseInFlight = true;
    recordFlowEvent('pause');
    void invoke(IPC.PauseAgent, { agentId, reason: 'flow-control', channelId: options.channelId })
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
    if (options.isDisposed() || flowResumeInFlight) {
      return;
    }
    if (!allowRecoveryWhenIdle && !flowPauseApplied) {
      return;
    }

    flowResumeInFlight = true;
    recordFlowEvent('resume');
    void invoke(IPC.ResumeAgent, { agentId, reason: 'flow-control', channelId: options.channelId })
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
    if (options.isDisposed() || outputQueuedBytes > 0 || watermark >= FLOW_LOW) {
      return;
    }

    sendFlowControlResumeRequest(true);
  }

  function writeOutputChunk(chunk: Uint8Array, receiveTs: number): void {
    outputWriteInFlight = true;
    let writeCompleted = false;
    const statusPayload =
      chunk.length > STATUS_ANALYSIS_MAX_BYTES
        ? chunk.subarray(chunk.length - STATUS_ANALYSIS_MAX_BYTES)
        : chunk;
    const finishWrite = (): void => {
      if (writeCompleted) {
        return;
      }

      writeCompleted = true;
      clearOutputWriteWatchdog();
      outputWriteInFlight = false;
      watermark = Math.max(watermark - chunk.length, 0);
      renderedOutputCursor += chunk.length;
      appendRenderedOutputHistory(chunk);
      recordOutputWritten(receiveTs);
      options.onChunkRendered(getTerminalTraceTimestampMs());
      if (chunk.length > 0) {
        options.markTerminalReady();
      }
      if (watermark < FLOW_LOW && flowPauseApplied) {
        requestPtyResume();
      }
      if (options.isDisposed()) {
        return;
      }
      dispatchStatusPayload(statusPayload);
      if (outputQueue.length > 0) {
        if (shouldDrainQueuedInteractiveEchoImmediately()) {
          flushOutputQueueSlice(INTERACTIVE_ECHO_IMMEDIATE_DRAIN_MAX_BYTES);
          return;
        }

        scheduleOutputFlush();
        return;
      }

      options.onQueueEmpty();
    };

    outputWriteWatchdog = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
    term.write(chunk, finishWrite);
  }

  function queuePendingOutput(chunk: Uint8Array, receiveTs: number): void {
    outputQueue.push(chunk);
    outputQueuedBytes += chunk.length;
    if (receiveTs > 0 && outputQueueFirstReceiveTs === 0) {
      outputQueueFirstReceiveTs = receiveTs;
    }

    if (!options.canFlushOutput()) {
      return;
    }

    scheduleOutputFlush();
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
    if (!options.canFlushOutput() || outputWriteInFlight || outputQueue.length === 0) {
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
      options.canFlushOutput() &&
      shouldUseDirectOutputWrite(chunk.length) &&
      !outputWriteInFlight &&
      outputQueue.length === 0
    ) {
      writeOutputChunk(chunk, receiveTs);
      return;
    }

    queuePendingOutput(chunk, receiveTs);
  }

  function dropQueuedOutputForRecovery(): void {
    const droppedBytes = outputQueuedBytes;
    outputQueue = [];
    outputQueuedBytes = 0;
    outputQueueFirstReceiveTs = 0;
    watermark = Math.max(watermark - droppedBytes, 0);
  }

  outputRegistration = registerTerminalOutputCandidate(
    `${taskId}:${agentId}`,
    () => options.getOutputPriority(),
    () => outputQueuedBytes,
    (budgetBytes) => flushOutputQueueSlice(budgetBytes),
  );

  return {
    armInteractiveEchoFastPath,
    appendRenderedOutputHistory,
    cleanup(): void {
      clearBackgroundStatusDispatch();
      pendingBackgroundStatusPayload = null;
      outputRegistration?.unregister();
      outputRegistration = undefined;
      clearOutputWriteWatchdog();
      if (flowRetryTimer !== undefined) {
        clearTimeout(flowRetryTimer);
      }
    },
    clearOutputWriteWatchdog,
    dropQueuedOutputForRecovery,
    enqueueOutput(chunk: Uint8Array, receiveTs = 0): void {
      enqueueOutput(chunk, receiveTs);
    },
    flushOutputQueue,
    flushOutputQueueSlice,
    getRenderedOutputCursor(): number {
      return renderedOutputCursor;
    },
    getRenderedOutputHistory(): Uint8Array {
      return renderedOutputHistory;
    },
    hasPendingFlowTransitions(): boolean {
      return flowPauseInFlight || flowResumeInFlight;
    },
    hasQueuedOutput(): boolean {
      return outputQueue.length > 0;
    },
    hasQueuedOutputBytes(): boolean {
      return outputQueuedBytes > 0;
    },
    hasWriteInFlight(): boolean {
      return outputWriteInFlight;
    },
    recoverFlowControlIfIdle,
    scheduleOutputFlush,
    setRenderedOutputCursor(cursor: number): void {
      renderedOutputCursor = cursor;
    },
    setRenderedOutputHistory,
    updateOutputPriority(): void {
      outputRegistration?.updatePriority();
    },
  };
}
