import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { assertNever } from '../../lib/assert-never';
import { decodeBase64ToUint8Array } from '../../lib/base64';
import type { BrowserControlConnectionState } from '../../lib/browser-control-client';
import { invoke } from '../../lib/ipc';
import {
  recordTerminalRecoveryApply,
  recordTerminalRecoveryGeometryAlignmentFallback,
  recordTerminalRecoveryRenderRefresh,
  recordTerminalRecoveryRequest,
  recordTerminalRecoveryReset,
  recordTerminalRecoveryStartupFirstPaintDeferral,
  recordTerminalRecoveryStableRevealWait,
  recordTerminalRecoveryVisibleSteadyStateSnapshot,
  recordTerminalStartupTaskScheduling,
} from '../../app/runtime-diagnostics';
import {
  scheduleTerminalStartupTask,
  yieldTerminalStartupTask,
  type TerminalStartupTaskSchedulingMode,
  type TerminalStartupTaskSchedulingRole,
} from '../../app/terminal-startup-task-scheduler';
import {
  getTerminalSwitchWindowSnapshot,
  subscribeTerminalSwitchWindowChanges,
} from '../../app/terminal-switch-window';
import {
  requestAttachTerminalRecovery,
  requestReconnectTerminalRecovery,
  requestStartupTerminalRecovery,
  requestTerminalRecovery,
} from '../../lib/scrollbackRestore';
import {
  getTerminalExperimentStartupAttachChunkByteOverride,
  getTerminalExperimentStartupAttachSwitchWindowChunkByteOverride,
  getTerminalExperimentStartupAttachYieldOverride,
  getTerminalExperimentStartupHiddenReplayUnblockPhase,
  getTerminalExperimentStartupTaskSchedulingMode,
  getTerminalExperimentStartupVisibleSiblingReplayUnblockPhase,
  shouldUseTerminalExperimentStartupTaskSchedulingRole,
} from '../../lib/terminal-performance-experiments';
import type { TerminalRecoveryBatchEntry, TerminalStartupRecoveryRole } from '../../ipc/types';
import type { TerminalViewStatus } from './types';
import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';
import type { TerminalOutputPipeline } from './terminal-output-pipeline';
import type { TerminalInputPipeline } from './terminal-input-pipeline';

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
  'active-visible': 256 * 1024,
  focused: 256 * 1024,
  hidden: 128 * 1024,
  'switch-target-visible': 256 * 1024,
  'visible-background': 64 * 1024,
} as const;
const ATTACH_REQUEST_TAIL_BYTES_BY_PRIORITY = {
  'active-visible': 256 * 1024,
  focused: 256 * 1024,
  hidden: 32 * 1024,
  'switch-target-visible': 256 * 1024,
  'visible-background': 64 * 1024,
} as const;
const ATTACH_SNAPSHOT_BYTE_LIMIT_BY_PRIORITY = {
  'active-visible': 384 * 1024,
  focused: 512 * 1024,
  hidden: 64 * 1024,
  'switch-target-visible': 512 * 1024,
  'visible-background': 128 * 1024,
} as const;
const DENSE_STARTUP_ATTACH_RESTORE_CHUNK_BYTES_BY_PRIORITY = {
  'active-visible': 32 * 1024,
  focused: 128 * 1024,
  hidden: 64 * 1024,
  'switch-target-visible': 128 * 1024,
  'visible-background': 16 * 1024,
} as const;
const DENSE_STARTUP_ATTACH_REQUEST_TAIL_BYTES_BY_PRIORITY = {
  'active-visible': 32 * 1024,
  focused: 128 * 1024,
  hidden: 32 * 1024,
  'switch-target-visible': 128 * 1024,
  'visible-background': 16 * 1024,
} as const;
const DENSE_STARTUP_ATTACH_SNAPSHOT_BYTE_LIMIT_BY_PRIORITY = {
  'active-visible': 64 * 1024,
  focused: 256 * 1024,
  hidden: 64 * 1024,
  'switch-target-visible': 256 * 1024,
  'visible-background': 32 * 1024,
} as const;
const MAX_RECOVERY_GEOMETRY_ALIGNMENT_ATTEMPTS = 3;
const MAX_RECOVERY_GEOMETRY_ALIGNMENT_WAIT_MS = 750;
const POST_RECOVERY_REVEAL_SETTLE_MS = 32;
const MAX_STARTUP_PRIMARY_READY_SIBLING_DEFER_MS = 2_000;
const MAX_STARTUP_VISIBLE_PAINT_HIDDEN_DEFER_MS = 4_000;
const DENSE_STARTUP_VISIBLE_TERMINAL_THRESHOLD = 4;

interface TerminalReplayTraceEntry {
  agentId: string;
  applyMs: number;
  chunkCount: number;
  outputPriority: TerminalOutputPriority;
  pauseMs: number;
  postApplyFitMs: number;
  preRecoveryFitMs: number;
  primaryReadinessWaitMs: number;
  reason: 'attach' | 'backpressure' | 'hibernate' | 'reconnect' | 'renderer-loss';
  recoveryFetchMs: number;
  recoveryKind: TerminalRecoveryBatchEntry['recovery']['kind'];
  revealSettleMs: number;
  requestStateBytes: number;
  requestedAtMs: number;
  restoreTotalMs: number;
  resumeMs: number;
  selectedVisibleFastPath: boolean;
  selectedRecoveryProtected: boolean;
  visiblePaintWaitMs: number;
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
  dispose(): void;
  handleBrowserControlAuthenticated(): void;
  handleBrowserTransportConnectionState(state: ReconnectAwareBrowserTransportConnectionState): void;
  isOutputFlushBlocked(): boolean;
  isRestoreBlocked(): boolean;
  notifySpawnReady(): void;
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
  initialBrowserTransportState?: ReconnectAwareBrowserTransportConnectionState;
  getStartupPaintCoordinationSnapshot?: () => {
    hiddenPendingCount: number;
    hiddenReadyCount: number;
    selectedPaintReady: boolean;
    selectedPendingCount: number;
    visiblePendingCount: number;
    visibleReadyCount: number;
  };
  inputPipeline: TerminalInputPipeline;
  isShell: boolean;
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
  onStartupWriteRendered?: (byteLength: number) => void;
  outputPipeline: TerminalOutputPipeline;
  setStatus: (status: TerminalViewStatus) => void;
  subscribeStartupPaintCoordinationChanges?: (listener: () => void) => () => void;
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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return '';
  }

  const bytesWithNativeBase64 = bytes as Uint8Array & {
    toBase64?: () => string;
  };
  if (typeof bytesWithNativeBase64.toBase64 === 'function') {
    return bytesWithNativeBase64.toBase64();
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

function getAttachRecoveryRequestTailByteLimit(outputPriority: TerminalOutputPriority): number {
  return ATTACH_REQUEST_TAIL_BYTES_BY_PRIORITY[outputPriority];
}

function getAttachRecoverySnapshotByteLimit(outputPriority: TerminalOutputPriority): number {
  return ATTACH_SNAPSHOT_BYTE_LIMIT_BY_PRIORITY[outputPriority];
}

function getVisibleStartupRecoveryRole(
  reason: TerminalRecoveryReason,
  isShell: boolean,
  isSelectedRecoveryProtected: boolean,
  outputPriority: TerminalOutputPriority,
): TerminalStartupRecoveryRole | null {
  if (reason !== 'attach') {
    return null;
  }

  if (isShell) {
    return null;
  }

  if (outputPriority === 'hidden') {
    return null;
  }

  if (isSelectedRecoveryProtected || outputPriority === 'focused') {
    return 'selected';
  }

  return 'visible-sibling';
}

function shouldSuppressRenderedTailForAttachRecovery(
  reason: TerminalRecoveryReason,
  isShell: boolean,
  outputPriority: TerminalOutputPriority,
): boolean {
  return reason === 'attach' && isShell && outputPriority !== 'hidden';
}

export function createTerminalRecoveryRuntime(
  options: CreateTerminalRecoveryRuntimeOptions,
): TerminalRecoveryRuntime {
  const { agentId, inputPipeline, outputPipeline, term } = options;

  let browserTransportState: ReconnectAwareBrowserTransportConnectionState =
    options.initialBrowserTransportState ?? 'disconnected';
  let hasEverAuthenticatedBrowserControl = false;
  let hasCurrentBrowserControlAuth = false;
  let pendingReconnectRestoreState: PendingReconnectRestoreState = 'none';
  let recoveryState: TerminalRecoveryState = { kind: 'idle' };
  let restoreBlocked = false;
  // restoreGeneration invalidates stale restore attempts when connection state changes,
  // and also provides a monotonic token for each active restore.
  let restoreGeneration = 0;
  let restoreWriteChunkCount = 0;
  let restoreWrittenBytes = 0;
  let runtimeDisposed = false;
  const pendingRecoveryWaitCleanups = new Set<() => void>();

  function isRuntimeDisposed(): boolean {
    return runtimeDisposed || options.isDisposed();
  }

  function registerPendingRecoveryWaitCleanup(cleanup: () => void): () => void {
    pendingRecoveryWaitCleanups.add(cleanup);
    return () => {
      pendingRecoveryWaitCleanups.delete(cleanup);
    };
  }

  function disposePendingRecoveryWaits(): void {
    for (const cleanup of [...pendingRecoveryWaitCleanups]) {
      cleanup();
    }
    pendingRecoveryWaitCleanups.clear();
  }

  function dispose(): void {
    if (runtimeDisposed) {
      return;
    }

    runtimeDisposed = true;
    restoreGeneration += 1;
    pendingReconnectRestoreState = 'none';
    disposePendingRecoveryWaits();
    recoveryState = { kind: 'idle' };
    setRestoreBlocked(false);
  }

  async function waitForRecoveryGate(options: {
    isReady: () => boolean;
    subscribe: (listener: () => void) => () => void;
    timeoutMs: number;
  }): Promise<boolean> {
    if (isRuntimeDisposed()) {
      return false;
    }

    if (options.isReady()) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let cleanupSubscription = (): void => {};
      let unregisterWaitCleanup = (): void => {};

      const finish = (ready: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        unregisterWaitCleanup();
        cleanupSubscription();
        window.clearTimeout(timeoutId);
        resolve(ready);
      };

      const check = (): void => {
        if (isRuntimeDisposed()) {
          finish(false);
          return;
        }

        if (options.isReady()) {
          finish(true);
        }
      };

      unregisterWaitCleanup = registerPendingRecoveryWaitCleanup(() => finish(false));
      const timeoutId = window.setTimeout(() => finish(true), options.timeoutMs);
      cleanupSubscription = options.subscribe(check);
      if (settled) {
        cleanupSubscription();
        return;
      }

      check();
    });
  }

  function getStartupVisibleTerminalCount(): number {
    const startupPaintSnapshot = options.getStartupPaintCoordinationSnapshot?.();
    if (!startupPaintSnapshot) {
      return 1;
    }

    return Math.max(
      1,
      startupPaintSnapshot.visiblePendingCount + startupPaintSnapshot.visibleReadyCount,
    );
  }

  function isDenseVisibleStartupAttach(): boolean {
    if (recoveryState.kind !== 'restoring' || recoveryState.reason !== 'attach') {
      return false;
    }

    return getStartupVisibleTerminalCount() >= DENSE_STARTUP_VISIBLE_TERMINAL_THRESHOLD;
  }

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

    if (typeof document === 'undefined') {
      return false;
    }

    return document.visibilityState === 'hidden';
  }

  function getStartupTaskSchedulingRole(
    reason: TerminalRecoveryReason | null,
  ): TerminalStartupTaskSchedulingRole | null {
    if (reason !== 'attach') {
      return null;
    }

    if (options.isSelectedRecoveryProtected()) {
      return 'selected';
    }

    const outputPriority = options.getOutputPriority();
    switch (outputPriority) {
      case 'active-visible':
      case 'visible-background':
        return 'visible-sibling';
      case 'hidden':
        return 'hidden';
      case 'focused':
      case 'switch-target-visible':
        return null;
      default:
        return assertNever(outputPriority, 'Unhandled startup task scheduling priority');
    }
  }

  function getConfiguredStartupTaskSchedulingMode(
    reason: TerminalRecoveryReason | null,
  ): TerminalStartupTaskSchedulingMode {
    const role = getStartupTaskSchedulingRole(reason);
    if (!role || !shouldUseTerminalExperimentStartupTaskSchedulingRole(role)) {
      return 'off';
    }

    return getTerminalExperimentStartupTaskSchedulingMode();
  }

  async function waitForRestoreYield(reason: TerminalRecoveryReason | null = null): Promise<void> {
    const schedulingRole = getStartupTaskSchedulingRole(reason);
    const continuationStartedAtMs = performance.now();
    const outcome = await yieldTerminalStartupTask({
      mode: getConfiguredStartupTaskSchedulingMode(reason),
      role: schedulingRole ?? 'selected',
      useTimeoutFallback: shouldUseHiddenRestoreYield(),
    });
    if (schedulingRole) {
      recordTerminalStartupTaskScheduling(schedulingRole, {
        delayMs: Math.max(0, performance.now() - continuationStartedAtMs),
        outcome,
      });
    }
  }

  function shouldDrainQueuedOutputBeforeRecovery(reason: TerminalRecoveryReason): boolean {
    return reason !== 'attach' && reason !== 'reconnect';
  }

  async function waitForOutputIdle(reason: TerminalRecoveryReason): Promise<void> {
    while (
      (outputPipeline.hasWriteInFlight() ||
        outputPipeline.hasPendingFlowTransitions() ||
        (shouldDrainQueuedOutputBeforeRecovery(reason) && outputPipeline.hasQueuedOutput())) &&
      !isRuntimeDisposed()
    ) {
      if (shouldDrainQueuedOutputBeforeRecovery(reason) && outputPipeline.hasQueuedOutput()) {
        outputPipeline.scheduleOutputFlush();
      }
      await waitForRestoreYield(reason);
    }
  }

  async function waitForPostRecoveryOutputDrain(): Promise<void> {
    const startedAtMs = performance.now();
    while (
      (outputPipeline.hasWriteInFlight() ||
        outputPipeline.hasPendingFlowTransitions() ||
        outputPipeline.hasQueuedOutput()) &&
      !isRuntimeDisposed()
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

  function getPostRecoveryRevealSettleDelayMs(): number {
    if (isPrioritySelectedVisibleReconnectRecovery(getActiveRecoveryReason())) {
      return 0;
    }

    if (!options.isSelectedRecoveryProtected()) {
      return POST_RECOVERY_REVEAL_SETTLE_MS;
    }

    const activeReason = getActiveRecoveryReason();
    if (activeReason === 'attach' || activeReason === 'reconnect') {
      return 0;
    }

    return POST_RECOVERY_REVEAL_SETTLE_MS;
  }

  function getActiveRecoveryReason(): TerminalRecoveryReason | null {
    return recoveryState.kind === 'restoring' ? recoveryState.reason : null;
  }

  function isPrioritySelectedVisibleReconnectRecovery(
    reason: TerminalRecoveryReason | null,
  ): boolean {
    if (reason !== 'reconnect') {
      return false;
    }

    const outputPriority = options.getOutputPriority();
    return outputPriority === 'focused' || outputPriority === 'switch-target-visible';
  }

  async function waitForPostRecoveryRevealSettle(
    reason: TerminalRecoveryReason | null,
  ): Promise<number> {
    const revealSettleStartedAtMs = performance.now();
    const revealSettleDelayMs = getPostRecoveryRevealSettleDelayMs();
    if (revealSettleDelayMs > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, revealSettleDelayMs);
      });
    }
    await waitForStableRevealFrame(reason);
    return performance.now() - revealSettleStartedAtMs;
  }

  async function waitForStableRevealFrame(_reason: TerminalRecoveryReason | null): Promise<void> {
    recordTerminalRecoveryStableRevealWait();
    if (shouldUseHiddenRestoreYield()) {
      await waitForRestoreYield();
      await waitForRestoreYield();
      return;
    }

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
    while (!isRuntimeDisposed()) {
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
      !isRuntimeDisposed()
    );
  }

  function getRestoreChunkSize(reason: TerminalRecoveryReason): number {
    const chunkSizesByPriority = getChunkSizesByReason(reason);
    if (options.isSelectedRecoveryProtected()) {
      const override =
        reason === 'attach'
          ? getTerminalExperimentStartupAttachChunkByteOverride('switch-target-visible')
          : null;
      const baseChunkSize = override ?? chunkSizesByPriority['switch-target-visible'];
      if (reason === 'attach' && isDenseVisibleStartupAttach()) {
        return Math.min(
          baseChunkSize,
          DENSE_STARTUP_ATTACH_RESTORE_CHUNK_BYTES_BY_PRIORITY['switch-target-visible'],
        );
      }
      return baseChunkSize;
    }

    const outputPriority = options.getOutputPriority();
    const attachChunkOverride =
      reason === 'attach'
        ? getTerminalExperimentStartupAttachChunkByteOverride(outputPriority)
        : null;
    const baseChunkSize = attachChunkOverride ?? chunkSizesByPriority[outputPriority];
    const switchWindowSnapshot = getTerminalSwitchWindowSnapshot();
    if (reason === 'attach' && switchWindowSnapshot.active) {
      const switchWindowChunkOverride =
        getTerminalExperimentStartupAttachSwitchWindowChunkByteOverride(outputPriority);
      switch (outputPriority) {
        case 'active-visible':
          return Math.min(baseChunkSize, switchWindowChunkOverride ?? 64 * 1024);
        case 'visible-background':
          return Math.min(baseChunkSize, switchWindowChunkOverride ?? 32 * 1024);
        case 'focused':
        case 'hidden':
        case 'switch-target-visible':
          break;
      }
    }
    if (reason === 'attach' && isDenseVisibleStartupAttach()) {
      return Math.min(
        baseChunkSize,
        DENSE_STARTUP_ATTACH_RESTORE_CHUNK_BYTES_BY_PRIORITY[outputPriority],
      );
    }
    return baseChunkSize;
  }

  function getStartupWriteRenderedCallback(
    reason: Extract<TerminalRecoveryReason, 'attach' | 'backpressure' | 'hibernate' | 'reconnect'>,
  ): ((byteLength: number) => void) | null {
    if (reason !== 'attach') {
      return null;
    }

    return options.onStartupWriteRendered ?? null;
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
    reason: TerminalRecoveryReason,
    onStartupWriteRendered: ((byteLength: number) => void) | null = null,
  ): Promise<void> {
    if (payload.length === 0) {
      return;
    }

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, Math.min(payload.length, offset + chunkSize));
      const schedulingRole = getStartupTaskSchedulingRole(reason);
      const schedulingMode = getConfiguredStartupTaskSchedulingMode(reason);
      restoreWriteChunkCount += 1;
      restoreWrittenBytes += chunk.length;
      if (schedulingRole && schedulingMode !== 'off') {
        const continuationStartedAtMs = performance.now();
        const schedulingResult = await scheduleTerminalStartupTask(
          schedulingRole,
          schedulingMode,
          () => writeTerminalRestoreChunk(chunk),
        );
        recordTerminalStartupTaskScheduling(schedulingRole, {
          delayMs: Math.max(0, performance.now() - continuationStartedAtMs),
          outcome: schedulingResult.outcome,
        });
      } else {
        await writeTerminalRestoreChunk(chunk);
      }
      onStartupWriteRendered?.(chunk.length);
      if (yieldBetweenChunks && offset + chunkSize < payload.length) {
        await waitForRestoreYield(reason);
      }
    }
  }

  function shouldYieldBetweenRestoreChunks(reason: TerminalRecoveryReason): boolean {
    const outputPriority = options.getOutputPriority();
    if (reason === 'attach') {
      const override = getTerminalExperimentStartupAttachYieldOverride(outputPriority);
      if (override !== null) {
        return override;
      }
    }
    if (
      reason === 'attach' &&
      (outputPriority === 'active-visible' || outputPriority === 'visible-background') &&
      getTerminalSwitchWindowSnapshot().active
    ) {
      return true;
    }

    switch (reason) {
      case 'attach':
        return true;
      case 'backpressure':
      case 'hibernate':
      case 'reconnect':
      case 'renderer-loss':
        return true;
    }

    return assertNever(reason, 'Unhandled terminal recovery reason');
  }

  function shouldDeferVisibleStartupRecoveryUntilPrimaryReady(
    reason: TerminalRecoveryReason,
  ): boolean {
    if (reason !== 'attach' && reason !== 'reconnect') {
      return false;
    }

    if (options.isSelectedRecoveryProtected()) {
      return false;
    }

    const outputPriority = options.getOutputPriority();
    if (outputPriority !== 'active-visible' && outputPriority !== 'visible-background') {
      return false;
    }

    return true;
  }

  function isVisibleStartupRecoveryDeferredBySwitchWindow(
    switchWindowSnapshot: ReturnType<typeof getTerminalSwitchWindowSnapshot>,
  ): boolean {
    if (!switchWindowSnapshot.active) {
      return false;
    }

    if (switchWindowSnapshot.selectedRecoveryActive) {
      return true;
    }

    const replayUnblockPhase = getTerminalExperimentStartupVisibleSiblingReplayUnblockPhase();
    switch (replayUnblockPhase) {
      case 'first-paint':
        return switchWindowSnapshot.phase === 'first-paint-pending';
      case 'input-ready':
        return (
          switchWindowSnapshot.phase === 'first-paint-pending' ||
          switchWindowSnapshot.phase === 'input-ready-pending'
        );
      case 'paint-settled':
        return switchWindowSnapshot.active;
      default:
        return assertNever(
          replayUnblockPhase,
          'Unhandled startup visible sibling replay unblock phase',
        );
    }
  }

  function shouldDeferHiddenStartupRecoveryUntilVisiblePaint(
    reason: TerminalRecoveryReason,
  ): boolean {
    if (reason !== 'attach' && reason !== 'reconnect') {
      return false;
    }

    if (options.isSelectedRecoveryProtected()) {
      return false;
    }

    if (options.getOutputPriority() !== 'hidden') {
      return false;
    }

    const startupPaintSnapshot = options.getStartupPaintCoordinationSnapshot?.();
    if (!startupPaintSnapshot) {
      return false;
    }

    return isHiddenStartupRecoveryDeferredByPaintSnapshot(startupPaintSnapshot);
  }

  function isHiddenStartupRecoveryDeferredByPaintSnapshot(
    startupPaintSnapshot: NonNullable<
      CreateTerminalRecoveryRuntimeOptions['getStartupPaintCoordinationSnapshot']
    > extends () => infer T
      ? T
      : never,
  ): boolean {
    const hiddenReplayUnblockPhase = getTerminalExperimentStartupHiddenReplayUnblockPhase();
    switch (hiddenReplayUnblockPhase) {
      case 'off':
        return false;
      case 'selected-paint':
        return !startupPaintSnapshot.selectedPaintReady;
      case 'all-visible-paint':
        return startupPaintSnapshot.visiblePendingCount > 0;
      default:
        return assertNever(
          hiddenReplayUnblockPhase,
          'Unhandled startup hidden replay unblock phase',
        );
    }
  }

  async function waitForPrimaryStartupReadiness(reason: TerminalRecoveryReason): Promise<boolean> {
    if (!shouldDeferVisibleStartupRecoveryUntilPrimaryReady(reason)) {
      return true;
    }

    const outputPriority = options.getOutputPriority();
    if (outputPriority !== 'active-visible' && outputPriority !== 'visible-background') {
      return true;
    }

    const waitsForSwitchWindow = isVisibleStartupRecoveryDeferredBySwitchWindow(
      getTerminalSwitchWindowSnapshot(),
    );
    if (!waitsForSwitchWindow) {
      return true;
    }

    const waitBudgetMs = MAX_STARTUP_PRIMARY_READY_SIBLING_DEFER_MS;
    const waitStartedAtMs = performance.now();
    const completed = await waitForRecoveryGate({
      isReady: () =>
        !isVisibleStartupRecoveryDeferredBySwitchWindow(getTerminalSwitchWindowSnapshot()),
      subscribe: subscribeTerminalSwitchWindowChanges,
      timeoutMs: waitBudgetMs,
    });
    if (!completed) {
      return false;
    }

    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: outputPriority,
      waitMs: Math.max(0, performance.now() - waitStartedAtMs),
    });
    return true;
  }

  async function waitForVisibleStartupPaintReadiness(
    reason: TerminalRecoveryReason,
  ): Promise<boolean> {
    if (!shouldDeferHiddenStartupRecoveryUntilVisiblePaint(reason)) {
      return true;
    }

    const getSnapshot = options.getStartupPaintCoordinationSnapshot;
    const subscribe = options.subscribeStartupPaintCoordinationChanges;
    if (!getSnapshot || !subscribe) {
      return true;
    }

    const initialSnapshot = getSnapshot();
    if (!isHiddenStartupRecoveryDeferredByPaintSnapshot(initialSnapshot)) {
      return true;
    }

    const waitStartedAtMs = performance.now();
    const completed = await waitForRecoveryGate({
      isReady: () => !isHiddenStartupRecoveryDeferredByPaintSnapshot(getSnapshot()),
      subscribe,
      timeoutMs: MAX_STARTUP_VISIBLE_PAINT_HIDDEN_DEFER_MS,
    });
    if (!completed) {
      return false;
    }

    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: 'hidden',
      waitMs: Math.max(0, performance.now() - waitStartedAtMs),
    });
    return true;
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
      reason,
      getStartupWriteRenderedCallback(reason),
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

  function getTerminalRecoveryRequestState(suppressRenderedTail = false): {
    outputCursor: number;
    renderedTail: string | null;
    snapshotByteLimit: number | null;
  } {
    const isAttachRecovery =
      recoveryState.kind === 'restoring' && recoveryState.reason === 'attach';
    let requestTailBytes: number | undefined;
    let snapshotByteLimit: number | null = null;

    if (isAttachRecovery) {
      const outputPriority = options.getOutputPriority();
      requestTailBytes = getAttachRecoveryRequestTailByteLimit(outputPriority);
      snapshotByteLimit = getAttachRecoverySnapshotByteLimit(outputPriority);

      if (isDenseVisibleStartupAttach()) {
        requestTailBytes = Math.min(
          requestTailBytes,
          DENSE_STARTUP_ATTACH_REQUEST_TAIL_BYTES_BY_PRIORITY[outputPriority],
        );
        snapshotByteLimit = Math.min(
          snapshotByteLimit,
          DENSE_STARTUP_ATTACH_SNAPSHOT_BYTE_LIMIT_BY_PRIORITY[outputPriority],
        );
      }
    }

    const requestState = outputPipeline.getRecoveryRequestState(requestTailBytes);
    let renderedTail: string | null = null;
    if (
      !suppressRenderedTail &&
      requestState.renderedTail &&
      requestState.renderedTail.length > 0
    ) {
      renderedTail = uint8ArrayToBase64(requestState.renderedTail);
    }

    return {
      outputCursor: requestState.outputCursor,
      renderedTail,
      snapshotByteLimit,
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
      isFullStateRecovery(entry) &&
      shouldBlockTerminalRecoveryUIForStatus(options.getCurrentStatus())
    );
  }

  function isSnapshotRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'snapshot';
  }

  function isFullStateRecovery(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'snapshot' || entry.recovery.kind === 'terminal-state';
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

  function shouldDropQueuedOutputBeforeRecoveryApply(
    reason: TerminalRecoveryReason,
    entry: TerminalRecoveryBatchEntry,
  ): boolean {
    return reason === 'attach' ? entry.recovery.kind !== 'noop' : isFullStateRecovery(entry);
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

  function getTerminalRecoveryFallbackOptions(): {
    fallbackCols: number;
    fallbackRows: number;
  } {
    return {
      fallbackCols: term.cols,
      fallbackRows: term.rows,
    };
  }

  async function requestRecoveryEntry(
    reason: TerminalRecoveryReason,
    requestState: ReturnType<typeof getTerminalRecoveryRequestState> | null,
  ): Promise<TerminalRecoveryBatchEntry> {
    const fallbackOptions = getTerminalRecoveryFallbackOptions();
    if (
      reason === 'reconnect' &&
      (options.isSelectedRecoveryProtected() || isPrioritySelectedVisibleReconnectRecovery(reason))
    ) {
      return requestReconnectTerminalRecovery(
        agentId,
        {
          ...(requestState ?? {}),
          ...fallbackOptions,
        },
        { immediate: true },
      );
    }

    const recoveryRequest = getTerminalRecoveryRequest(reason);
    return recoveryRequest(agentId, {
      ...(requestState ?? {}),
      ...fallbackOptions,
    });
  }

  function shouldAlignRecoveryGeometry(reason: TerminalRecoveryReason): boolean {
    switch (reason) {
      case 'attach':
      case 'backpressure':
      case 'hibernate':
      case 'reconnect':
        return true;
      case 'renderer-loss':
        return false;
    }

    return assertNever(reason, 'Unhandled terminal recovery reason');
  }

  function isRecoveryGeometryAligned(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.cols === term.cols && entry.rows === term.rows;
  }

  function requiresRecoveryGeometryAlignment(entry: TerminalRecoveryBatchEntry): boolean {
    return entry.recovery.kind === 'terminal-state';
  }

  function adoptAttachRecoveryGeometry(entry: TerminalRecoveryBatchEntry): boolean {
    if (isRecoveryGeometryAligned(entry)) {
      return true;
    }

    inputPipeline.adoptBackendResizeForRecovery({
      cols: entry.cols,
      rows: entry.rows,
    });
    term.resize(entry.cols, entry.rows);
    return isRecoveryGeometryAligned(entry);
  }

  async function requestGeometryAlignedRecoveryEntry(
    generation: number,
    reason: TerminalRecoveryReason,
    requestState: ReturnType<typeof getTerminalRecoveryRequestState> | null,
    requestStateBytes: number,
  ): Promise<TerminalRecoveryBatchEntry | null> {
    const startupRecoveryRole = getVisibleStartupRecoveryRole(
      reason,
      options.isShell,
      options.isSelectedRecoveryProtected(),
      options.getOutputPriority(),
    );
    const alignmentDeadlineAtMs = performance.now() + MAX_RECOVERY_GEOMETRY_ALIGNMENT_WAIT_MS;
    let lastMismatchedRecoveryEntry: TerminalRecoveryBatchEntry | null = null;
    let stableGeometryMismatchCount = 0;

    while (performance.now() < alignmentDeadlineAtMs) {
      const requestedCols = term.cols;
      recordTerminalRecoveryRequest(reason, requestStateBytes);
      setRecoveryPhase(generation, 'requesting-recovery');
      const recoveryEntry =
        startupRecoveryRole === null
          ? await requestRecoveryEntry(reason, requestState)
          : await requestStartupTerminalRecovery(agentId, startupRecoveryRole, {
              ...getTerminalRecoveryFallbackOptions(),
              visibleTerminalCount: getStartupVisibleTerminalCount(),
            });
      if (!isActiveRestoreGeneration(generation)) {
        return null;
      }

      if (
        !shouldAlignRecoveryGeometry(reason) ||
        !requiresRecoveryGeometryAlignment(recoveryEntry) ||
        isRecoveryGeometryAligned(recoveryEntry)
      ) {
        return recoveryEntry;
      }
      lastMismatchedRecoveryEntry = recoveryEntry;

      await inputPipeline.flushPendingResizeForRecoveryAlignment();
      if (!isActiveRestoreGeneration(generation)) {
        return null;
      }
      const geometryAligned = await waitForTerminalFitReady('restore');
      if (!geometryAligned || !isActiveRestoreGeneration(generation)) {
        return null;
      }

      if (term.cols === requestedCols) {
        stableGeometryMismatchCount += 1;
      } else {
        stableGeometryMismatchCount = 0;
      }

      if (stableGeometryMismatchCount >= MAX_RECOVERY_GEOMETRY_ALIGNMENT_ATTEMPTS) {
        break;
      }
    }

    if (lastMismatchedRecoveryEntry !== null) {
      recordTerminalRecoveryGeometryAlignmentFallback();
      if (reason === 'attach') {
        return adoptAttachRecoveryGeometry(lastMismatchedRecoveryEntry)
          ? lastMismatchedRecoveryEntry
          : null;
      }
    }
    return null;
  }

  function canStartReconnectRestore(): boolean {
    return (
      hasEverAuthenticatedBrowserControl &&
      pendingReconnectRestoreState !== 'none' &&
      !isRecoveryInFlight() &&
      browserTransportState === 'connected' &&
      hasCurrentBrowserControlAuth &&
      options.isSpawnReady() &&
      !isRuntimeDisposed()
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
        const delta = decodeBase64ToUint8Array(entry.recovery.data);
        if (delta.length > 0) {
          await writeTerminalPayloadChunked(
            delta,
            getRestoreChunkSize(reason),
            shouldYieldBetweenRestoreChunks(reason),
            reason,
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
          ? decodeBase64ToUint8Array(entry.recovery.data)
          : new Uint8Array(0);
        if (reason === 'renderer-loss') {
          return;
        }
        await restoreTerminalScrollbackData(scrollback, reason);
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      }
      case 'terminal-state': {
        const terminalState = decodeBase64ToUint8Array(entry.recovery.data);
        if (reason === 'renderer-loss') {
          return;
        }
        recordTerminalRecoveryReset(reason);
        term.reset();
        await writeTerminalPayloadChunked(
          terminalState,
          getRestoreChunkSize(reason),
          shouldYieldBetweenRestoreChunks(reason),
          reason,
          getStartupWriteRenderedCallback(reason),
        );
        outputPipeline.setRenderedOutputHistory(new Uint8Array(0));
        outputPipeline.setRenderedOutputCursor(entry.outputCursor);
        return;
      }
    }

    return assertNever(entry.recovery, 'Unhandled terminal recovery entry');
  }

  async function restoreTerminalOutput(
    reason: TerminalRecoveryReason = 'renderer-loss',
  ): Promise<void> {
    if (isRuntimeDisposed() || isRecoveryInFlight()) {
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
    const restoreStartedAtMs = performance.now();
    const outputPriority = options.getOutputPriority();
    let waitForOutputIdleMs = 0;
    let pauseMs = 0;
    let recoveryFetchMs = 0;
    let applyMs = 0;
    let postApplyFitMs = 0;
    let preRecoveryFitMs = 0;
    let primaryReadinessWaitMs = 0;
    let revealSettleMs = 0;
    let resumeMs = 0;
    let recoveryKind: TerminalRecoveryBatchEntry['recovery']['kind'] = 'noop';
    let requestStateBytes = 0;
    let visiblePaintWaitMs = 0;
    let terminalMarkedReady = false;
    let shouldRestartQueuedRestore = false;
    let shouldExitAfterFinally = false;
    let resumeSucceeded = true;
    let blockingRecoveryStarted = false;
    const selectedRecoveryProtected = options.isSelectedRecoveryProtected();
    const startupRecoveryRole = getVisibleStartupRecoveryRole(
      reason,
      options.isShell,
      selectedRecoveryProtected,
      outputPriority,
    );
    const suppressRenderedTailForAttachRecovery = shouldSuppressRenderedTailForAttachRecovery(
      reason,
      options.isShell,
      outputPriority,
    );

    function startBlockingRecovery(): void {
      if (blockingRecoveryStarted) {
        return;
      }

      blockingRecoveryStarted = true;
      setRestoreBlocked(true);
      restoreWriteChunkCount = 0;
      restoreWrittenBytes = 0;
    }

    try {
      if (reason === 'renderer-loss') {
        startBlockingRecovery();
        setRecoveryPhase(generation, 'renderer-refresh');
        const rendererFitReady = await waitForTerminalFitReady('renderer-loss');
        if (!rendererFitReady || generation !== restoreGeneration || isRuntimeDisposed()) {
          return;
        }
        recordTerminalRecoveryRenderRefresh();
        term.refresh(0, Math.max(term.rows - 1, 0));
        revealSettleMs = await waitForPostRecoveryRevealSettle(reason);
        if (generation !== restoreGeneration || isRuntimeDisposed()) {
          return;
        }
        options.markTerminalReady();
        terminalMarkedReady = true;
        return;
      }

      const preRecoveryFitStartedAtMs = performance.now();
      const restoreFitReady = await waitForTerminalFitReady('restore');
      preRecoveryFitMs = performance.now() - preRecoveryFitStartedAtMs;
      if (!restoreFitReady || !isActiveRestoreGeneration(generation)) {
        return;
      }
      const primaryReadinessWaitStartedAtMs = performance.now();
      const primaryReadinessReady = await waitForPrimaryStartupReadiness(reason);
      primaryReadinessWaitMs = performance.now() - primaryReadinessWaitStartedAtMs;
      if (!primaryReadinessReady || !isActiveRestoreGeneration(generation)) {
        return;
      }
      const visiblePaintWaitStartedAtMs = performance.now();
      const visiblePaintReady = await waitForVisibleStartupPaintReadiness(reason);
      visiblePaintWaitMs = performance.now() - visiblePaintWaitStartedAtMs;
      if (!visiblePaintReady || !isActiveRestoreGeneration(generation)) {
        return;
      }
      startBlockingRecovery();
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
      const requestState =
        startupRecoveryRole === null
          ? getTerminalRecoveryRequestState(suppressRenderedTailForAttachRecovery)
          : null;
      requestStateBytes =
        requestState === null || requestState.renderedTail === null
          ? 0
          : Math.floor((requestState.renderedTail.length * 3) / 4);
      const recoveryFetchStartedAtMs = performance.now();
      const recoveryEntry = await requestGeometryAlignedRecoveryEntry(
        generation,
        reason,
        requestState,
        requestStateBytes,
      );
      recoveryFetchMs = performance.now() - recoveryFetchStartedAtMs;
      if (!recoveryEntry || !isActiveRestoreGeneration(generation)) {
        return;
      }
      recoveryKind = recoveryEntry.recovery.kind;

      const shouldBlockUi = shouldShowBlockingRestoreUI(reason, recoveryEntry);
      if (shouldBlockUi) {
        options.setStatus('restoring');
      }
      if (isVisibleSteadyStateSnapshotRecovery(reason, recoveryEntry)) {
        recordTerminalRecoveryVisibleSteadyStateSnapshot(reason);
      }

      if (shouldDropQueuedOutputBeforeRecoveryApply(reason, recoveryEntry)) {
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
      const postApplyFitStartedAtMs = performance.now();
      const postRecoveryFitReady = await waitForTerminalFitReady('restore');
      postApplyFitMs = performance.now() - postApplyFitStartedAtMs;
      if (!postRecoveryFitReady || generation !== restoreGeneration || isRuntimeDisposed()) {
        return;
      }
      // Snapshot replay already reconstructs the terminal buffer, viewport, and cursor state.
      // Forcing a follow-up scroll breaks cursor-addressed TUIs by overriding the restored viewport.
      refreshTerminalViewport();
      setRecoveryPhase(generation, 'waiting-post-reveal');
      revealSettleMs += await waitForPostRecoveryRevealSettle(reason);
      if (generation !== restoreGeneration || isRuntimeDisposed()) {
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
        postApplyFitMs: roundMilliseconds(postApplyFitMs),
        preRecoveryFitMs: roundMilliseconds(preRecoveryFitMs),
        primaryReadinessWaitMs: roundMilliseconds(primaryReadinessWaitMs),
        reason,
        recoveryFetchMs: roundMilliseconds(recoveryFetchMs),
        recoveryKind,
        revealSettleMs: roundMilliseconds(revealSettleMs),
        requestStateBytes,
        requestedAtMs: roundMilliseconds(restoreStartedAtMs),
        restoreTotalMs: roundMilliseconds(performance.now() - restoreStartedAtMs),
        resumeMs: roundMilliseconds(resumeMs),
        selectedVisibleFastPath: isPrioritySelectedVisibleReconnectRecovery(reason),
        selectedRecoveryProtected,
        visiblePaintWaitMs: roundMilliseconds(visiblePaintWaitMs),
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
        const restoreStaleOrDisposed = restoreGeneration !== generation || isRuntimeDisposed();
        if (pendingReconnectRestoreState === 'queued') {
          clearRecoveryStateIfActive(generation);
        }
        if (pendingReconnectRestoreState === 'queued' && startReconnectRestoreIfReady()) {
          shouldRestartQueuedRestore = true;
          outputPipeline.recoverFlowControlIfIdle();
        } else if (restoreStaleOrDisposed) {
          clearRecoveryStateIfActive(generation);
          outputPipeline.recoverFlowControlIfIdle();
          shouldExitAfterFinally = true;
        } else if (outputPipeline.hasQueuedOutput()) {
          outputPipeline.scheduleOutputFlush();
        }
        if (
          !shouldRestartQueuedRestore &&
          !terminalMarkedReady &&
          !isRuntimeDisposed() &&
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
          if (restoreGeneration !== generation || isRuntimeDisposed() || options.isSpawnFailed()) {
            shouldExitAfterFinally = true;
          } else {
            if (shouldDrainQueuedOutputBeforeRecovery(reason)) {
              setRecoveryPhase(generation, 'waiting-post-reveal');
              revealSettleMs += await waitForPostRecoveryRevealSettle(reason);
            }
            if (
              restoreGeneration !== generation ||
              isRuntimeDisposed() ||
              options.isSpawnFailed()
            ) {
              shouldExitAfterFinally = true;
            } else {
              setRecoveryPhase(generation, 'marking-ready');
              options.markTerminalReady();
              terminalMarkedReady = true;
              void inputPipeline.flushPendingResize();
              inputPipeline.flushPendingInput();
              inputPipeline.drainInputQueue();
            }
          }
        }
        if (
          selectedRecoveryStarted &&
          !shouldRestartQueuedRestore &&
          terminalMarkedReady &&
          isActiveRestoreGeneration(generation)
        ) {
          options.onSelectedRecoverySettle?.();
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
    dispose,
    handleBrowserControlAuthenticated(): void {
      hasEverAuthenticatedBrowserControl = true;
      hasCurrentBrowserControlAuth = true;
      startReconnectRestoreIfReady();
    },
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
          return;
        case 'disconnected':
        case 'reconnecting':
          hasCurrentBrowserControlAuth = false;
          if (hasEverAuthenticatedBrowserControl) {
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
    notifySpawnReady(): void {
      startReconnectRestoreIfReady();
    },
    restoreTerminalOutput,
  };
}
