import type { Terminal } from '@xterm/xterm';

import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import { assertNever } from '../../lib/assert-never';
import type { BrowserControlConnectionState } from '../../lib/browser-control-client';
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
  isSelectedRecoveryProtected: boolean,
  outputPriority: TerminalOutputPriority,
): TerminalStartupRecoveryRole | null {
  if (reason !== 'attach') {
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

export function createTerminalRecoveryRuntime(
  options: CreateTerminalRecoveryRuntimeOptions,
): TerminalRecoveryRuntime {
  const { agentId, inputPipeline, outputPipeline, term } = options;

  let browserTransportState: ReconnectAwareBrowserTransportConnectionState =
    options.initialBrowserTransportState ?? 'disconnected';
  let hasConnected = browserTransportState === 'connected';
  let pendingReconnectRestoreState: PendingReconnectRestoreState = 'none';
  let recoveryState: TerminalRecoveryState = { kind: 'idle' };
  let restoreBlocked = false;
  // restoreGeneration invalidates stale restore attempts when connection state changes,
  // and also provides a monotonic token for each active restore.
  let restoreGeneration = 0;
  let restoreWriteChunkCount = 0;
  let restoreWrittenBytes = 0;

  function getStartupVisibleTerminalCount(): number {
    const startupPaintSnapshot = options.getStartupPaintCoordinationSnapshot?.();
    if (!startupPaintSnapshot) {
      return 0;
    }

    const selectedTerminalCount =
      startupPaintSnapshot.selectedPaintReady || startupPaintSnapshot.selectedPendingCount > 0
        ? 1
        : 0;
    return (
      selectedTerminalCount +
      startupPaintSnapshot.visiblePendingCount +
      startupPaintSnapshot.visibleReadyCount
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
      !options.isDisposed()
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

  function getPostRecoveryRevealSettleDelayMs(): number {
    if (!options.isSelectedRecoveryProtected()) {
      return POST_RECOVERY_REVEAL_SETTLE_MS;
    }

    const activeReason = recoveryState.kind === 'restoring' ? recoveryState.reason : null;
    if (activeReason === 'attach' || activeReason === 'reconnect') {
      return 0;
    }

    return POST_RECOVERY_REVEAL_SETTLE_MS;
  }

  async function waitForPostRecoveryRevealSettle(): Promise<void> {
    const revealSettleDelayMs = getPostRecoveryRevealSettleDelayMs();
    if (revealSettleDelayMs > 0) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, revealSettleDelayMs);
      });
    }
    await waitForStableRevealFrame();
  }

  async function waitForStableRevealFrame(): Promise<void> {
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
    if (reason !== 'attach') {
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
    if (reason !== 'attach') {
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

  async function waitForPrimaryStartupReadiness(reason: TerminalRecoveryReason): Promise<void> {
    if (!shouldDeferVisibleStartupRecoveryUntilPrimaryReady(reason)) {
      return;
    }

    const outputPriority = options.getOutputPriority();
    if (outputPriority !== 'active-visible' && outputPriority !== 'visible-background') {
      return;
    }

    const waitsForSwitchWindow = isVisibleStartupRecoveryDeferredBySwitchWindow(
      getTerminalSwitchWindowSnapshot(),
    );
    if (!waitsForSwitchWindow) {
      return;
    }

    const waitBudgetMs = MAX_STARTUP_PRIMARY_READY_SIBLING_DEFER_MS;
    const waitStartedAtMs = performance.now();

    await new Promise<void>((resolve) => {
      let settled = false;

      const maybeFinish = (): void => {
        const stillWaitingForSwitchWindow = isVisibleStartupRecoveryDeferredBySwitchWindow(
          getTerminalSwitchWindowSnapshot(),
        );
        if (!stillWaitingForSwitchWindow) {
          finish();
        }
      };

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanupSwitchWindowSubscription();
        window.clearTimeout(timeoutId);
        resolve();
      };

      const cleanupSwitchWindowSubscription = subscribeTerminalSwitchWindowChanges(maybeFinish);
      const timeoutId = window.setTimeout(finish, waitBudgetMs);
    });

    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: outputPriority,
      waitMs: Math.max(0, performance.now() - waitStartedAtMs),
    });
  }

  async function waitForVisibleStartupPaintReadiness(
    reason: TerminalRecoveryReason,
  ): Promise<void> {
    if (!shouldDeferHiddenStartupRecoveryUntilVisiblePaint(reason)) {
      return;
    }

    const getSnapshot = options.getStartupPaintCoordinationSnapshot;
    const subscribe = options.subscribeStartupPaintCoordinationChanges;
    if (!getSnapshot || !subscribe) {
      return;
    }

    const initialSnapshot = getSnapshot();
    if (!isHiddenStartupRecoveryDeferredByPaintSnapshot(initialSnapshot)) {
      return;
    }

    const waitStartedAtMs = performance.now();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve();
      };
      const cleanupSubscription = subscribe(() => {
        const snapshot = getSnapshot();
        if (!isHiddenStartupRecoveryDeferredByPaintSnapshot(snapshot)) {
          finish();
        }
      });
      const timeoutId = window.setTimeout(finish, MAX_STARTUP_VISIBLE_PAINT_HIDDEN_DEFER_MS);
      const cleanup = (): void => {
        cleanupSubscription();
        window.clearTimeout(timeoutId);
      };
    });

    recordTerminalRecoveryStartupFirstPaintDeferral({
      priority: 'hidden',
      waitMs: Math.max(0, performance.now() - waitStartedAtMs),
    });
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
      reason === 'attach' ? (options.onStartupWriteRendered ?? null) : null,
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
    snapshotByteLimit: number | null;
  } {
    const isAttachRecovery =
      recoveryState.kind === 'restoring' && recoveryState.reason === 'attach';
    const attachRequestTailBytes = isAttachRecovery
      ? getAttachRecoveryRequestTailByteLimit(options.getOutputPriority())
      : undefined;
    const requestTailBytes =
      attachRequestTailBytes === undefined
        ? undefined
        : isDenseVisibleStartupAttach()
          ? Math.min(
              attachRequestTailBytes,
              DENSE_STARTUP_ATTACH_REQUEST_TAIL_BYTES_BY_PRIORITY[options.getOutputPriority()],
            )
          : attachRequestTailBytes;
    const requestState = outputPipeline.getRecoveryRequestState(requestTailBytes);
    const attachSnapshotByteLimit = isAttachRecovery
      ? getAttachRecoverySnapshotByteLimit(options.getOutputPriority())
      : null;
    return {
      outputCursor: requestState.outputCursor,
      renderedTail:
        requestState.renderedTail && requestState.renderedTail.length > 0
          ? uint8ArrayToBase64(requestState.renderedTail)
          : null,
      snapshotByteLimit:
        attachSnapshotByteLimit === null
          ? null
          : isDenseVisibleStartupAttach()
            ? Math.min(
                attachSnapshotByteLimit,
                DENSE_STARTUP_ATTACH_SNAPSHOT_BYTE_LIMIT_BY_PRIORITY[options.getOutputPriority()],
              )
            : attachSnapshotByteLimit,
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

  function shouldDropQueuedOutputBeforeRecoveryApply(
    reason: TerminalRecoveryReason,
    entry: TerminalRecoveryBatchEntry,
  ): boolean {
    return reason === 'attach'
      ? entry.recovery.kind !== 'noop'
      : entry.recovery.kind === 'snapshot';
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

  async function requestRecoveryEntry(
    reason: TerminalRecoveryReason,
    requestState: ReturnType<typeof getTerminalRecoveryRequestState> | null,
  ): Promise<TerminalRecoveryBatchEntry> {
    if (reason === 'reconnect' && options.isSelectedRecoveryProtected()) {
      return requestReconnectTerminalRecovery(
        agentId,
        requestState as ReturnType<typeof getTerminalRecoveryRequestState>,
        { immediate: true },
      );
    }

    const recoveryRequest = getTerminalRecoveryRequest(reason);
    return recoveryRequest(
      agentId,
      requestState as ReturnType<typeof getTerminalRecoveryRequestState>,
    );
  }

  function shouldAlignRecoveryGeometry(reason: TerminalRecoveryReason): boolean {
    switch (reason) {
      case 'attach':
      case 'renderer-loss':
        return false;
      case 'backpressure':
      case 'hibernate':
      case 'reconnect':
        return true;
    }

    return assertNever(reason, 'Unhandled terminal recovery reason');
  }

  async function requestGeometryAlignedRecoveryEntry(
    generation: number,
    reason: TerminalRecoveryReason,
    requestState: ReturnType<typeof getTerminalRecoveryRequestState> | null,
    requestStateBytes: number,
  ): Promise<TerminalRecoveryBatchEntry | null> {
    const startupRecoveryRole = getVisibleStartupRecoveryRole(
      reason,
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
          : await requestStartupTerminalRecovery(agentId, startupRecoveryRole);
      if (!isActiveRestoreGeneration(generation)) {
        return null;
      }

      if (!shouldAlignRecoveryGeometry(reason) || recoveryEntry.cols === term.cols) {
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
    }
    return lastMismatchedRecoveryEntry;
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
    let blockingRecoveryStarted = false;
    const selectedRecoveryProtected = options.isSelectedRecoveryProtected();
    const startupRecoveryRole = getVisibleStartupRecoveryRole(
      reason,
      selectedRecoveryProtected,
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

      const restoreFitReady = await waitForTerminalFitReady('restore');
      if (!restoreFitReady || !isActiveRestoreGeneration(generation)) {
        return;
      }
      await waitForPrimaryStartupReadiness(reason);
      await waitForVisibleStartupPaintReadiness(reason);
      if (!isActiveRestoreGeneration(generation)) {
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
      const requestState = startupRecoveryRole === null ? getTerminalRecoveryRequestState() : null;
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
      const postRecoveryFitReady = await waitForTerminalFitReady('restore');
      if (!postRecoveryFitReady || generation !== restoreGeneration || options.isDisposed()) {
        return;
      }
      // Snapshot replay already reconstructs the terminal buffer, viewport, and cursor state.
      // Forcing a follow-up scroll breaks cursor-addressed TUIs by overriding the restored viewport.
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
    notifySpawnReady(): void {
      startReconnectRestoreIfReady();
    },
    restoreTerminalOutput,
  };
}
