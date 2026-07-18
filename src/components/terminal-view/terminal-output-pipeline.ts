import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import {
  detectRenderedProbeInOutput,
  getTerminalTraceTimestampMs,
  hasPendingProbeRenders,
  recordFlowRequest,
  recordOutputWritten,
} from '../../lib/terminalLatency';
import { createTerminalRedrawControlTracker } from '../../lib/terminal-output-redraw';
import {
  armFocusedTerminalOutputPreemption,
  registerTerminalOutputCandidate,
} from '../../app/terminal-output-scheduler';
import { isTerminalDenseOverloadActive } from '../../app/terminal-dense-overload';
import { completeTerminalFocusedInputEcho } from '../../app/terminal-focused-input';
import { isTerminalInteractivityCriticalActive } from '../../app/terminal-interactivity-governor';
import { getTerminalFramePressureLevel } from '../../app/terminal-frame-pressure';
import { getVisibleTerminalCount } from '../../app/terminal-visible-set';
import {
  completeTerminalSwitchEchoGrace,
  hasTerminalSwitchEchoGraceReservationForTask,
  isTerminalSwitchEchoGraceActiveForTask,
} from '../../app/terminal-switch-echo-grace';
import { isTerminalSwitchWindowActive } from '../../app/terminal-switch-window';
import {
  recordTerminalOutputRoute,
  recordTerminalOutputSuppressed,
  recordTerminalOutputWrite,
  recordTerminalOutputWriteCompletion,
  recordTerminalOutputWriteFinalization,
  type TerminalOutputRoute,
  type TerminalOutputWriteShape,
} from '../../lib/terminal-output-diagnostics';
import {
  getTerminalExperimentDenseOverloadPressureWriteBatchLimitScale,
  getTerminalExperimentDenseOverloadWriteBatchLimitOverride,
  getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale,
  getTerminalExperimentSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes,
  getTerminalExperimentWriteBatchLimitOverride,
} from '../../lib/terminal-performance-experiments';
import { createBoundedByteHistory } from '../../lib/bounded-byte-history';
import type { TerminalViewProps } from './types';
import {
  getTerminalStatusFlushDelayMs,
  type TerminalOutputPriority,
} from '../../lib/terminal-output-priority';

const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;
const INPUT_RETRY_DELAY_MS = 50;
const FLOW_CONTROL_RENEW_INTERVAL_MS = 5_000;
const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;
const OUTPUT_DIRECT_WRITE_MAX_BYTES = 1024;
const FOCUSED_OUTPUT_QUEUE_COALESCE_MAX_BYTES = 64 * 1024;
const NON_FOCUSED_VISIBLE_OUTPUT_QUEUE_COALESCE_MAX_BYTES = 256 * 1024;
const HIDDEN_OUTPUT_QUEUE_COALESCE_MAX_BYTES = 256 * 1024;
const FOCUSED_OUTPUT_BURST_COALESCE_MS = 16;
const FOCUSED_OUTPUT_BURST_COALESCE_MIN_BYTES = 16 * 1024;
const FOCUSED_REDRAW_BURST_COALESCE_MS = 16;
const NON_FOCUSED_VISIBLE_BURST_COALESCE_MS = 3;
const NON_FOCUSED_VISIBLE_BURST_COALESCE_MAX_BYTES = 4 * 1024;
const INTERACTIVE_ECHO_IMMEDIATE_DRAIN_MAX_BYTES = 8 * 1024;
const INTERACTIVE_ECHO_FAST_PATH_WINDOW_MS = 180;
const INTERACTIVE_ECHO_SPLIT_MAX_QUEUED_BYTES = 256;
const INTERACTIVE_ECHO_SPLIT_MAX_QUEUED_CHUNKS = 4;
const FOCUSED_QUEUED_STATUS_FLUSH_DELAY_MS = 24;
const FOCUSED_PRE_INPUT_WRITE_BATCH_LIMIT_BYTES = 64 * 1024;
const FOCUSED_QUEUED_WRITE_PACING_FALLBACK_MS = 100;
const FOCUSED_STARTUP_QUEUED_STATUS_FLUSH_DELAY_MS = 40;
const TYPING_CRITICAL_STATUS_FLUSH_DELAY_MS = 360;
const RESTORE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const PROBE_TEXT_DECODER = new TextDecoder();

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
  getRecoveryRequestState(maxTailBytes?: number): {
    outputCursor: number;
    renderedTail: Uint8Array | null;
  };
  getRenderedOutputCursor(): number;
  getRenderedOutputHistory(): Uint8Array;
  hasSuppressedOutputSinceHibernation(): boolean;
  hasPendingFlowTransitions(): boolean;
  hasQueuedOutput(): boolean;
  hasQueuedOutputBytes(): boolean;
  hasWriteInFlight(): boolean;
  recoverFlowControlIfIdle(): void;
  scheduleOutputFlush(): void;
  setRenderHibernating(isHibernating: boolean): void;
  setRenderedOutputCursor(cursor: number): void;
  setRenderedOutputHistory(history: Uint8Array): void;
  updateOutputPriority(): void;
}

interface TerminalOutputWriter {
  write: (chunk: Uint8Array, callback: () => void) => void;
}

interface CreateTerminalOutputPipelineOptions {
  agentId: string;
  canFlushOutput: () => boolean;
  channelId: string;
  getOutputPriority: () => TerminalOutputPriority;
  hasObservedLocalInput: () => boolean;
  isDisposed: () => boolean;
  isSpawnFailed: () => boolean;
  markTerminalReady: () => void;
  onChunkRendered: (
    outputRenderedAtMs: number,
    renderedOutputCursor: number,
    byteLength: number,
  ) => void;
  onQueueEmpty: () => void;
  props: TerminalViewProps;
  taskId: string;
  term: TerminalOutputWriter;
}

type TerminalFlowControlState =
  | { kind: 'clear' }
  | { kind: 'pause-requested' }
  | { kind: 'paused' }
  | { allowRecoveryWhenIdle: boolean; kind: 'resume-requested' };

export function createTerminalOutputPipeline(
  options: CreateTerminalOutputPipelineOptions,
): TerminalOutputPipeline {
  const { agentId, props, taskId, term } = options;
  const redrawControlTracker = createTerminalRedrawControlTracker();

  let outputQueue: Uint8Array[] = [];
  let outputQueueHead = 0;
  let outputQueuedBytes = 0;
  let outputQueueFirstReceiveTs = 0;
  let outputWriteInFlight = false;
  let hasCompletedInitialQueueDrain = false;
  let outputWriteWatchdog: number | undefined;
  let backgroundStatusDispatchTimer: number | undefined;
  let pendingBackgroundStatusPayload: Uint8Array | null = null;
  let focusedBurstFlushTimer: number | undefined;
  let focusedRedrawFlushTimer: number | undefined;
  let focusedQueuedWritePacingFrame: number | undefined;
  let focusedQueuedWritePacingFallbackTimer: number | undefined;
  let focusedInteractiveEchoQueuedBypassUsed = false;
  let nonFocusedVisibleFlushTimer: number | undefined;
  let lastBackgroundStatusDispatchAt = 0;
  let outputRegistration: ReturnType<typeof registerTerminalOutputCandidate> | undefined;
  let queuedRedrawControlPending = false;
  let queuedRedrawControlSinceDrainStart = false;
  let watermark = 0;
  let suppressedWatermark = 0;
  let flowControlState: TerminalFlowControlState = { kind: 'clear' };
  let flowRetryTimer: number | undefined;
  let flowRenewTimer: number | undefined;
  let recentInteractiveEchoDeadlineAt = -1;
  let renderedOutputCursor = 0;
  let renderHibernating = false;
  let suppressedOutputSinceHibernation = false;
  let cleanedUp = false;
  const renderedOutputHistory = createBoundedByteHistory(RESTORE_HISTORY_MAX_BYTES);

  function isPipelineDisposed(): boolean {
    return cleanedUp || options.isDisposed();
  }

  function getOutputPriority(): TerminalOutputPriority {
    return options.getOutputPriority();
  }

  function getStatusPayload(chunk: Uint8Array): Uint8Array {
    if (
      chunk.length <= STATUS_ANALYSIS_MAX_BYTES &&
      chunk.byteOffset === 0 &&
      chunk.byteLength === chunk.buffer.byteLength
    ) {
      return chunk;
    }

    return copyStatusPayloadTail(chunk);
  }

  function copyStatusPayloadTail(payload: Uint8Array): Uint8Array {
    const tail = payload.subarray(Math.max(0, payload.length - STATUS_ANALYSIS_MAX_BYTES));
    const copy = new Uint8Array(tail.length);
    copy.set(tail);
    return copy;
  }

  function isFocusedOutputPriority(): boolean {
    return getOutputPriority() === 'focused';
  }

  function isFocusedRedrawControlChunk(containsRedrawControlSequence: boolean): boolean {
    return isFocusedOutputPriority() && containsRedrawControlSequence;
  }

  function shouldUseDirectOutputWrite(
    chunk: Uint8Array,
    containsRedrawControlSequence: boolean,
  ): boolean {
    return (
      isFocusedOutputPriority() &&
      chunk.length < OUTPUT_DIRECT_WRITE_MAX_BYTES &&
      !containsRedrawControlSequence
    );
  }

  function hasRecentInteractiveEchoPriority(): boolean {
    return isFocusedOutputPriority() && performance.now() <= recentInteractiveEchoDeadlineAt;
  }

  function maybePauseFlowControl(): void {
    if (getFlowControlWatermark() > FLOW_HIGH && !isFlowPauseApplied()) {
      requestPtyPause();
    }
  }

  function handleRenderHibernatingOutput(chunk: Uint8Array): void {
    const statusPayload = getStatusPayload(chunk);
    const priority = getOutputPriority();
    const deferSuppressedStatusPayload =
      priority !== 'focused' &&
      priority !== 'switch-target-visible' &&
      isTerminalInteractivityCriticalActive();

    suppressedOutputSinceHibernation = true;
    suppressedWatermark += chunk.length;

    recordTerminalOutputSuppressed({
      agentId,
      chunkLength: chunk.length,
      priority,
      taskId,
    });

    if (deferSuppressedStatusPayload) {
      bufferLatestStatusPayload(statusPayload);
    } else {
      dispatchStatusPayload(statusPayload);
    }

    maybePauseFlowControl();
  }

  function armInteractiveEchoFastPath(): void {
    recentInteractiveEchoDeadlineAt = performance.now() + INTERACTIVE_ECHO_FAST_PATH_WINDOW_MS;
    armFocusedTerminalOutputPreemption();
    recoverFlowControlIfIdle();
  }

  function shouldDrainQueuedInteractiveEchoImmediately(): boolean {
    if (!hasRecentInteractiveEchoPriority()) {
      return false;
    }

    return outputQueuedBytes > 0 && outputQueuedBytes <= INTERACTIVE_ECHO_IMMEDIATE_DRAIN_MAX_BYTES;
  }

  function shouldPreserveInteractiveEchoChunkSplit(
    containsRedrawControlSequence: boolean,
  ): boolean {
    return (
      !containsRedrawControlSequence &&
      hasRecentInteractiveEchoPriority() &&
      outputQueuedBytes < INTERACTIVE_ECHO_SPLIT_MAX_QUEUED_BYTES &&
      getQueuedOutputChunkCount() < INTERACTIVE_ECHO_SPLIT_MAX_QUEUED_CHUNKS
    );
  }

  function clearBackgroundStatusDispatch(): void {
    if (backgroundStatusDispatchTimer === undefined) {
      return;
    }

    clearTimeout(backgroundStatusDispatchTimer);
    backgroundStatusDispatchTimer = undefined;
  }

  function clearFocusedRedrawFlushTimer(): void {
    if (focusedRedrawFlushTimer === undefined) {
      return;
    }

    clearTimeout(focusedRedrawFlushTimer);
    focusedRedrawFlushTimer = undefined;
  }

  function clearFocusedBurstFlushTimer(): void {
    if (focusedBurstFlushTimer === undefined) {
      return;
    }

    clearTimeout(focusedBurstFlushTimer);
    focusedBurstFlushTimer = undefined;
  }

  function clearFocusedQueuedWritePacing(): void {
    focusedInteractiveEchoQueuedBypassUsed = false;
    if (focusedQueuedWritePacingFrame !== undefined) {
      cancelAnimationFrame(focusedQueuedWritePacingFrame);
      focusedQueuedWritePacingFrame = undefined;
    }

    if (focusedQueuedWritePacingFallbackTimer !== undefined) {
      clearTimeout(focusedQueuedWritePacingFallbackTimer);
      focusedQueuedWritePacingFallbackTimer = undefined;
    }
  }

  function clearNonFocusedVisibleFlushTimer(): void {
    if (nonFocusedVisibleFlushTimer === undefined) {
      return;
    }

    clearTimeout(nonFocusedVisibleFlushTimer);
    nonFocusedVisibleFlushTimer = undefined;
  }

  function clearQueuedOutputFlushTimers(): void {
    clearFocusedRedrawFlushTimer();
    clearFocusedBurstFlushTimer();
    clearFocusedQueuedWritePacing();
    clearNonFocusedVisibleFlushTimer();
  }

  function resetQueuedRedrawControlState(): void {
    queuedRedrawControlPending = false;
    queuedRedrawControlSinceDrainStart = false;
  }

  function requestScheduledOutputFlush(): void {
    clearFocusedBurstFlushTimer();
    outputRegistration?.requestDrain();
  }

  function shouldDelayFocusedBurstFlushFromIdle(
    wasQueueEmpty: boolean,
    containsRedrawControlSequence: boolean,
  ): boolean {
    return (
      wasQueueEmpty &&
      isFocusedOutputPriority() &&
      !containsRedrawControlSequence &&
      !outputWriteInFlight &&
      !hasRecentInteractiveEchoPriority() &&
      !isTerminalSwitchEchoGraceActiveForTask(taskId) &&
      outputQueuedBytes >= FOCUSED_OUTPUT_BURST_COALESCE_MIN_BYTES
    );
  }

  function scheduleFocusedBurstFlushFromIdle(): void {
    if (focusedBurstFlushTimer !== undefined) {
      return;
    }

    focusedBurstFlushTimer = window.setTimeout(() => {
      focusedBurstFlushTimer = undefined;
      if (!options.canFlushOutput() || outputQueuedBytes === 0) {
        return;
      }

      requestScheduledOutputFlush();
    }, FOCUSED_OUTPUT_BURST_COALESCE_MS);
  }

  function shouldUseFocusedPreInputQueuedOutputPolicy(): boolean {
    return (
      isFocusedOutputPriority() &&
      !hasCompletedInitialQueueDrain &&
      !queuedRedrawControlPending &&
      !queuedRedrawControlSinceDrainStart &&
      !hasRecentInteractiveEchoPriority() &&
      !isTerminalSwitchEchoGraceActiveForTask(taskId) &&
      !options.hasObservedLocalInput()
    );
  }

  function shouldPaceFocusedQueuedWrites(): boolean {
    return isFocusedOutputPriority() && !isTerminalSwitchEchoGraceActiveForTask(taskId);
  }

  function tryDrainQueuedInteractiveEchoImmediately(): boolean {
    if (focusedInteractiveEchoQueuedBypassUsed || !shouldDrainQueuedInteractiveEchoImmediately()) {
      return false;
    }

    focusedInteractiveEchoQueuedBypassUsed = true;
    if (flushNextQueuedInteractiveEchoChunk()) {
      return true;
    }

    focusedInteractiveEchoQueuedBypassUsed = false;
    return false;
  }

  function isFocusedQueuedWritePacingPending(): boolean {
    return (
      focusedQueuedWritePacingFrame !== undefined ||
      focusedQueuedWritePacingFallbackTimer !== undefined
    );
  }

  function releaseFocusedQueuedWritePacing(): void {
    clearFocusedQueuedWritePacing();
    if (
      isPipelineDisposed() ||
      !shouldPaceFocusedQueuedWrites() ||
      outputWriteInFlight ||
      !options.canFlushOutput() ||
      !hasQueuedOutput()
    ) {
      return;
    }

    if (tryDrainQueuedInteractiveEchoImmediately()) {
      return;
    }

    requestScheduledOutputFlush();
  }

  function scheduleFocusedQueuedWritePacing(): void {
    if (!shouldPaceFocusedQueuedWrites() || isFocusedQueuedWritePacingPending()) {
      return;
    }

    focusedQueuedWritePacingFrame = requestAnimationFrame(releaseFocusedQueuedWritePacing);
    focusedQueuedWritePacingFallbackTimer = window.setTimeout(
      releaseFocusedQueuedWritePacing,
      FOCUSED_QUEUED_WRITE_PACING_FALLBACK_MS,
    );
  }

  function canDrainQueuedOutputNow(): boolean {
    return (
      !outputWriteInFlight &&
      (!shouldPaceFocusedQueuedWrites() || !isFocusedQueuedWritePacingPending())
    );
  }

  function shouldUseNonFocusedVisibleBurstCoalescing(): boolean {
    const priority = options.getOutputPriority();
    return (
      priority === 'visible-background' &&
      getVisibleTerminalCount() >= 3 &&
      !isTerminalSwitchWindowActive()
    );
  }

  function scheduleQueuedOutputFlush(): void {
    if (queuedRedrawControlPending && isFocusedOutputPriority()) {
      clearNonFocusedVisibleFlushTimer();
      if (focusedRedrawFlushTimer !== undefined) {
        return;
      }

      focusedRedrawFlushTimer = window.setTimeout(() => {
        focusedRedrawFlushTimer = undefined;
        if (!options.canFlushOutput() || outputQueuedBytes === 0) {
          return;
        }

        requestScheduledOutputFlush();
      }, FOCUSED_REDRAW_BURST_COALESCE_MS);
      return;
    }

    if (
      shouldUseNonFocusedVisibleBurstCoalescing() &&
      outputQueuedBytes > 0 &&
      outputQueuedBytes <= NON_FOCUSED_VISIBLE_BURST_COALESCE_MAX_BYTES &&
      !outputWriteInFlight
    ) {
      clearFocusedRedrawFlushTimer();
      if (nonFocusedVisibleFlushTimer !== undefined) {
        return;
      }

      nonFocusedVisibleFlushTimer = window.setTimeout(() => {
        nonFocusedVisibleFlushTimer = undefined;
        if (!options.canFlushOutput() || outputQueuedBytes === 0) {
          return;
        }

        requestScheduledOutputFlush();
      }, NON_FOCUSED_VISIBLE_BURST_COALESCE_MS);
      return;
    }

    clearNonFocusedVisibleFlushTimer();
    requestScheduledOutputFlush();
  }

  function recordOutputRoute(route: TerminalOutputRoute, chunkLength: number): void {
    recordTerminalOutputRoute({
      agentId,
      chunkLength,
      priority: options.getOutputPriority(),
      route,
      taskId,
    });
  }

  function getConfiguredWriteBatchLimitBytes(
    priority: TerminalOutputPriority,
    visibleTerminalCount: number,
    denseOverloadActive: boolean,
    maxBytes: number,
  ): number {
    if (denseOverloadActive) {
      const denseOverloadOverride = getTerminalExperimentDenseOverloadWriteBatchLimitOverride(
        priority,
        visibleTerminalCount,
      );
      if (denseOverloadOverride !== null) {
        return denseOverloadOverride;
      }
    }

    return getTerminalExperimentWriteBatchLimitOverride(priority, visibleTerminalCount) ?? maxBytes;
  }

  function getDenseOverloadPressureScale(
    priority: TerminalOutputPriority,
    visibleTerminalCount: number,
    denseOverloadActive: boolean,
    pressureLevel: ReturnType<typeof getTerminalFramePressureLevel>,
  ): number | null {
    if (!denseOverloadActive) {
      return null;
    }

    return getTerminalExperimentDenseOverloadPressureWriteBatchLimitScale(
      priority,
      visibleTerminalCount,
      pressureLevel,
    );
  }

  function getWriteBatchLimitBytes(maxBytes: number): number {
    const priority = options.getOutputPriority();
    const visibleTerminalCount = getVisibleTerminalCount();
    const denseOverloadActive = isTerminalDenseOverloadActive(visibleTerminalCount);
    const baseWriteBatchLimitBytes = getConfiguredWriteBatchLimitBytes(
      priority,
      visibleTerminalCount,
      denseOverloadActive,
      maxBytes,
    );
    const pressureLevel = getTerminalFramePressureLevel();
    const visiblePressureScale = getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
      priority,
      visibleTerminalCount,
      pressureLevel,
    );
    const denseOverloadPressureScale = getDenseOverloadPressureScale(
      priority,
      visibleTerminalCount,
      denseOverloadActive,
      pressureLevel,
    );
    const pressureScale = getCombinedWriteBatchLimitPressureScale(
      visiblePressureScale,
      denseOverloadPressureScale,
    );
    if (pressureScale === null || !Number.isFinite(baseWriteBatchLimitBytes)) {
      return applyFocusedWriteBatchLimitModifiers(
        Math.min(maxBytes, baseWriteBatchLimitBytes),
        visibleTerminalCount,
      );
    }

    const scaledWriteBatchLimitBytes = Math.max(
      1,
      Math.floor(baseWriteBatchLimitBytes * pressureScale),
    );
    return applyFocusedWriteBatchLimitModifiers(
      Math.min(maxBytes, scaledWriteBatchLimitBytes),
      visibleTerminalCount,
    );
  }

  function applyFocusedWriteBatchLimitModifiers(
    batchLimitBytes: number,
    visibleTerminalCount: number,
  ): number {
    const switchEchoGraceBatchLimitBytes = getSwitchEchoGraceFocusedWriteBatchLimitBytes(
      batchLimitBytes,
      visibleTerminalCount,
    );
    return getFocusedPreInputWriteBatchLimitBytes(switchEchoGraceBatchLimitBytes);
  }

  function getFocusedPreInputWriteBatchLimitBytes(batchLimitBytes: number): number {
    if (!shouldUseFocusedPreInputQueuedOutputPolicy()) {
      return batchLimitBytes;
    }

    return Math.min(batchLimitBytes, FOCUSED_PRE_INPUT_WRITE_BATCH_LIMIT_BYTES);
  }

  function getCombinedWriteBatchLimitPressureScale(
    baseScale: number | null,
    denseOverloadScale: number | null,
  ): number | null {
    if (baseScale === null) {
      return denseOverloadScale;
    }

    if (denseOverloadScale === null) {
      return baseScale;
    }

    return baseScale * denseOverloadScale;
  }

  function getSwitchEchoGraceFocusedWriteBatchLimitBytes(
    batchLimitBytes: number,
    visibleTerminalCount: number,
  ): number {
    if (!isFocusedOutputPriority() || !hasTerminalSwitchEchoGraceReservationForTask(taskId)) {
      return batchLimitBytes;
    }

    const graceWriteBatchLimitBytes =
      getTerminalExperimentSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes(
        visibleTerminalCount,
      );
    if (graceWriteBatchLimitBytes === null) {
      return batchLimitBytes;
    }

    return Math.min(batchLimitBytes, graceWriteBatchLimitBytes);
  }

  function getFocusedQueuedStatusFlushDelayMs(): number {
    const shouldDeferStatusPayload =
      isFocusedOutputPriority() && hasQueuedOutput() && !hasRecentInteractiveEchoPriority();
    if (!shouldDeferStatusPayload) {
      return 0;
    }

    if (!hasCompletedInitialQueueDrain) {
      return FOCUSED_STARTUP_QUEUED_STATUS_FLUSH_DELAY_MS;
    }

    return FOCUSED_QUEUED_STATUS_FLUSH_DELAY_MS;
  }

  function mergeStatusPayload(
    previousPayload: Uint8Array | null,
    nextPayload: Uint8Array,
  ): Uint8Array {
    if (!previousPayload || previousPayload.length === 0) {
      return getStatusPayload(nextPayload);
    }

    if (nextPayload.length >= STATUS_ANALYSIS_MAX_BYTES) {
      return copyStatusPayloadTail(nextPayload);
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

  function dispatchStatusPayload(statusPayload: Uint8Array, minimumDelayMs = 0): void {
    if (statusPayload.length === 0) {
      return;
    }

    const delayMs = Math.max(
      getTerminalStatusFlushDelayMs(options.getOutputPriority()),
      minimumDelayMs,
    );
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

  function bufferLatestStatusPayload(statusPayload: Uint8Array): void {
    if (statusPayload.length === 0) {
      return;
    }

    pendingBackgroundStatusPayload = getStatusPayload(statusPayload);
    if (backgroundStatusDispatchTimer !== undefined) {
      return;
    }

    const delayMs = Math.max(
      getTerminalStatusFlushDelayMs(options.getOutputPriority()),
      TYPING_CRITICAL_STATUS_FLUSH_DELAY_MS,
    );
    backgroundStatusDispatchTimer = window.setTimeout(() => {
      backgroundStatusDispatchTimer = undefined;
      lastBackgroundStatusDispatchAt = performance.now();
      const nextPayload = pendingBackgroundStatusPayload;
      pendingBackgroundStatusPayload = null;
      if (nextPayload) {
        props.onData?.(nextPayload);
      }
    }, delayMs);
  }

  function clearOutputWriteWatchdog(): void {
    if (outputWriteWatchdog === undefined) {
      return;
    }

    clearTimeout(outputWriteWatchdog);
    outputWriteWatchdog = undefined;
  }

  function appendRenderedOutputHistory(chunk: Uint8Array): void {
    renderedOutputHistory.append(chunk);
  }

  function setRenderedOutputHistory(history: Uint8Array): void {
    renderedOutputHistory.replace(history);
  }

  function copyQueuedOutputTail(target: Uint8Array, bytesToCopy: number, offset = 0): void {
    if (bytesToCopy <= 0) {
      return;
    }

    let bytesToSkip = Math.max(0, outputQueuedBytes - bytesToCopy);
    let writeOffset = offset;

    for (let index = outputQueueHead; index < outputQueue.length; index += 1) {
      const queuedChunk = outputQueue[index];
      if (!queuedChunk) {
        continue;
      }

      if (bytesToSkip >= queuedChunk.length) {
        bytesToSkip -= queuedChunk.length;
        continue;
      }

      const chunkStart = bytesToSkip;
      bytesToSkip = 0;
      const chunkTail = queuedChunk.subarray(chunkStart);
      target.set(chunkTail, writeOffset);
      writeOffset += chunkTail.length;
    }
  }

  function buildRecoveryRenderedTail(maxBytes = RESTORE_HISTORY_MAX_BYTES): Uint8Array | null {
    if (maxBytes <= 0) {
      return null;
    }

    const cappedMaxBytes = Math.min(maxBytes, RESTORE_HISTORY_MAX_BYTES);
    const renderedHistory = renderedOutputHistory.getTailBytes(cappedMaxBytes);
    if (outputQueuedBytes <= 0) {
      return renderedHistory.length > 0 ? renderedHistory : null;
    }

    const totalBytes = Math.min(renderedHistory.length + outputQueuedBytes, cappedMaxBytes);
    const queuedBytesToKeep = Math.min(outputQueuedBytes, totalBytes);
    const historyBytesToKeep = Math.min(renderedHistory.length, totalBytes - queuedBytesToKeep);
    const combinedTail = new Uint8Array(totalBytes);

    if (historyBytesToKeep > 0) {
      combinedTail.set(renderedHistory.subarray(renderedHistory.length - historyBytesToKeep), 0);
    }

    copyQueuedOutputTail(combinedTail, queuedBytesToKeep, historyBytesToKeep);
    return combinedTail;
  }

  function scheduleFlowRetry(): void {
    if (flowRetryTimer !== undefined || isPipelineDisposed()) {
      return;
    }

    flowRetryTimer = window.setTimeout(() => {
      flowRetryTimer = undefined;
      if (getFlowControlWatermark() > FLOW_HIGH && !isFlowPauseApplied()) {
        requestPtyPause();
      } else if (getFlowControlWatermark() < FLOW_LOW && isFlowPauseApplied()) {
        requestPtyResume();
      }
    }, INPUT_RETRY_DELAY_MS);
  }

  function clearFlowRenewTimer(): void {
    if (flowRenewTimer === undefined) {
      return;
    }

    clearTimeout(flowRenewTimer);
    flowRenewTimer = undefined;
  }

  function shouldRenewFlowPause(): boolean {
    return (
      !isPipelineDisposed() &&
      flowControlState.kind === 'paused' &&
      getFlowControlWatermark() >= FLOW_LOW
    );
  }

  function scheduleFlowRenewal(): void {
    if (flowRenewTimer !== undefined || !shouldRenewFlowPause()) {
      return;
    }

    flowRenewTimer = window.setTimeout(() => {
      flowRenewTimer = undefined;
      if (!shouldRenewFlowPause()) {
        if (getFlowControlWatermark() < FLOW_LOW && isFlowPauseApplied()) {
          requestPtyResume();
        }
        return;
      }

      void invokeFlowControlPause().then(scheduleFlowRenewal, scheduleFlowRenewal);
    }, FLOW_CONTROL_RENEW_INTERVAL_MS);
  }

  function getFlowControlWatermark(): number {
    return watermark + suppressedWatermark;
  }

  function isFlowPauseApplied(): boolean {
    return flowControlState.kind === 'paused' || flowControlState.kind === 'resume-requested';
  }

  function isFlowPauseRequestInFlight(): boolean {
    return flowControlState.kind === 'pause-requested';
  }

  function isFlowResumeRequestInFlight(): boolean {
    return flowControlState.kind === 'resume-requested';
  }

  function setFlowControlState(nextState: TerminalFlowControlState): void {
    flowControlState = nextState;
    if (nextState.kind !== 'paused') {
      clearFlowRenewTimer();
    }
  }

  function invokeFlowControlPause(): ReturnType<typeof invoke> {
    return invoke(IPC.PauseAgent, {
      agentId,
      reason: 'flow-control',
      channelId: options.channelId,
    });
  }

  function invokeFlowControlResume(): ReturnType<typeof invoke> {
    return invoke(IPC.ResumeAgent, {
      agentId,
      reason: 'flow-control',
      channelId: options.channelId,
    });
  }

  function sendFlowControlResumeForCleanup(): void {
    void invokeFlowControlResume().catch(() => undefined);
  }

  function requestPtyPause(): void {
    if (isPipelineDisposed() || isFlowPauseApplied() || isFlowPauseRequestInFlight()) {
      return;
    }

    setFlowControlState({ kind: 'pause-requested' });
    recordFlowRequest('pause');
    void invokeFlowControlPause()
      .then(() => {
        if (isPipelineDisposed()) {
          sendFlowControlResumeForCleanup();
          setFlowControlState({ kind: 'clear' });
          return;
        }

        setFlowControlState({ kind: 'paused' });
        if (getFlowControlWatermark() < FLOW_LOW) {
          requestPtyResume();
          return;
        }

        scheduleFlowRenewal();
      })
      .catch(() => {
        setFlowControlState({ kind: 'clear' });
        if (!isPipelineDisposed()) {
          scheduleFlowRetry();
        }
      })
      .finally(() => {
        if (flowControlState.kind === 'pause-requested') {
          setFlowControlState({ kind: 'clear' });
        }
      });
  }

  function sendFlowControlResumeRequest(allowRecoveryWhenIdle = false): void {
    if (isPipelineDisposed() || isFlowResumeRequestInFlight()) {
      return;
    }
    if (!allowRecoveryWhenIdle && !isFlowPauseApplied()) {
      return;
    }

    setFlowControlState({
      allowRecoveryWhenIdle,
      kind: 'resume-requested',
    });
    recordFlowRequest('resume');
    void invokeFlowControlResume()
      .then(() => {
        setFlowControlState({ kind: 'clear' });
        if (getFlowControlWatermark() > FLOW_HIGH) {
          requestPtyPause();
        }
      })
      .catch(() => {
        if (isPipelineDisposed()) {
          setFlowControlState({ kind: 'clear' });
          return;
        }

        setFlowControlState({ kind: 'paused' });
        scheduleFlowRetry();
      });
  }

  function requestPtyResume(): void {
    sendFlowControlResumeRequest();
  }

  function recoverFlowControlIfIdle(): void {
    if (isPipelineDisposed() || outputQueuedBytes > 0 || getFlowControlWatermark() >= FLOW_LOW) {
      return;
    }

    sendFlowControlResumeRequest(true);
  }

  function resumeFlowControlAfterWatermarkDrop(): void {
    if (getFlowControlWatermark() >= FLOW_LOW || !isFlowPauseApplied()) {
      return;
    }

    requestPtyResume();
  }

  function writeOutputChunk(
    chunk: Uint8Array,
    receiveTs: number,
    source: TerminalOutputRoute,
  ): void {
    outputWriteInFlight = true;
    if (source === 'queued') {
      scheduleFocusedQueuedWritePacing();
    }
    const writeStartedAtMs = performance.now();
    const writePriority = getOutputPriority();
    const queueAgeMs = receiveTs > 0 ? Math.max(0, performance.now() - receiveTs) : undefined;
    recordTerminalOutputWrite({
      agentId,
      chunk,
      priority: writePriority,
      queueAgeMs,
      source,
      taskId,
    });
    let writeCompleted = false;
    const statusPayload = getStatusPayload(chunk);
    const finishWrite = (): void => {
      if (writeCompleted) {
        return;
      }

      writeCompleted = true;
      clearOutputWriteWatchdog();
      outputWriteInFlight = false;
      watermark = Math.max(watermark - chunk.length, 0);

      const finalizationStartedAtMs = performance.now();
      let completedWriteShape: TerminalOutputWriteShape | null = null;
      try {
        completedWriteShape = recordTerminalOutputWriteCompletion({
          agentId,
          durationMs: Math.max(0, finalizationStartedAtMs - writeStartedAtMs),
          priority: writePriority,
          source,
          taskId,
        });
        if (isPipelineDisposed()) {
          return;
        }

        renderedOutputCursor += chunk.length;
        appendRenderedOutputHistory(chunk);
        recordOutputWritten(receiveTs);
        if (hasPendingProbeRenders()) {
          detectRenderedProbeInOutput(PROBE_TEXT_DECODER.decode(chunk));
        }
        options.onChunkRendered(getTerminalTraceTimestampMs(), renderedOutputCursor, chunk.length);
        if (chunk.length > 0) {
          options.markTerminalReady();
          if (isFocusedOutputPriority()) {
            completeTerminalFocusedInputEcho(taskId, agentId);
          }
        }
        if (watermark < FLOW_LOW && isFlowPauseApplied()) {
          requestPtyResume();
        }
        dispatchStatusPayload(statusPayload, getFocusedQueuedStatusFlushDelayMs());
        if (hasQueuedOutput()) {
          if (tryDrainQueuedInteractiveEchoImmediately()) {
            return;
          }

          if (shouldPaceFocusedQueuedWrites()) {
            scheduleFocusedQueuedWritePacing();
            return;
          }

          scheduleQueuedOutputFlush();
          return;
        }

        if (source === 'queued') {
          hasCompletedInitialQueueDrain = true;
        }
        queuedRedrawControlSinceDrainStart = false;
        if (isFocusedOutputPriority() && isTerminalSwitchEchoGraceActiveForTask(taskId)) {
          completeTerminalSwitchEchoGrace(taskId);
        }
        options.onQueueEmpty();
      } finally {
        recordTerminalOutputWriteFinalization({
          agentId,
          durationMs: Math.max(0, performance.now() - finalizationStartedAtMs),
          priority: writePriority,
          shape: completedWriteShape,
          source,
          taskId,
        });
      }
    };

    outputWriteWatchdog = window.setTimeout(finishWrite, OUTPUT_WRITE_CALLBACK_TIMEOUT_MS);
    term.write(chunk, finishWrite);
  }

  function queuePendingOutput(
    chunk: Uint8Array,
    receiveTs: number,
    containsRedrawControlSequence: boolean,
  ): void {
    const wasQueueEmpty = !hasQueuedOutput();
    appendQueuedOutputChunk(chunk, containsRedrawControlSequence);
    if (isFocusedRedrawControlChunk(containsRedrawControlSequence)) {
      queuedRedrawControlPending = true;
    }
    if (containsRedrawControlSequence) {
      queuedRedrawControlSinceDrainStart = true;
    }
    if (receiveTs > 0 && outputQueueFirstReceiveTs === 0) {
      outputQueueFirstReceiveTs = receiveTs;
    }

    if (!options.canFlushOutput()) {
      return;
    }

    if (shouldPaceFocusedQueuedWrites() && isFocusedQueuedWritePacingPending()) {
      return;
    }

    if (shouldDelayFocusedBurstFlushFromIdle(wasQueueEmpty, containsRedrawControlSequence)) {
      scheduleFocusedBurstFlushFromIdle();
      return;
    }

    if (focusedBurstFlushTimer !== undefined) {
      return;
    }

    scheduleQueuedOutputFlush();
  }

  function appendQueuedOutputChunk(
    chunk: Uint8Array,
    containsRedrawControlSequence: boolean,
  ): void {
    const coalesceMaxBytes = getOutputQueueCoalesceMaxBytes();
    if (
      !containsRedrawControlSequence &&
      !shouldPreserveInteractiveEchoChunkSplit(containsRedrawControlSequence)
    ) {
      const lastChunkIndex = outputQueue.length - 1;
      const lastChunk = outputQueue[lastChunkIndex];
      if (
        lastChunk &&
        lastChunk.length + chunk.length <= coalesceMaxBytes &&
        lastChunk.length > 0
      ) {
        const mergedChunk = new Uint8Array(lastChunk.length + chunk.length);
        mergedChunk.set(lastChunk, 0);
        mergedChunk.set(chunk, lastChunk.length);
        outputQueue[lastChunkIndex] = mergedChunk;
        outputQueuedBytes += chunk.length;
        return;
      }
    }

    outputQueue.push(chunk);
    outputQueuedBytes += chunk.length;
  }

  function getOutputQueueCoalesceMaxBytes(): number {
    switch (options.getOutputPriority()) {
      case 'focused':
      case 'switch-target-visible':
        return FOCUSED_OUTPUT_QUEUE_COALESCE_MAX_BYTES;
      case 'active-visible':
      case 'visible-background':
        return NON_FOCUSED_VISIBLE_OUTPUT_QUEUE_COALESCE_MAX_BYTES;
      case 'hidden':
        return HIDDEN_OUTPUT_QUEUE_COALESCE_MAX_BYTES;
    }
  }

  function getQueuedOutputChunkCount(): number {
    return outputQueue.length - outputQueueHead;
  }

  function hasQueuedOutput(): boolean {
    return outputQueueHead < outputQueue.length;
  }

  function clearQueuedOutputStorage(): void {
    outputQueue = [];
    outputQueueHead = 0;
  }

  function compactQueuedOutputStorage(): void {
    const activeChunkCount = getQueuedOutputChunkCount();
    if (activeChunkCount === 0) {
      clearQueuedOutputStorage();
      return;
    }

    if (outputQueueHead >= activeChunkCount) {
      outputQueue = outputQueue.slice(outputQueueHead);
      outputQueueHead = 0;
    }
  }

  function takeNextQueuedOutputChunk(): { payload: Uint8Array; receiveTs: number } | null {
    if (!hasQueuedOutput()) {
      return null;
    }

    const nextChunk = outputQueue[outputQueueHead];
    if (!nextChunk) {
      return null;
    }
    outputQueueHead += 1;
    compactQueuedOutputStorage();

    const receiveTs = outputQueueFirstReceiveTs;
    outputQueuedBytes = Math.max(0, outputQueuedBytes - nextChunk.length);
    outputQueueFirstReceiveTs = hasQueuedOutput() ? receiveTs : 0;
    if (!hasQueuedOutput()) {
      resetQueuedRedrawControlState();
    }

    return {
      payload: nextChunk,
      receiveTs,
    };
  }

  function takeOutputQueueSlice(
    maxBytes: number,
  ): { payload: Uint8Array; receiveTs: number } | null {
    if (!hasQueuedOutput() || maxBytes <= 0) {
      return null;
    }

    const receiveTs = outputQueueFirstReceiveTs;
    if (getQueuedOutputChunkCount() === 1) {
      const onlyChunk = outputQueue[outputQueueHead];
      if (!onlyChunk) {
        return null;
      }

      if (onlyChunk.length <= maxBytes) {
        clearQueuedOutputStorage();
        outputQueuedBytes = 0;
        outputQueueFirstReceiveTs = 0;
        resetQueuedRedrawControlState();
        return {
          payload: onlyChunk,
          receiveTs,
        };
      }

      outputQueue[outputQueueHead] = onlyChunk.subarray(maxBytes);
      outputQueuedBytes -= maxBytes;
      return {
        payload: onlyChunk.subarray(0, maxBytes),
        receiveTs,
      };
    }

    const totalBytes = Math.min(outputQueuedBytes, maxBytes);
    const payload = new Uint8Array(totalBytes);
    let payloadOffset = 0;

    while (payloadOffset < totalBytes && hasQueuedOutput()) {
      const nextChunk = outputQueue[outputQueueHead];
      if (!nextChunk) {
        outputQueueHead += 1;
        continue;
      }

      const writableBytes = Math.min(nextChunk.length, totalBytes - payloadOffset);
      payload.set(nextChunk.subarray(0, writableBytes), payloadOffset);
      payloadOffset += writableBytes;

      if (writableBytes === nextChunk.length) {
        outputQueueHead += 1;
      } else {
        outputQueue[outputQueueHead] = nextChunk.subarray(writableBytes);
      }
    }
    compactQueuedOutputStorage();

    outputQueuedBytes = Math.max(0, outputQueuedBytes - payloadOffset);
    outputQueueFirstReceiveTs = hasQueuedOutput() ? receiveTs : 0;
    if (!hasQueuedOutput()) {
      resetQueuedRedrawControlState();
    }
    return {
      payload: payloadOffset === payload.length ? payload : payload.subarray(0, payloadOffset),
      receiveTs,
    };
  }

  function flushOutputQueueSlice(maxBytes: number): number {
    if (!options.canFlushOutput() || outputWriteInFlight || !hasQueuedOutput()) {
      return 0;
    }

    const batch = takeOutputQueueSlice(getWriteBatchLimitBytes(maxBytes));
    if (!batch) {
      return 0;
    }

    queuedRedrawControlPending = false;
    clearFocusedRedrawFlushTimer();
    clearNonFocusedVisibleFlushTimer();
    writeOutputChunk(batch.payload, batch.receiveTs, 'queued');
    return batch.payload.length;
  }

  function flushNextQueuedInteractiveEchoChunk(): boolean {
    if (!options.canFlushOutput() || outputWriteInFlight || !hasQueuedOutput()) {
      return false;
    }

    const batch = takeNextQueuedOutputChunk();
    if (!batch) {
      return false;
    }

    clearFocusedRedrawFlushTimer();
    clearNonFocusedVisibleFlushTimer();
    writeOutputChunk(batch.payload, batch.receiveTs, 'queued');
    return true;
  }

  function flushOutputQueue(): void {
    flushOutputQueueSlice(Number.POSITIVE_INFINITY);
  }

  function scheduleOutputFlush(): void {
    scheduleQueuedOutputFlush();
  }

  function enqueueOutput(chunk: Uint8Array, receiveTs = 0): void {
    if (renderHibernating) {
      handleRenderHibernatingOutput(chunk);
      return;
    }

    const containsRedrawControlSequence = redrawControlTracker.isRedrawControlChunk(chunk);
    watermark += chunk.length;
    maybePauseFlowControl();

    if (
      options.canFlushOutput() &&
      shouldUseDirectOutputWrite(chunk, containsRedrawControlSequence) &&
      !outputWriteInFlight &&
      !hasQueuedOutput()
    ) {
      recordOutputRoute('direct', chunk.length);
      writeOutputChunk(chunk, receiveTs, 'direct');
      return;
    }

    recordOutputRoute('queued', chunk.length);
    queuePendingOutput(chunk, receiveTs, containsRedrawControlSequence);
  }

  function dropQueuedOutputForRecovery(): void {
    const droppedBytes = outputQueuedBytes;
    clearQueuedOutputStorage();
    outputQueuedBytes = 0;
    outputQueueFirstReceiveTs = 0;
    resetQueuedRedrawControlState();
    clearQueuedOutputFlushTimers();
    redrawControlTracker.reset();
    watermark = Math.max(watermark - droppedBytes, 0);
    resumeFlowControlAfterWatermarkDrop();
  }

  outputRegistration = registerTerminalOutputCandidate(
    `${taskId}:${agentId}`,
    taskId,
    getOutputPriority,
    () => outputQueuedBytes,
    (budgetBytes) => flushOutputQueueSlice(budgetBytes),
    canDrainQueuedOutputNow,
  );

  return {
    armInteractiveEchoFastPath,
    appendRenderedOutputHistory,
    cleanup(): void {
      cleanedUp = true;
      clearBackgroundStatusDispatch();
      pendingBackgroundStatusPayload = null;
      outputRegistration?.unregister();
      outputRegistration = undefined;
      clearOutputWriteWatchdog();
      clearQueuedOutputFlushTimers();
      resetQueuedRedrawControlState();
      redrawControlTracker.reset();
      if (flowRetryTimer !== undefined) {
        clearTimeout(flowRetryTimer);
        flowRetryTimer = undefined;
      }
      clearFlowRenewTimer();
      if (isFlowPauseApplied() || isFlowPauseRequestInFlight()) {
        sendFlowControlResumeForCleanup();
        setFlowControlState({ kind: 'clear' });
      }
    },
    clearOutputWriteWatchdog,
    dropQueuedOutputForRecovery,
    enqueueOutput(chunk: Uint8Array, receiveTs = 0): void {
      enqueueOutput(chunk, receiveTs);
    },
    flushOutputQueue,
    flushOutputQueueSlice,
    getRecoveryRequestState(maxTailBytes = RESTORE_HISTORY_MAX_BYTES): {
      outputCursor: number;
      renderedTail: Uint8Array | null;
    } {
      return {
        outputCursor: renderedOutputCursor + outputQueuedBytes,
        renderedTail: buildRecoveryRenderedTail(maxTailBytes),
      };
    },
    getRenderedOutputCursor(): number {
      return renderedOutputCursor;
    },
    getRenderedOutputHistory(): Uint8Array {
      return renderedOutputHistory.getBytes();
    },
    hasPendingFlowTransitions(): boolean {
      return isFlowPauseRequestInFlight() || isFlowResumeRequestInFlight();
    },
    hasSuppressedOutputSinceHibernation(): boolean {
      return suppressedOutputSinceHibernation;
    },
    hasQueuedOutput(): boolean {
      return hasQueuedOutput();
    },
    hasQueuedOutputBytes(): boolean {
      return outputQueuedBytes > 0;
    },
    hasWriteInFlight(): boolean {
      return outputWriteInFlight;
    },
    recoverFlowControlIfIdle,
    scheduleOutputFlush,
    setRenderHibernating(isHibernating: boolean): void {
      if (renderHibernating === isHibernating) {
        return;
      }

      renderHibernating = isHibernating;
      redrawControlTracker.reset();
      clearFocusedRedrawFlushTimer();
      clearNonFocusedVisibleFlushTimer();
      if (isHibernating) {
        suppressedWatermark = 0;
        dropQueuedOutputForRecovery();
        return;
      }

      suppressedWatermark = 0;
      suppressedOutputSinceHibernation = false;
      resumeFlowControlAfterWatermarkDrop();
    },
    setRenderedOutputCursor(cursor: number): void {
      renderedOutputCursor = cursor;
    },
    setRenderedOutputHistory,
    updateOutputPriority(): void {
      if (options.getOutputPriority() !== 'focused') {
        clearFocusedRedrawFlushTimer();
      }
      if (!shouldUseNonFocusedVisibleBurstCoalescing()) {
        clearNonFocusedVisibleFlushTimer();
        if (outputQueuedBytes > 0 && !outputWriteInFlight && options.canFlushOutput()) {
          requestScheduledOutputFlush();
        }
      } else if (outputQueuedBytes > 0 && !outputWriteInFlight) {
        scheduleQueuedOutputFlush();
      }
      outputRegistration?.updatePriority();
    },
  };
}
