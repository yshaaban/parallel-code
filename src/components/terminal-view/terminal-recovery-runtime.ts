import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import { assertNever } from '../../lib/assert-never';
import type { BrowserControlConnectionState } from '../../lib/browser-control-client';
import {
  recordTerminalRecoveryApply,
  recordTerminalRecoveryRenderRefresh,
  recordTerminalRecoveryRequest,
  recordTerminalRecoveryReset,
  recordTerminalRecoveryStableRevealWait,
  recordTerminalRecoveryVisibleSteadyStateSnapshot,
} from '../../app/runtime-diagnostics';
import {
  requestAttachTerminalRecovery,
  requestReconnectTerminalRecovery,
  requestTerminalRecovery,
} from '../../lib/scrollbackRestore';
import type { TerminalRecoveryBatchEntry } from '../../ipc/types';
import type { TerminalViewStatus } from './types';
import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';
import type { TerminalOutputPipeline } from './terminal-output-pipeline';
import type { TerminalInputPipeline } from './terminal-input-pipeline';

const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

const OUTPUT_WRITE_CALLBACK_TIMEOUT_MS = 2_000;
const POST_RECOVERY_OUTPUT_DRAIN_TIMEOUT_MS = 500;
// Larger replay chunks materially reduce startup replay/apply time without changing recovery truth.
const RESTORE_CHUNK_BYTES_BY_PRIORITY = {
  'active-visible': 256 * 1024,
  focused: 256 * 1024,
  hidden: 64 * 1024,
  'switch-target-visible': 256 * 1024,
  'visible-background': 128 * 1024,
} as const;
const ATTACH_RESTORE_CHUNK_BYTES_BY_PRIORITY = {
  'active-visible': 1024 * 1024,
  focused: 1024 * 1024,
  hidden: 64 * 1024,
  'switch-target-visible': 1024 * 1024,
  'visible-background': 256 * 1024,
} as const;
const POST_RECOVERY_REVEAL_SETTLE_MS = 32;

interface TerminalReplayTraceEntry {
  agentId: string;
  applyMs: number;
  chunkCount: number;
  outputPriority: TerminalOutputPriority;
  pauseMs: number;
  reason: 'attach' | 'backpressure' | 'hibernate' | 'reconnect' | 'renderer-loss';
  recoveryFetchMs: number;
  recoveryKind: TerminalRecoveryBatchEntry['recovery']['kind'];
  requestStateBytes: number;
  requestedAtMs: number;
  restoreTotalMs: number;
  resumeMs: number;
  selectedRecoveryProtected: boolean;
  waitForOutputIdleMs: number;
  writtenBytes: number;
}

declare global {
  interface Window {
    __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: TerminalReplayTraceEntry[];
  }
}

function shouldRecordTerminalReplayTrace(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return Array.isArray(window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__);
}

function recordTerminalReplayTrace(entry: TerminalReplayTraceEntry): void {
  if (!shouldRecordTerminalReplayTrace() || typeof window === 'undefined') {
    return;
  }

  const traceEntries = window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ ?? [];
  traceEntries.push(entry);
  window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = traceEntries;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface TerminalRecoveryRuntime {
  handleBrowserTransportConnectionState(state: ReconnectAwareBrowserTransportConnectionState): void;
  isOutputFlushBlocked(): boolean;
  isRestoreBlocked(): boolean;
  restoreTerminalOutput(
    reason?: 'attach' | 'backpressure' | 'hibernate' | 'reconnect' | 'renderer-loss',
  ): Promise<void>;
}

interface CreateTerminalRecoveryRuntimeOptions {
  agentId: string;
  channelId: string;
  ensureTerminalFitReady: (reason: 'renderer-loss' | 'restore') => Promise<boolean>;
  getCurrentStatus: () => TerminalViewStatus;
  getOutputPriority: () => TerminalOutputPriority;
  inputPipeline: TerminalInputPipeline;
  isSelectedRecoveryProtected: () => boolean;
  isRenderHibernating: () => boolean;
  isDisposed: () => boolean;
  isSpawnFailed: () => boolean;
  isSpawnReady: () => boolean;
  markTerminalReady: () => void;
  onRestoreBlockedChange?: (isBlocked: boolean) => void;
  onRestoreSettled: () => void;
  onSelectedRecoverySettle?: () => void;
  onSelectedRecoveryStart?: () => void;
  outputPipeline: TerminalOutputPipeline;
  setStatus: (status: TerminalViewStatus) => void;
  taskId: string;
  term: Terminal;
}

type ReconnectAwareBrowserTransportConnectionState = Extract<
  BrowserControlConnectionState,
  'connected' | 'disconnected' | 'reconnecting'
>;

type TerminalRecoveryReason =
  | 'attach'
  | 'backpressure'
  | 'hibernate'
  | 'reconnect'
  | 'renderer-loss';

type PendingReconnectRestoreState = 'needed' | 'none' | 'queued';

type TerminalRecoveryPhase =
  | 'applying-recovery'
  | 'ensure-fit-ready'
  | 'marking-ready'
  | 'pausing-agent'
  | 'renderer-refresh'
  | 'requesting-recovery'
  | 'resuming-agent'
  | 'waiting-output-idle'
  | 'waiting-post-drain'
  | 'waiting-post-reveal';

type TerminalRecoveryState =
  | { kind: 'idle' }
  | {
      generation: number;
      kind: 'resume-failed';
      reason: TerminalRecoveryReason;
    }
  | {
      generation: number;
      kind: 'restoring';
      pauseApplied: boolean;
      phase: TerminalRecoveryPhase;
      reason: TerminalRecoveryReason;
      selectedRecoveryStarted: boolean;
    };

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
    if (outputIndex < output.length) {
      output[outputIndex++] = (triplet >>> 8) & 0xff;
    }
    if (outputIndex < output.length) {
      output[outputIndex++] = triplet & 0xff;
    }
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

function getChunkSizesByReason(
  reason: TerminalRecoveryReason,
): typeof ATTACH_RESTORE_CHUNK_BYTES_BY_PRIORITY | typeof RESTORE_CHUNK_BYTES_BY_PRIORITY {
  if (reason === 'attach') {
    return ATTACH_RESTORE_CHUNK_BYTES_BY_PRIORITY;
  }

  return RESTORE_CHUNK_BYTES_BY_PRIORITY;
}

export function createTerminalRecoveryRuntime(
  options: CreateTerminalRecoveryRuntimeOptions,
): TerminalRecoveryRuntime {
  const { agentId, inputPipeline, outputPipeline, term } = options;

  let hasConnected = false;
  let browserTransportState: ReconnectAwareBrowserTransportConnectionState = 'disconnected';
  let pendingReconnectRestoreState: PendingReconnectRestoreState = 'none';
  let recoveryState: TerminalRecoveryState = { kind: 'idle' };
  let restoreBlocked = false;
  // restoreGeneration invalidates stale restore attempts when connection state changes,
  // and also provides a monotonic token for each active restore.
  let restoreGeneration = 0;
  let restoreWriteChunkCount = 0;
  let restoreWrittenBytes = 0;

  function isRecoveryInFlight(): boolean {
    return recoveryState.kind === 'restoring';
  }

  function setRestoreBlocked(nextBlocked: boolean): void {
    if (restoreBlocked === nextBlocked) {
      return;
    }

    restoreBlocked = nextBlocked;
    options.onRestoreBlockedChange?.(nextBlocked);
  }

  function isOutputFlushBlocked(): boolean {
    if (!restoreBlocked) {
      return false;
    }

    if (recoveryState.kind !== 'restoring') {
      return true;
    }

    switch (recoveryState.phase) {
      case 'waiting-output-idle':
      case 'waiting-post-drain':
        return false;
      case 'applying-recovery':
      case 'ensure-fit-ready':
      case 'marking-ready':
      case 'pausing-agent':
      case 'renderer-refresh':
      case 'requesting-recovery':
      case 'resuming-agent':
      case 'waiting-post-reveal':
        return true;
    }

    return assertNever(recoveryState.phase, 'Unhandled terminal recovery phase');
  }

  function setRecoveryPhase(generation: number, phase: TerminalRecoveryPhase): void {
    if (recoveryState.kind !== 'restoring' || recoveryState.generation !== generation) {
      return;
    }

    recoveryState = {
      ...recoveryState,
      phase,
    };
  }

  function setRecoveryPauseApplied(generation: number, pauseApplied: boolean): void {
    if (recoveryState.kind !== 'restoring' || recoveryState.generation !== generation) {
      return;
    }

    recoveryState = {
      ...recoveryState,
      pauseApplied,
    };
  }

  function markSelectedRecoveryStarted(generation: number): void {
    if (recoveryState.kind !== 'restoring' || recoveryState.generation !== generation) {
      return;
    }

    recoveryState = {
      ...recoveryState,
      selectedRecoveryStarted: true,
    };
  }

  function clearRecoveryStateIfActive(generation: number): void {
    if (recoveryState.kind !== 'restoring' || recoveryState.generation !== generation) {
      return;
    }

    recoveryState = { kind: 'idle' };
    setRestoreBlocked(false);
  }

  function shouldBlockTerminalRecoveryUIForStatus(status: TerminalViewStatus): boolean {
    switch (status) {
      case 'attaching':
        return false;
      case 'binding':
      case 'error':
      case 'ready':
      case 'restoring':
        return true;
      default:
        return assertNever(status, 'Unhandled terminal recovery UI status');
    }
  }

  function shouldUseHiddenRestoreYield(): boolean {
    if (options.isSelectedRecoveryProtected()) {
      return false;
    }

    if (options.getOutputPriority() === 'hidden') {
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

  function shouldDrainQueuedOutputBeforeRecovery(reason: TerminalRecoveryReason): boolean {
    return reason !== 'reconnect';
  }

  async function waitForOutputIdle(reason: TerminalRecoveryReason): Promise<void> {
    while (
      (outputPipeline.hasWriteInFlight() ||
        outputPipeline.hasPendingFlowTransitions() ||
        (shouldDrainQueuedOutputBeforeRecovery(reason) && outputPipeline.hasQueuedOutput())) &&
      !options.isDisposed()
    ) {
      if (shouldDrainQueuedOutputBeforeRecovery(reason) && outputPipeline.hasQueuedOutput()) {
        outputPipeline.scheduleOutputFlush();
      }
      await waitForRestoreYield();
    }
  }

  async function waitForPostRecoveryOutputDrain(): Promise<void> {
    const startedAtMs = performance.now();
    while (
      (outputPipeline.hasWriteInFlight() ||
        outputPipeline.hasPendingFlowTransitions() ||
        outputPipeline.hasQueuedOutput()) &&
      !options.isDisposed()
    ) {
      if (performance.now() - startedAtMs >= POST_RECOVERY_OUTPUT_DRAIN_TIMEOUT_MS) {
        return;
      }
      if (outputPipeline.hasQueuedOutput()) {
        outputPipeline.scheduleOutputFlush();
      }
      await waitForRestoreYield();
    }
  }

  async function waitForPostRecoveryRevealSettle(): Promise<void> {
    if (POST_RECOVERY_REVEAL_SETTLE_MS > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, POST_RECOVERY_REVEAL_SETTLE_MS);
      });
    }
    await waitForStableRevealFrame();
  }

  async function waitForStableRevealFrame(): Promise<void> {
    recordTerminalRecoveryStableRevealWait();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }

  function refreshTerminalViewport(): void {
    term.refresh(0, Math.max(term.rows - 1, 0));
  }

  async function waitForTerminalFitReady(reason: 'renderer-loss' | 'restore'): Promise<boolean> {
    while (!options.isDisposed()) {
      if (await options.ensureTerminalFitReady(reason)) {
        return true;
      }
    }

    return false;
  }

  function isActiveRestoreGeneration(generation: number): boolean {
    return (
      generation === restoreGeneration &&
      recoveryState.kind === 'restoring' &&
      recoveryState.generation === generation &&
      !options.isDisposed()
    );
  }

  function getRestoreChunkSize(reason: TerminalRecoveryReason): number {
    const chunkSizesByPriority = getChunkSizesByReason(reason);
    if (options.isSelectedRecoveryProtected()) {
      return chunkSizesByPriority['switch-target-visible'];
    }

    const outputPriority = options.getOutputPriority();
    switch (outputPriority) {
      case 'focused':
        return chunkSizesByPriority.focused;
      case 'switch-target-visible':
        return chunkSizesByPriority['switch-target-visible'];
      case 'active-visible':
        return chunkSizesByPriority['active-visible'];
      case 'visible-background':
        return chunkSizesByPriority['visible-background'];
      case 'hidden':
        return chunkSizesByPriority.hidden;
    }

    return assertNever(outputPriority, 'Unhandled terminal output priority');
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
    yieldBetweenChunks: boolean,
  ): Promise<void> {
    if (payload.length === 0) {
      return;
    }

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, Math.min(payload.length, offset + chunkSize));
      restoreWriteChunkCount += 1;
      restoreWrittenBytes += chunk.length;
      await writeTerminalRestoreChunk(chunk);
      if (yieldBetweenChunks && offset + chunkSize < payload.length) {
        await waitForRestoreYield();
      }
    }
  }

  function shouldYieldBetweenRestoreChunks(reason: TerminalRecoveryReason): boolean {
    switch (reason) {
      case 'attach':
        return false;
      case 'backpressure':
      case 'hibernate':
      case 'reconnect':
      case 'renderer-loss':
        return true;
    }

    return assertNever(reason, 'Unhandled terminal recovery reason');
  }

  async function restoreTerminalScrollbackData(
    scrollback: Uint8Array,
    reason: Extract<TerminalRecoveryReason, 'attach' | 'backpressure' | 'hibernate' | 'reconnect'>,
  ): Promise<void> {
    recordTerminalRecoveryReset(reason);
    term.reset();
    await writeTerminalPayloadChunked(
      scrollback,
      getRestoreChunkSize(reason),
      shouldYieldBetweenRestoreChunks(reason),
    );
    outputPipeline.setRenderedOutputHistory(scrollback);
  }

  function buildTerminalRecoveryHistory(overlapBytes: number, delta: Uint8Array): Uint8Array {
    const history = outputPipeline.getRenderedOutputHistory();
    const safeOverlapBytes = Math.min(Math.max(overlapBytes, 0), history.length);
    if (safeOverlapBytes === 0) {
      return delta.slice();
    }

    const preservedHistory = history.subarray(history.length - safeOverlapBytes);
    const nextHistory = new Uint8Array(preservedHistory.length + delta.length);
    nextHistory.set(preservedHistory, 0);
    nextHistory.set(delta, preservedHistory.length);
    return nextHistory;
  }

  function getTerminalRecoveryRequestState(): {
    outputCursor: number;
    renderedTail: string | null;
  } {
    const requestState = outputPipeline.getRecoveryRequestState();
    return {
      outputCursor: requestState.outputCursor,
      renderedTail:
        requestState.renderedTail && requestState.renderedTail.length > 0
          ? uint8ArrayToBase64(requestState.renderedTail)
          : null,
    };
  }

  function shouldShowBlockingRestoreUI(
    reason: TerminalRecoveryReason,
    entry: TerminalRecoveryBatchEntry,
  ): boolean {
    if (reason === 'hibernate') {
      return false;
    }

    return (
      isSnapshotRecovery(entry) &&
      shouldBlockTerminalRecoveryUIForStatus(options.getCurrentStatus())
    );
  }

  function shouldScrollToBottomAfterRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return isSnapshotRecovery(entry);
  }

  function isSnapshotRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'snapshot';
  }

  function isVisibleSteadyStateSnapshotRecovery(
    reason: TerminalRecoveryReason,
    entry: TerminalRecoveryBatchEntry,
  ): boolean {
    if (!isSnapshotRecovery(entry)) {
      return false;
    }

    if (reason === 'attach' || reason === 'renderer-loss') {
      return false;
    }

    if (options.getCurrentStatus() !== 'ready') {
      return false;
    }

    const outputPriority = options.getOutputPriority();
    return outputPriority !== 'hidden';
  }

  function getTerminalRecoveryRequest(
    reason: TerminalRecoveryReason,
  ): typeof requestTerminalRecovery {
    switch (reason) {
      case 'attach':
        return requestAttachTerminalRecovery;
      case 'reconnect':
        return requestReconnectTerminalRecovery;
      case 'backpressure':
      case 'hibernate':
      case 'renderer-loss':
        return requestTerminalRecovery;
    }

    return assertNever(reason, 'Unhandled terminal recovery reason');
  }

  function canStartReconnectRestore(): boolean {
    return (
      hasConnected &&
      pendingReconnectRestoreState !== 'none' &&
      !isRecoveryInFlight() &&
      browserTransportState === 'connected' &&
      options.isSpawnReady() &&
      !options.isDisposed()
    );
  }

  function startReconnectRestoreIfReady(): boolean {
    if (!canStartReconnectRestore()) {
      return false;
    }

    pendingReconnectRestoreState = 'none';
    void restoreTerminalOutput('reconnect');
    return true;
  }

  async function applyTerminalRecoveryEntry(
    entry: TerminalRecoveryBatchEntry,
    reason: TerminalRecoveryReason,
  ): Promise<void> {
    switch (entry.recovery.kind) {
      case 'noop':
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      case 'delta': {
        const delta = base64ToUint8Array(entry.recovery.data);
        if (delta.length > 0) {
          await writeTerminalPayloadChunked(
            delta,
            getRestoreChunkSize(reason),
            shouldYieldBetweenRestoreChunks(reason),
          );
        }
        if (entry.recovery.source === 'cursor') {
          outputPipeline.appendRenderedOutputHistory(delta);
        } else {
          outputPipeline.setRenderedOutputHistory(
            buildTerminalRecoveryHistory(entry.recovery.overlapBytes, delta),
          );
        }
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      }
      case 'snapshot': {
        const scrollback = entry.recovery.data
          ? base64ToUint8Array(entry.recovery.data)
          : new Uint8Array(0);
        if (reason === 'renderer-loss') {
          return;
        }
        await restoreTerminalScrollbackData(scrollback, reason);
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      }
    }

    return assertNever(entry.recovery, 'Unhandled terminal recovery entry');
  }

  async function restoreTerminalOutput(
    reason: TerminalRecoveryReason = 'renderer-loss',
  ): Promise<void> {
    if (options.isDisposed() || isRecoveryInFlight()) {
      return;
    }

    const generation = ++restoreGeneration;
    recoveryState = {
      generation,
      kind: 'restoring',
      pauseApplied: false,
      phase: reason === 'renderer-loss' ? 'renderer-refresh' : 'ensure-fit-ready',
      reason,
      selectedRecoveryStarted: false,
    };
    setRestoreBlocked(true);
    restoreWriteChunkCount = 0;
    restoreWrittenBytes = 0;
    const restoreStartedAtMs = performance.now();
    const outputPriority = options.getOutputPriority();
    let waitForOutputIdleMs = 0;
    let pauseMs = 0;
    let recoveryFetchMs = 0;
    let applyMs = 0;
    let resumeMs = 0;
    let recoveryKind: TerminalRecoveryBatchEntry['recovery']['kind'] = 'noop';
    let requestStateBytes = 0;
    let terminalMarkedReady = false;
    let shouldRestartQueuedRestore = false;
    let shouldExitAfterFinally = false;
    let resumeSucceeded = true;
    const selectedRecoveryProtected = options.isSelectedRecoveryProtected();
    try {
      if (reason === 'renderer-loss') {
        setRecoveryPhase(generation, 'renderer-refresh');
        const rendererFitReady = await waitForTerminalFitReady('renderer-loss');
        if (!rendererFitReady || generation !== restoreGeneration || options.isDisposed()) {
          return;
        }
        recordTerminalRecoveryRenderRefresh();
        term.refresh(0, Math.max(term.rows - 1, 0));
        await waitForStableRevealFrame();
        if (generation !== restoreGeneration || options.isDisposed()) {
          return;
        }
        options.markTerminalReady();
        terminalMarkedReady = true;
        return;
      }

      setRecoveryPhase(generation, 'ensure-fit-ready');
      const restoreFitReady = await waitForTerminalFitReady('restore');
      if (!restoreFitReady || !isActiveRestoreGeneration(generation)) {
        return;
      }
      if (selectedRecoveryProtected) {
        options.onSelectedRecoveryStart?.();
        markSelectedRecoveryStarted(generation);
      }
      setRecoveryPhase(generation, 'waiting-output-idle');
      const waitForOutputIdleStartedAtMs = performance.now();
      await waitForOutputIdle(reason);
      waitForOutputIdleMs = performance.now() - waitForOutputIdleStartedAtMs;
      if (!isActiveRestoreGeneration(generation)) {
        return;
      }

      setRecoveryPhase(generation, 'pausing-agent');
      const pauseStartedAtMs = performance.now();
      await invoke(IPC.PauseAgent, { agentId, reason: 'restore', channelId: options.channelId });
      pauseMs = performance.now() - pauseStartedAtMs;
      setRecoveryPauseApplied(generation, true);
      const recoveryRequest = getTerminalRecoveryRequest(reason);
      const requestState = getTerminalRecoveryRequestState();
      requestStateBytes =
        requestState.renderedTail === null
          ? 0
          : Math.floor((requestState.renderedTail.length * 3) / 4);
      recordTerminalRecoveryRequest(reason, requestStateBytes);
      setRecoveryPhase(generation, 'requesting-recovery');
      const recoveryFetchStartedAtMs = performance.now();
      const recoveryEntry = await recoveryRequest(agentId, requestState);
      recoveryFetchMs = performance.now() - recoveryFetchStartedAtMs;
      recoveryKind = recoveryEntry.recovery.kind;
      if (!isActiveRestoreGeneration(generation)) {
        return;
      }

      const shouldBlockUi = shouldShowBlockingRestoreUI(reason, recoveryEntry);
      if (shouldBlockUi) {
        options.setStatus('restoring');
      }
      if (isVisibleSteadyStateSnapshotRecovery(reason, recoveryEntry)) {
        recordTerminalRecoveryVisibleSteadyStateSnapshot(reason);
      }

      if (recoveryEntry.recovery.kind === 'snapshot') {
        outputPipeline.dropQueuedOutputForRecovery();
      }
      setRecoveryPhase(generation, 'applying-recovery');
      const applyStartedAtMs = performance.now();
      await applyTerminalRecoveryEntry(recoveryEntry, reason);
      applyMs = performance.now() - applyStartedAtMs;
      recordTerminalRecoveryApply({
        blockingUi: shouldBlockUi,
        kind: recoveryKind,
        reason,
        writeBytes: restoreWrittenBytes,
        writeChunks: restoreWriteChunkCount,
      });
      const postRecoveryFitReady = await waitForTerminalFitReady('restore');
      if (!postRecoveryFitReady || generation !== restoreGeneration || options.isDisposed()) {
        return;
      }
      if (shouldScrollToBottomAfterRecovery(recoveryEntry)) {
        term.scrollToBottom();
      }
      refreshTerminalViewport();
      setRecoveryPhase(generation, 'waiting-post-reveal');
      await waitForPostRecoveryRevealSettle();
      if (generation !== restoreGeneration || options.isDisposed()) {
        return;
      }
    } catch (error) {
      console.warn('[terminal] Failed to restore scrollback', error);
    } finally {
      const selectedRecoveryStarted =
        recoveryState.kind === 'restoring' &&
        recoveryState.generation === generation &&
        recoveryState.selectedRecoveryStarted;
      if (
        recoveryState.kind === 'restoring' &&
        recoveryState.generation === generation &&
        recoveryState.pauseApplied
      ) {
        try {
          setRecoveryPhase(generation, 'resuming-agent');
          const resumeStartedAtMs = performance.now();
          await invoke(IPC.ResumeAgent, {
            agentId,
            reason: 'restore',
            channelId: options.channelId,
          });
          resumeMs = performance.now() - resumeStartedAtMs;
        } catch (error) {
          resumeSucceeded = false;
          console.warn('[terminal] Failed to resume after scrollback restore', error);
        } finally {
          if (resumeSucceeded) {
            setRecoveryPauseApplied(generation, false);
          }
        }
      }

      recordTerminalReplayTrace({
        agentId,
        applyMs: roundMilliseconds(applyMs),
        chunkCount: restoreWriteChunkCount,
        outputPriority,
        pauseMs: roundMilliseconds(pauseMs),
        reason,
        recoveryFetchMs: roundMilliseconds(recoveryFetchMs),
        recoveryKind,
        requestStateBytes,
        requestedAtMs: roundMilliseconds(restoreStartedAtMs),
        restoreTotalMs: roundMilliseconds(performance.now() - restoreStartedAtMs),
        resumeMs: roundMilliseconds(resumeMs),
        selectedRecoveryProtected,
        waitForOutputIdleMs: roundMilliseconds(waitForOutputIdleMs),
        writtenBytes: restoreWrittenBytes,
      });
      if (!resumeSucceeded) {
        recoveryState = {
          generation,
          kind: 'resume-failed',
          reason,
        };
        options.setStatus('restoring');
        shouldExitAfterFinally = true;
      } else {
        options.onRestoreSettled();
        if (pendingReconnectRestoreState === 'queued') {
          clearRecoveryStateIfActive(generation);
        }
        if (pendingReconnectRestoreState === 'queued' && startReconnectRestoreIfReady()) {
          shouldRestartQueuedRestore = true;
          outputPipeline.recoverFlowControlIfIdle();
        } else if (outputPipeline.hasQueuedOutput()) {
          outputPipeline.scheduleOutputFlush();
        }
        if (
          selectedRecoveryStarted &&
          !shouldRestartQueuedRestore &&
          isActiveRestoreGeneration(generation)
        ) {
          options.onSelectedRecoverySettle?.();
        }
        if (
          !shouldRestartQueuedRestore &&
          !terminalMarkedReady &&
          !options.isDisposed() &&
          !options.isSpawnFailed()
        ) {
          if (shouldDrainQueuedOutputBeforeRecovery(reason) && outputPipeline.hasQueuedOutput()) {
            recoveryState = {
              generation,
              kind: 'restoring',
              pauseApplied: false,
              phase: 'waiting-post-drain',
              reason,
              selectedRecoveryStarted,
            };
            await waitForPostRecoveryOutputDrain();
          }
          if (restoreGeneration !== generation || options.isDisposed() || options.isSpawnFailed()) {
            shouldExitAfterFinally = true;
          } else {
            if (shouldDrainQueuedOutputBeforeRecovery(reason)) {
              setRecoveryPhase(generation, 'waiting-post-reveal');
              await waitForPostRecoveryRevealSettle();
            }
            if (
              restoreGeneration !== generation ||
              options.isDisposed() ||
              options.isSpawnFailed()
            ) {
              shouldExitAfterFinally = true;
            } else {
              setRecoveryPhase(generation, 'marking-ready');
              options.markTerminalReady();
              inputPipeline.flushPendingResize();
              inputPipeline.flushPendingInput();
              inputPipeline.drainInputQueue();
            }
          }
        }
        if (!shouldExitAfterFinally) {
          clearRecoveryStateIfActive(generation);
          outputPipeline.recoverFlowControlIfIdle();
        }
      }
    }

    if (shouldExitAfterFinally) {
      return;
    }
    if (shouldRestartQueuedRestore) {
      return;
    }
  }

  return {
    handleBrowserTransportConnectionState(
      state: ReconnectAwareBrowserTransportConnectionState,
    ): void {
      browserTransportState = state;
      switch (state) {
        case 'connected':
          if (pendingReconnectRestoreState !== 'none') {
            if (!startReconnectRestoreIfReady()) {
              pendingReconnectRestoreState = isRecoveryInFlight() ? 'queued' : 'needed';
            }
          }
          hasConnected = true;
          return;
        case 'disconnected':
        case 'reconnecting':
          if (hasConnected) {
            pendingReconnectRestoreState = 'needed';
            restoreGeneration += 1;
          }
          return;
      }

      return assertNever(state, 'Unhandled browser transport connection state');
    },
    isOutputFlushBlocked,
    isRestoreBlocked(): boolean {
      return restoreBlocked;
    },
    restoreTerminalOutput,
  };
}
