import * as pty from 'node-pty';
import type { PauseReason } from '../remote/protocol.js';
import type { AgentRuntimeIdentity } from '../../src/domain/agent-runners.js';
import type { TerminalInputTraceMessage } from '../../src/domain/terminal-input-tracing.js';
import {
  getTerminalInputBatchPlan,
  splitTerminalInputChunks,
  takeQueuedTerminalInputBatch,
  type QueuedTerminalInputBatch,
} from '../../src/lib/terminal-input-batching.js';
import {
  createTerminalOrderedState,
  enqueueTerminalOrderedRequest,
  hasTerminalInputOrder,
  hasTerminalResizeOrder,
  type OrderedTerminalResizeRequest,
  type TerminalOrderedState,
  type TerminalInputOrderToken,
  type TerminalResizeOrderToken,
} from '../../src/terminal-core/terminal-ordering.js';
import type { TerminalStartupRecoveryRole } from '../../src/ipc/types.js';
import { truncatePreview } from '../../src/lib/preview-heuristics.js';
import { RingBuffer } from '../remote/ring-buffer.js';
import { resolveUserShell } from '../user-shell.js';
import {
  recordAgentExit,
  recordAgentOutput,
  recordAgentPauseState,
  recordAgentSpawn,
} from './agent-supervision.js';
import { validateCommand } from './command-resolver.js';
import {
  recordPtyInputFlush,
  recordPtyInputEnqueue,
  recordPtyInputQueueCleared,
  recordTerminalInputTraceBackendOutputFlushed,
  recordTerminalInputTraceFailure,
  recordTerminalInputTracePtyOutput,
  recordTerminalInputTraceServerReceived,
  recordTerminalInputTracePtyEnqueued,
  recordTerminalInputTracePtyFlushed,
  recordTerminalInputTracePtyWritten,
  recordTerminalStateRecoveryFallback,
  recordTerminalScrollbackCapacityChange,
  recordPtyInputWriteFailure,
} from './runtime-diagnostics.js';
import { observeTaskPortsFromOutput } from './task-ports.js';
import { TerminalStateMirror } from './terminal-state-mirror.js';
import { TEST_SHELL_HOME_ENV_KEY } from '../../src/lib/test-shell-env.js';
import { applyTestShellSandbox } from './test-shell-sandbox.js';

interface PtySession {
  proc: pty.IPty;
  channelIds: Set<string>;
  sendToChannel: (channelId: string, msg: unknown) => void;
  taskId: string;
  agentId: string;
  runnerIdentity?: AgentRuntimeIdentity;
  onExitCleanup?: () => Promise<void> | void;
  runnerCleanupPromise?: Promise<void>;
  runnerCleanupAwaited: boolean;
  terminationPromise?: Promise<void>;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  exited: boolean;
  isShell: boolean;
  isInternalNodeProcess: boolean;
  acceptsInput: boolean;
  isPaused: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  inputFlushTimer: InputFlushTimer | null;
  subscribers: Set<(encoded: string) => void>;
  scrollback: RingBuffer;
  terminalStateMirror: TerminalStateMirror;
  batchBuf: Buffer;
  batchOffset: number;
  outputCursor: number;
  pendingInputQueue: QueuedPtyInputBatch[];
  pendingInputChars: number;
  orderedInputState: TerminalOrderedState<QueuedPtyInputBatch>;
  orderedResizeState: TerminalOrderedState<OrderedTerminalResizeRequest>;
  recentInteractiveOutputDeadlineAtMs: number;
  exitDiagnosticTail: RingBuffer;
  pauseState: PauseReason | null;
  pauseReasons: Map<PauseReason, number>;
  globalRestorePauseLeases: Map<string, RestorePauseLease>;
  scopedPauseReasons: {
    'flow-control': Map<string, FlowControlPauseLease>;
    restore: Map<string, Map<string, RestorePauseLease>>;
  };
  lifecycleGeneration: number;
  disposed: boolean;
}

export interface AgentSpawnDisposition {
  channelAttached: boolean;
  kind: 'attached-existing' | 'created-session';
  replacedSessionCleanup?: Promise<void>;
}

interface PauseLease {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

type FlowControlPauseLease = PauseLease;
type RestorePauseLease = PauseLease;

interface TerminalInputTraceRequest {
  clientId: string | null;
  requestId: string;
  taskId: string | null;
  trace: TerminalInputTraceMessage;
}

interface TerminalOrderCallbacks {
  onApplied?: () => void;
  onDropped?: () => void;
}

interface QueuedPtyInputBatch extends QueuedTerminalInputBatch {
  onApplied?: () => void;
  onDropped?: () => void;
  traceRequest?: TerminalInputTraceRequest;
}

const TERMINAL_ENV_BLOCK_LIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  TEST_SHELL_HOME_ENV_KEY,
]);

const PRESENCE_BASED_COLOR_SUPPRESSION_ENV_KEYS = ['NO_COLOR', 'NODE_DISABLE_COLORS'] as const;

const VALUE_BASED_COLOR_SUPPRESSION_ENV_VALUES = {
  CLICOLOR: new Set(['0']),
  FORCE_COLOR: new Set(['0', 'false']),
  NPM_CONFIG_COLOR: new Set(['0', 'false']),
} as const;

function normalizeEnvKey(key: string): string {
  return key.toUpperCase();
}

function deleteEnvKey(env: Record<string, string>, key: string): void {
  const normalizedKey = normalizeEnvKey(key);
  for (const envKey of Object.keys(env)) {
    if (normalizeEnvKey(envKey) === normalizedKey) {
      Reflect.deleteProperty(env, envKey);
    }
  }
}

function restoreExplicitEnvKey(
  spawnEnv: Record<string, string>,
  explicitEnvOverrides: Record<string, string>,
  key: string,
): boolean {
  const normalizedKey = normalizeEnvKey(key);
  const explicitMatches = Object.entries(explicitEnvOverrides).filter(([envKey]) => {
    return normalizeEnvKey(envKey) === normalizedKey;
  });
  if (explicitMatches.length === 0) {
    return false;
  }

  deleteEnvKey(spawnEnv, key);
  for (const [envKey, value] of explicitMatches) {
    spawnEnv[envKey] = value;
  }
  return true;
}

function hasEnvValue(
  env: Record<string, string>,
  key: string,
  matches: (value: string) => boolean,
): boolean {
  const normalizedKey = normalizeEnvKey(key);
  for (const [envKey, value] of Object.entries(env)) {
    if (normalizeEnvKey(envKey) === normalizedKey && matches(value)) {
      return true;
    }
  }

  return false;
}

function isTerminalEnvBlocked(key: string): boolean {
  return TERMINAL_ENV_BLOCK_LIST.has(normalizeEnvKey(key));
}

function removeInheritedTerminalColorSuppression(
  spawnEnv: Record<string, string>,
  explicitEnvOverrides: Record<string, string>,
): void {
  for (const key of PRESENCE_BASED_COLOR_SUPPRESSION_ENV_KEYS) {
    if (!restoreExplicitEnvKey(spawnEnv, explicitEnvOverrides, key)) {
      deleteEnvKey(spawnEnv, key);
    }
  }

  for (const [key, disabledValues] of Object.entries(VALUE_BASED_COLOR_SUPPRESSION_ENV_VALUES)) {
    if (restoreExplicitEnvKey(spawnEnv, explicitEnvOverrides, key)) {
      continue;
    }

    const hasDisabledValue = hasEnvValue(spawnEnv, key, (value) =>
      disabledValues.has(value.trim().toLowerCase()),
    );
    if (hasDisabledValue) {
      deleteEnvKey(spawnEnv, key);
    }
  }
}

export type AgentTerminalRecovery =
  | {
      cols: number;
      kind: 'delta';
      data: Buffer;
      overlapBytes: number;
      outputCursor: number;
      rows: number;
      source: 'cursor' | 'tail';
    }
  | {
      cols: number;
      kind: 'noop';
      outputCursor: number;
      rows: number;
    }
  | {
      cols: number;
      kind: 'snapshot';
      data: Buffer | null;
      outputCursor: number;
      rows: number;
    }
  | {
      // Cursor miss with no rendered tail where a capped snapshot would lose
      // retained history: ask the client for one bounded tail (phase two)
      // before falling back to a destructive truncated snapshot.
      cols: number;
      kind: 'tail-needed';
      outputCursor: number;
      rows: number;
    }
  | {
      cols: number;
      data: Buffer;
      kind: 'terminal-state';
      outputCursor: number;
      rows: number;
    };

type InputFlushTimer =
  | {
      handle: ReturnType<typeof setImmediate>;
      kind: 'immediate';
    }
  | {
      handle: ReturnType<typeof setTimeout>;
      kind: 'timeout';
    };

const sessions = new Map<string, PtySession>();
const pendingRunnerCleanupSessions = new Map<string, Set<PtySession>>();
const terminatingSessions = new Map<string, Set<PtySession>>();
const PTY_EXIT_GRACE_MS = 5_000;
const PTY_FORCE_EXIT_GRACE_MS = 1_000;
const nextLifecycleGenerationByAgentId = new Map<string, number>();
const TERMINAL_INPUT_TRACE_PREVIEW_LIMIT = 96;

// --- PTY event bus for spawn/exit notifications ---

type PtyEventType = 'spawn' | 'exit' | 'list-changed' | 'pause' | 'resume';
type PtyEventListener = (agentId: string, data?: unknown) => void;
const eventListeners = new Map<PtyEventType, Set<PtyEventListener>>();

/** Register a listener for PTY lifecycle events. Returns an unsubscribe function. */
export function onPtyEvent(event: PtyEventType, listener: PtyEventListener): () => void {
  let listeners = eventListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(event, listeners);
  }
  listeners.add(listener);
  return () => {
    eventListeners.get(event)?.delete(listener);
  };
}

function emitPtyEvent(event: PtyEventType, agentId: string, data?: unknown): void {
  eventListeners.get(event)?.forEach((fn) => fn(agentId, data));
}

/** Notify listeners that the agent list has changed (e.g. task deleted). */
export function notifyAgentListChanged(): void {
  emitPtyEvent('list-changed', '');
}

const BATCH_MAX = 64 * 1024;
const BATCH_INTERVAL = 4; // ms
const INPUT_BATCH_INTERVAL = 1; // ms
const INPUT_BATCH_MAX_CHARS = 16 * 1024;
const INTERACTIVE_OUTPUT_FLUSH_WINDOW_MS = 180;
const INTERACTIVE_OUTPUT_MAX_BYTES = 4 * 1024;
const FLOW_CONTROL_PAUSE_LEASE_TTL_MS = 15_000;
const RESTORE_PAUSE_LEASE_TTL_MS = 30_000;
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;
const STARTUP_VISIBLE_TERMINAL_DENSE_THRESHOLD = 4;
const STARTUP_SNAPSHOT_BYTE_LIMIT_BY_ROLE = {
  selected: 256 * 1024,
  'visible-sibling': 96 * 1024,
} satisfies Record<TerminalStartupRecoveryRole, number>;
const DENSE_STARTUP_SNAPSHOT_BYTE_LIMIT_BY_ROLE = {
  selected: 192 * 1024,
  'visible-sibling': 48 * 1024,
} satisfies Record<TerminalStartupRecoveryRole, number>;
const LEGACY_RESTORE_LEASE_ID = '__legacy_restore__';
let restorePauseLeaseSequence = 0;

export { validateCommand } from './command-resolver.js';

function clearFlushTimer(session: PtySession): void {
  if (!session.flushTimer) return;
  clearTimeout(session.flushTimer);
  session.flushTimer = null;
}

function clearInputFlushTimer(session: PtySession): void {
  if (!session.inputFlushTimer) return;
  if (session.inputFlushTimer.kind === 'immediate') {
    clearImmediate(session.inputFlushTimer.handle);
  } else {
    clearTimeout(session.inputFlushTimer.handle);
  }
  session.inputFlushTimer = null;
}

function sendToAttachedChannels(session: PtySession, msg: unknown): void {
  for (const channelId of session.channelIds) {
    session.sendToChannel(channelId, msg);
  }
}

function flushSessionBatch(session: PtySession): void {
  if (session.batchOffset === 0) {
    clearFlushTimer(session);
    return;
  }

  const batch = session.batchBuf.subarray(0, session.batchOffset);
  // Flush-time scans run on the already-batched buffer (one utf8 decode per
  // flush instead of per PTY chunk) and MUST run before the no-subscriber
  // early return so unattached agents keep supervision, port observation,
  // and the terminal-state mirror live.
  const batchText = batch.toString('utf8');
  recordAgentOutput(session.agentId, batchText);
  observeTaskPortsFromOutput(session.taskId, batchText);
  recordTerminalInputTracePtyOutput(session.agentId, batchText);
  session.terminalStateMirror.enqueueOutput(Buffer.from(batch), session.outputCursor);

  if (session.channelIds.size === 0 && session.subscribers.size === 0) {
    session.batchOffset = 0;
    clearFlushTimer(session);
    return;
  }

  recordTerminalInputTraceBackendOutputFlushed(session.agentId, batchText);
  const encoded = batch.toString('base64');
  sendToAttachedChannels(session, { type: 'Data', data: encoded });
  for (const sub of session.subscribers) {
    sub(encoded);
  }
  session.batchOffset = 0;
  clearFlushTimer(session);
}

function appendToBatchBuffer(session: PtySession, chunk: Buffer): void {
  let readOffset = 0;
  while (readOffset < chunk.length) {
    if (session.batchOffset === BATCH_MAX) flushSessionBatch(session);
    const writable = BATCH_MAX - session.batchOffset;
    const toCopy = Math.min(writable, chunk.length - readOffset);
    chunk.copy(session.batchBuf, session.batchOffset, readOffset, readOffset + toCopy);
    session.batchOffset += toCopy;
    // The byte cursor advances with the batch buffer so a flush always sees
    // outputCursor as the cursor of the batch's final byte.
    session.outputCursor += toCopy;
    readOffset += toCopy;
    if (session.batchOffset === BATCH_MAX) flushSessionBatch(session);
  }
}

function normalizePtyOutputBytes(data: string | Uint8Array): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

function getSessionOrThrow(agentId: string): PtySession {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  return session;
}

function getLongestRecoveryOverlapBytes(renderedTail: Buffer, scrollback: Buffer): number {
  if (renderedTail.length === 0 || scrollback.length === 0) {
    return 0;
  }

  const renderedTailLastByte = renderedTail[renderedTail.length - 1];
  if (renderedTailLastByte === undefined || !scrollback.includes(renderedTailLastByte)) {
    return 0;
  }

  const combinedLength = scrollback.length + 1 + renderedTail.length;
  const prefix = new Uint32Array(combinedLength);

  function getValue(index: number): number {
    if (index < scrollback.length) {
      return scrollback[index] ?? 0;
    }

    if (index === scrollback.length) {
      return 256;
    }

    return renderedTail[index - scrollback.length - 1] ?? 0;
  }

  for (let index = 1; index < combinedLength; index += 1) {
    let matchedLength = prefix[index - 1] ?? 0;
    const currentValue = getValue(index);

    while (matchedLength > 0 && currentValue !== getValue(matchedLength)) {
      matchedLength = prefix[matchedLength - 1] ?? 0;
    }

    if (currentValue === getValue(matchedLength)) {
      matchedLength += 1;
    }

    prefix[index] = matchedLength;
  }

  return prefix[combinedLength - 1] ?? 0;
}

function buildAgentTerminalRecovery(
  scrollback: Buffer,
  cols: number,
  rows: number,
  renderedTail: Buffer | null,
  outputCursor: number,
  requestedOutputCursor: number | null,
  snapshotByteLimit: number | null,
): AgentTerminalRecovery {
  const snapshotScrollback =
    snapshotByteLimit !== null && snapshotByteLimit < scrollback.length
      ? scrollback.subarray(scrollback.length - snapshotByteLimit)
      : scrollback;
  const retainedStartCursor = Math.max(0, outputCursor - scrollback.length);

  if (
    requestedOutputCursor !== null &&
    requestedOutputCursor >= retainedStartCursor &&
    requestedOutputCursor <= outputCursor
  ) {
    if (requestedOutputCursor === outputCursor) {
      return {
        cols,
        kind: 'noop',
        outputCursor,
        rows,
      };
    }

    const deltaStartIndex = Math.max(0, requestedOutputCursor - retainedStartCursor);
    const delta = scrollback.subarray(deltaStartIndex);
    return {
      cols,
      data: delta,
      kind: 'delta',
      outputCursor,
      overlapBytes: 0,
      rows,
      source: 'cursor',
    };
  }

  if (scrollback.length === 0) {
    if (!renderedTail || renderedTail.length === 0) {
      return {
        cols,
        kind: 'noop',
        outputCursor,
        rows,
      };
    }

    return {
      cols,
      data: Buffer.alloc(0),
      kind: 'snapshot',
      outputCursor,
      rows,
    };
  }

  if (!renderedTail || renderedTail.length === 0) {
    // A request that claimed cursor continuity but missed the retained window
    // has renderer history worth overlap-matching. When the capped snapshot
    // would truncate retained scrollback, ask for one bounded tail first
    // instead of destroying that history with a truncated reset.
    if (
      requestedOutputCursor !== null &&
      snapshotByteLimit !== null &&
      scrollback.length > snapshotByteLimit
    ) {
      return {
        cols,
        kind: 'tail-needed',
        outputCursor,
        rows,
      };
    }

    return {
      cols,
      data: snapshotScrollback,
      kind: 'snapshot',
      outputCursor,
      rows,
    };
  }

  if (scrollback.equals(renderedTail)) {
    return {
      cols,
      kind: 'noop',
      outputCursor,
      rows,
    };
  }

  const exactMatchIndex = scrollback.lastIndexOf(renderedTail);
  if (exactMatchIndex >= 0) {
    const delta = scrollback.subarray(exactMatchIndex + renderedTail.length);
    if (delta.length === 0) {
      return {
        cols,
        kind: 'noop',
        outputCursor,
        rows,
      };
    }

    return {
      cols,
      data: delta,
      kind: 'delta',
      outputCursor,
      overlapBytes: renderedTail.length,
      rows,
      source: 'tail',
    };
  }

  const overlapBytes = getLongestRecoveryOverlapBytes(renderedTail, scrollback);
  if (overlapBytes > 0) {
    return {
      cols,
      data: scrollback.subarray(overlapBytes),
      kind: 'delta',
      outputCursor,
      overlapBytes,
      rows,
      source: 'tail',
    };
  }

  return {
    cols,
    data: snapshotScrollback,
    kind: 'snapshot',
    outputCursor,
    rows,
  };
}

function getStartupRecoverySnapshotByteLimit(
  role: TerminalStartupRecoveryRole,
  visibleTerminalCount: number,
): number {
  if (visibleTerminalCount >= STARTUP_VISIBLE_TERMINAL_DENSE_THRESHOLD) {
    return DENSE_STARTUP_SNAPSHOT_BYTE_LIMIT_BY_ROLE[role];
  }

  return STARTUP_SNAPSHOT_BYTE_LIMIT_BY_ROLE[role];
}

function buildStartupSnapshotRecovery(
  scrollback: Buffer,
  cols: number,
  rows: number,
  outputCursor: number,
  snapshotByteLimit: number,
): AgentTerminalRecovery {
  const snapshotScrollback =
    snapshotByteLimit < scrollback.length
      ? scrollback.subarray(scrollback.length - snapshotByteLimit)
      : scrollback;
  return {
    cols,
    data: snapshotScrollback,
    kind: 'snapshot',
    outputCursor,
    rows,
  };
}

function getTailLines(buffer: Buffer): string[] {
  return buffer
    .toString('utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .slice(-MAX_LINES);
}

function clearPendingInput(session: PtySession): void {
  if (session.pendingInputChars > 0) {
    recordPtyInputQueueCleared();
  }
  for (const request of session.pendingInputQueue) {
    request.onDropped?.();
  }
  for (const request of session.orderedInputState.pending.values()) {
    request.onDropped?.();
  }
  session.pendingInputQueue = [];
  session.pendingInputChars = 0;
  session.orderedInputState.pending.clear();
  clearInputFlushTimer(session);
}

function shouldFlushOutputImmediately(session: PtySession, chunkLength: number): boolean {
  if (chunkLength === 0) {
    return false;
  }

  const now = Date.now();
  return (
    chunkLength <= INTERACTIVE_OUTPUT_MAX_BYTES &&
    now <= session.recentInteractiveOutputDeadlineAtMs
  );
}

function shouldArmInteractiveOutputFlushWindow(
  data: string,
  traceEntries: readonly TerminalInputTraceRequest[],
): boolean {
  if (traceEntries.some((entry) => entry.trace.inputKind !== 'paste')) {
    return true;
  }

  return getTerminalInputBatchPlan(data).flushMode === 'interactive';
}

function stopAcceptingInput(session: PtySession): void {
  session.acceptsInput = false;
  clearPendingInput(session);
}

function warnSessionCleanupFailure(session: PtySession, error: unknown): void {
  console.warn(`Failed to clean up runner for agent ${session.agentId}:`, error);
}

function createPtyLifecycleError(message: string, failures: unknown[]): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'cause', {
    configurable: true,
    value: failures,
    writable: true,
  });
  return error;
}

function rememberPendingRunnerCleanup(session: PtySession): void {
  if (!session.onExitCleanup) {
    return;
  }

  const pendingSessions = pendingRunnerCleanupSessions.get(session.agentId) ?? new Set();
  pendingSessions.add(session);
  pendingRunnerCleanupSessions.set(session.agentId, pendingSessions);
}

function forgetPendingRunnerCleanup(session: PtySession): void {
  const pendingSessions = pendingRunnerCleanupSessions.get(session.agentId);
  if (!pendingSessions) {
    return;
  }

  pendingSessions.delete(session);
  if (pendingSessions.size === 0) {
    pendingRunnerCleanupSessions.delete(session.agentId);
  }
}

function cleanupSessionRunner(session: PtySession): Promise<void> {
  if (!session.runnerCleanupPromise) {
    rememberPendingRunnerCleanup(session);
    let cleanupAttempt: Promise<void>;
    try {
      cleanupAttempt = Promise.resolve(session.onExitCleanup?.());
    } catch (error) {
      cleanupAttempt = Promise.reject(error);
    }

    session.runnerCleanupPromise = cleanupAttempt.then(
      () => {
        forgetPendingRunnerCleanup(session);
      },
      (error: unknown) => {
        throw error;
      },
    );
  }

  return session.runnerCleanupPromise;
}

function disposeSessionResources(session: PtySession): void {
  if (!session.disposed) {
    session.disposed = true;
    clearFlushTimer(session);
    stopAcceptingInput(session);
    clearAllAutomaticPauseState(session);
    session.terminalStateMirror.dispose();
  }
}

function cleanupSessionResources(session: PtySession): Promise<void> {
  disposeSessionResources(session);
  return cleanupSessionRunner(session);
}

function cleanupSessionResourcesBestEffort(session: PtySession): void {
  void cleanupSessionResources(session).catch((error: unknown) => {
    delete session.runnerCleanupPromise;
    warnSessionCleanupFailure(session, error);
  });
}

function waitForSessionExit(session: PtySession, timeoutMs: number): Promise<boolean> {
  if (session.exited) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void session.exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function rememberTerminatingSession(session: PtySession): void {
  const ownedSessions = terminatingSessions.get(session.agentId) ?? new Set();
  ownedSessions.add(session);
  terminatingSessions.set(session.agentId, ownedSessions);
}

function forgetTerminatingSession(session: PtySession): void {
  const ownedSessions = terminatingSessions.get(session.agentId);
  if (!ownedSessions) {
    return;
  }
  ownedSessions.delete(session);
  if (ownedSessions.size === 0) {
    terminatingSessions.delete(session.agentId);
  }
}

async function performSessionTermination(session: PtySession): Promise<void> {
  if (session.exited) {
    return;
  }
  session.proc.kill();
  if (await waitForSessionExit(session, PTY_EXIT_GRACE_MS)) {
    return;
  }

  session.proc.kill('SIGKILL');
  if (await waitForSessionExit(session, PTY_FORCE_EXIT_GRACE_MS)) {
    return;
  }

  throw new Error(
    `Agent ${session.agentId} did not exit within ${PTY_EXIT_GRACE_MS + PTY_FORCE_EXIT_GRACE_MS}ms`,
  );
}

function terminateSessionAndWait(session: PtySession): Promise<void> {
  if (!session.terminationPromise) {
    session.terminationPromise = performSessionTermination(session).then(
      () => {
        forgetTerminatingSession(session);
      },
      (error: unknown) => {
        delete session.terminationPromise;
        throw error;
      },
    );
  }
  return session.terminationPromise;
}

async function terminateSessionAndCleanup(session: PtySession): Promise<void> {
  session.runnerCleanupAwaited = true;
  const termination = terminateSessionAndWait(session);
  const cleanup = termination.then(
    () =>
      cleanupSessionResources(session).catch((cleanupError: unknown) => {
        delete session.runnerCleanupPromise;
        throw cleanupError;
      }),
    async (terminationError: unknown) => {
      try {
        await cleanupSessionResources(session);
      } catch (cleanupError) {
        delete session.runnerCleanupPromise;
        throw createPtyLifecycleError(
          `Failed to stop agent ${session.agentId} and clean its runner`,
          [terminationError, cleanupError],
        );
      }
      throw terminationError;
    },
  );
  await cleanup;
}

function replaceExistingSession(agentId: string, session: PtySession): Promise<void> {
  sessions.delete(agentId);
  rememberTerminatingSession(session);
  session.channelIds.clear();
  session.subscribers.clear();
  return terminateSessionAndCleanup(session);
}

function enqueueTerminalInputRequest(session: PtySession, request: QueuedPtyInputBatch): void {
  enqueuePendingInput(
    session,
    request.data,
    request.traceRequest,
    request.onApplied,
    request.onDropped,
  );
}

function flushPendingInput(session: PtySession): void {
  clearInputFlushTimer(session);
  while (session.pendingInputQueue.length > 0) {
    const nextBatch = takeQueuedTerminalInputBatch(
      session.pendingInputQueue,
      INPUT_BATCH_MAX_CHARS,
    );
    if (!nextBatch) {
      return;
    }

    const queuedBatches = session.pendingInputQueue.slice(0, nextBatch.count);
    const traceEntries = queuedBatches
      .map((entry) => entry.traceRequest)
      .filter((entry): entry is TerminalInputTraceRequest => entry !== undefined);
    for (const traceEntry of traceEntries) {
      recordTerminalInputTracePtyFlushed(session.agentId, traceEntry.requestId);
    }

    try {
      for (const chunk of splitTerminalInputChunks(nextBatch.batch, INPUT_BATCH_MAX_CHARS)) {
        session.proc.write(chunk.data);
      }
    } catch {
      recordPtyInputWriteFailure();
      for (const traceEntry of traceEntries) {
        recordTerminalInputTraceFailure(session.agentId, traceEntry.requestId, 'pty-write-failed');
      }
      for (const batch of queuedBatches) {
        batch.onDropped?.();
      }
      session.pendingInputQueue.splice(0, nextBatch.count);
      session.pendingInputChars = Math.max(0, session.pendingInputChars - nextBatch.batch.length);
      if (session.pendingInputChars === 0) {
        recordPtyInputQueueCleared();
      }
      stopAcceptingInput(session);
      return;
    }
    if (shouldArmInteractiveOutputFlushWindow(nextBatch.batch, traceEntries)) {
      session.recentInteractiveOutputDeadlineAtMs = Date.now() + INTERACTIVE_OUTPUT_FLUSH_WINDOW_MS;
    }
    for (const traceEntry of traceEntries) {
      recordTerminalInputTracePtyWritten(session.agentId, traceEntry.requestId);
    }
    for (const batch of queuedBatches) {
      batch.onApplied?.();
    }
    recordPtyInputFlush(nextBatch.count);
    session.pendingInputQueue.splice(0, nextBatch.count);
    session.pendingInputChars -= nextBatch.batch.length;
  }
  session.pendingInputChars = 0;
}

function getTerminalInputTracePreview(data: string): string {
  const printableText = Array.from(data)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 || char === '\t' || char === '\n';
    })
    .join('')
    .replace(/\r/g, '');

  if (printableText.length === 0) {
    return '';
  }

  return truncatePreview(printableText, TERMINAL_INPUT_TRACE_PREVIEW_LIMIT);
}

function schedulePendingInputFlush(session: PtySession, mode: 'bulk' | 'interactive'): void {
  if (session.inputFlushTimer) {
    return;
  }

  if (mode === 'interactive') {
    session.inputFlushTimer = {
      handle: setImmediate(() => {
        session.inputFlushTimer = null;
        flushPendingInput(session);
      }),
      kind: 'immediate',
    };
    return;
  }

  session.inputFlushTimer = {
    handle: setTimeout(() => {
      session.inputFlushTimer = null;
      flushPendingInput(session);
    }, INPUT_BATCH_INTERVAL),
    kind: 'timeout',
  };
}

function enqueuePendingInput(
  session: PtySession,
  data: string,
  traceRequest?: TerminalInputTraceRequest,
  onApplied?: () => void,
  onDropped?: () => void,
): void {
  if (data.length === 0) {
    onApplied?.();
    return;
  }
  if (!session.acceptsInput) {
    throw new Error(`Agent not accepting input: ${session.agentId}`);
  }

  const wasIdle = session.pendingInputQueue.length === 0 && !session.inputFlushTimer;
  const plan = getTerminalInputBatchPlan(data);

  session.pendingInputQueue.push({
    data,
    ...(onApplied ? { onApplied } : {}),
    ...(onDropped ? { onDropped } : {}),
    ...(traceRequest ? { traceRequest } : {}),
  });
  session.pendingInputChars += data.length;
  recordPtyInputEnqueue(data.length, session.pendingInputChars);
  if (traceRequest) {
    recordTerminalInputTraceServerReceived({
      agentId: session.agentId,
      clientId: traceRequest.clientId,
      inputPreview: getTerminalInputTracePreview(data),
      requestId: traceRequest.requestId,
      taskId: traceRequest.taskId,
      trace: traceRequest.trace,
    });
    recordTerminalInputTracePtyEnqueued(session.agentId, traceRequest.requestId);
  }

  const shouldFlushImmediately =
    plan.flushImmediately ||
    session.pendingInputChars >= INPUT_BATCH_MAX_CHARS ||
    (plan.preferImmediateFlushWhenIdle && wasIdle);
  if (shouldFlushImmediately) {
    flushPendingInput(session);
    return;
  }

  schedulePendingInputFlush(session, plan.flushMode);
}

function getSessionPauseState(session: PtySession): PauseReason | null {
  if ((session.pauseReasons.get('manual') ?? 0) > 0) return 'manual';
  if (
    (session.pauseReasons.get('flow-control') ?? 0) > 0 ||
    session.scopedPauseReasons['flow-control'].size > 0
  ) {
    return 'flow-control';
  }
  if (
    (session.pauseReasons.get('restore') ?? 0) > 0 ||
    session.globalRestorePauseLeases.size > 0 ||
    getScopedRestorePauseLeaseCount(session) > 0
  ) {
    return 'restore';
  }
  return null;
}

function syncPauseState(session: PtySession, agentId: string): void {
  const nextPauseState = getSessionPauseState(session);
  const shouldPause = nextPauseState !== null;
  if (shouldPause === session.isPaused && nextPauseState === session.pauseState) return;
  if (shouldPause) {
    if (!session.isPaused) {
      session.proc.pause();
      session.isPaused = true;
    }
    session.pauseState = nextPauseState;
    recordAgentPauseState(agentId, nextPauseState);
    emitPtyEvent('pause', agentId, { generation: session.lifecycleGeneration });
    return;
  }
  if (session.isPaused) {
    session.proc.resume();
    session.isPaused = false;
  }
  session.pauseState = null;
  recordAgentPauseState(agentId, null);
  emitPtyEvent('resume', agentId, { generation: session.lifecycleGeneration });
}

function clearRestorePauseLease(lease: RestorePauseLease): void {
  clearTimeout(lease.timer);
}

function clearFlowControlPauseLease(lease: FlowControlPauseLease): void {
  clearTimeout(lease.timer);
}

function nextRestorePauseLeaseId(): string {
  restorePauseLeaseSequence += 1;
  return `restore-${restorePauseLeaseSequence}`;
}

function getRestoreLeaseId(restoreLeaseId: string | undefined): string {
  return restoreLeaseId ?? LEGACY_RESTORE_LEASE_ID;
}

function getScopedRestorePauseLeaseCount(session: PtySession): number {
  let count = 0;
  for (const leasesById of session.scopedPauseReasons.restore.values()) {
    count += leasesById.size;
  }
  return count;
}

function armRestorePauseLeaseExpiry(onExpire: (expiresAt: number) => void): RestorePauseLease {
  const expiresAt = Date.now() + RESTORE_PAUSE_LEASE_TTL_MS;
  const timer = setTimeout(() => {
    onExpire(expiresAt);
  }, RESTORE_PAUSE_LEASE_TTL_MS);
  timer.unref?.();
  return { expiresAt, timer };
}

function armFlowControlPauseLeaseExpiry(
  onExpire: (expiresAt: number) => void,
): FlowControlPauseLease {
  const expiresAt = Date.now() + FLOW_CONTROL_PAUSE_LEASE_TTL_MS;
  const timer = setTimeout(() => {
    onExpire(expiresAt);
  }, FLOW_CONTROL_PAUSE_LEASE_TTL_MS);
  timer.unref?.();
  return { expiresAt, timer };
}

function expireScopedFlowControlPauseLease(
  agentId: string,
  channelId: string,
  expiresAt: number,
): void {
  const session = sessions.get(agentId);
  const lease = session?.scopedPauseReasons['flow-control'].get(channelId);
  if (!session || !lease || lease.expiresAt !== expiresAt) {
    return;
  }

  session.scopedPauseReasons['flow-control'].delete(channelId);
  syncPauseState(session, agentId);
}

function expireGlobalRestorePauseLease(agentId: string, leaseId: string, expiresAt: number): void {
  const session = sessions.get(agentId);
  const lease = session?.globalRestorePauseLeases.get(leaseId);
  if (!session || !lease || lease.expiresAt !== expiresAt) {
    return;
  }

  session.globalRestorePauseLeases.delete(leaseId);
  syncPauseState(session, agentId);
}

function expireScopedRestorePauseLease(
  agentId: string,
  channelId: string,
  restoreLeaseId: string,
  expiresAt: number,
): void {
  const session = sessions.get(agentId);
  const leasesById = session?.scopedPauseReasons.restore.get(channelId);
  const lease = leasesById?.get(restoreLeaseId);
  if (!session || !lease || lease.expiresAt !== expiresAt) {
    return;
  }

  leasesById?.delete(restoreLeaseId);
  if (leasesById?.size === 0) {
    session.scopedPauseReasons.restore.delete(channelId);
  }
  syncPauseState(session, agentId);
}

function addGlobalRestorePauseLease(session: PtySession, agentId: string): void {
  const leaseId = nextRestorePauseLeaseId();
  session.globalRestorePauseLeases.set(
    leaseId,
    armRestorePauseLeaseExpiry((expiresAt) => {
      expireGlobalRestorePauseLease(agentId, leaseId, expiresAt);
    }),
  );
}

function addScopedRestorePauseLease(
  session: PtySession,
  agentId: string,
  channelId: string,
  restoreLeaseId?: string,
): void {
  if (!session.channelIds.has(channelId)) {
    return;
  }

  const leaseId = getRestoreLeaseId(restoreLeaseId);
  const leasesById = session.scopedPauseReasons.restore.get(channelId) ?? new Map();
  const existingLease = leasesById.get(leaseId);
  if (existingLease) {
    clearRestorePauseLease(existingLease);
  }

  leasesById.set(
    leaseId,
    armRestorePauseLeaseExpiry((expiresAt) => {
      expireScopedRestorePauseLease(agentId, channelId, leaseId, expiresAt);
    }),
  );
  session.scopedPauseReasons.restore.set(channelId, leasesById);
}

function addScopedFlowControlPauseLease(
  session: PtySession,
  agentId: string,
  channelId: string,
): void {
  if (!session.channelIds.has(channelId)) {
    return;
  }

  const existingLease = session.scopedPauseReasons['flow-control'].get(channelId);
  if (existingLease) {
    clearFlowControlPauseLease(existingLease);
  }

  session.scopedPauseReasons['flow-control'].set(
    channelId,
    armFlowControlPauseLeaseExpiry((expiresAt) => {
      expireScopedFlowControlPauseLease(agentId, channelId, expiresAt);
    }),
  );
}

function clearOneGlobalRestorePauseLease(session: PtySession): void {
  const firstLeaseEntry = session.globalRestorePauseLeases.entries().next().value;
  if (!firstLeaseEntry) {
    return;
  }

  const [leaseId, lease] = firstLeaseEntry;
  clearRestorePauseLease(lease);
  session.globalRestorePauseLeases.delete(leaseId);
}

function clearScopedRestorePauseLease(
  session: PtySession,
  channelId: string,
  restoreLeaseId?: string,
): void {
  const leasesById = session.scopedPauseReasons.restore.get(channelId);
  const leaseId = getRestoreLeaseId(restoreLeaseId);
  const lease = leasesById?.get(leaseId);
  if (!lease) {
    return;
  }

  clearRestorePauseLease(lease);
  leasesById?.delete(leaseId);
  if (leasesById?.size === 0) {
    session.scopedPauseReasons.restore.delete(channelId);
  }
}

function clearScopedFlowControlPauseLease(session: PtySession, channelId: string): void {
  const lease = session.scopedPauseReasons['flow-control'].get(channelId);
  if (!lease) {
    return;
  }

  clearFlowControlPauseLease(lease);
  session.scopedPauseReasons['flow-control'].delete(channelId);
}

function clearScopedFlowControlPauseLeases(session: PtySession): void {
  for (const lease of session.scopedPauseReasons['flow-control'].values()) {
    clearFlowControlPauseLease(lease);
  }
  session.scopedPauseReasons['flow-control'].clear();
}

function clearScopedRestorePauseLeasesForChannel(session: PtySession, channelId: string): void {
  const leasesById = session.scopedPauseReasons.restore.get(channelId);
  if (!leasesById) {
    return;
  }

  for (const lease of leasesById.values()) {
    clearRestorePauseLease(lease);
  }
  session.scopedPauseReasons.restore.delete(channelId);
}

function clearGlobalRestorePauseLeases(session: PtySession): void {
  for (const lease of session.globalRestorePauseLeases.values()) {
    clearRestorePauseLease(lease);
  }
  session.globalRestorePauseLeases.clear();
}

function clearScopedRestorePauseLeases(session: PtySession): void {
  for (const leasesById of session.scopedPauseReasons.restore.values()) {
    for (const lease of leasesById.values()) {
      clearRestorePauseLease(lease);
    }
  }
  session.scopedPauseReasons.restore.clear();
}

function clearAllRestorePauseLeases(session: PtySession): void {
  clearGlobalRestorePauseLeases(session);
  clearScopedRestorePauseLeases(session);
  session.pauseReasons.delete('restore');
}

function clearAllAutomaticPauseState(session: PtySession): void {
  session.pauseReasons.delete('flow-control');
  clearScopedFlowControlPauseLeases(session);
  clearAllRestorePauseLeases(session);
}

export function spawnAgent(
  sendToChannel: (channelId: string, msg: unknown) => void,
  args: {
    taskId: string;
    agentId: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    isShell?: boolean;
    isInternalNodeProcess?: boolean;
    runnerIdentity?: AgentRuntimeIdentity;
    replaceExistingSession?: boolean;
    onExitCleanup?: () => Promise<void> | void;
    onOutput?: { __CHANNEL_ID__: string };
  },
): AgentSpawnDisposition {
  const channelId = args.onOutput?.__CHANNEL_ID__ ?? null;
  const command = args.command || resolveUserShell();
  const cwd = args.cwd || process.env.HOME || '/';

  const existing = sessions.get(args.agentId);
  if (existing && args.replaceExistingSession !== true) {
    const isNewChannel = channelId !== null && !existing.channelIds.has(channelId);
    flushSessionBatch(existing);
    if (channelId !== null) {
      existing.channelIds.add(channelId);
    }
    existing.sendToChannel = sendToChannel;
    existing.taskId = args.taskId;
    existing.isShell = args.isShell ?? false;
    existing.isInternalNodeProcess = args.isInternalNodeProcess ?? false;
    return {
      channelAttached: isNewChannel,
      kind: 'attached-existing',
    };
  }

  // Reject commands with shell metacharacters (node-pty uses execvp, but
  // guard against accidental misuse). Allow bare names (resolved via PATH)
  // and absolute paths.
  if (/[;&|`$(){}\n]/.test(command)) {
    throw new Error(`Command contains disallowed characters: ${command}`);
  }

  validateCommand(command);

  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) filteredEnv[k] = v;
  }

  const safeEnvOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.env ?? {})) {
    if (!isTerminalEnvBlocked(k)) safeEnvOverrides[k] = v;
  }

  const spawnEnv: Record<string, string> = {
    ...filteredEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...safeEnvOverrides,
  };
  removeInheritedTerminalColorSuppression(spawnEnv, safeEnvOverrides);
  const commandArgs = applyTestShellSandbox({
    command,
    commandArgs: args.args,
    configuredShellHomePath: process.env[TEST_SHELL_HOME_ENV_KEY],
    isShell: args.isShell === true,
    platform: process.platform,
    spawnEnv,
  });
  if (args.isInternalNodeProcess && process.versions.electron) {
    spawnEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  // Clear env vars that prevent nested agent sessions
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = pty.spawn(command, commandArgs, {
    name: 'xterm-256color',
    cols: args.cols,
    rows: args.rows,
    cwd,
    ...(process.platform !== 'win32' ? { encoding: null } : {}),
    env: spawnEnv,
  });

  const lifecycleGeneration = nextLifecycleGenerationByAgentId.get(args.agentId) ?? 0;
  nextLifecycleGenerationByAgentId.set(args.agentId, lifecycleGeneration + 1);

  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const session: PtySession = {
    proc,
    channelIds: channelId === null ? new Set() : new Set([channelId]),
    sendToChannel,
    taskId: args.taskId,
    agentId: args.agentId,
    ...(args.runnerIdentity !== undefined ? { runnerIdentity: args.runnerIdentity } : {}),
    ...(args.onExitCleanup !== undefined ? { onExitCleanup: args.onExitCleanup } : {}),
    runnerCleanupAwaited: false,
    exitPromise,
    resolveExit,
    exited: false,
    isShell: args.isShell ?? false,
    isInternalNodeProcess: args.isInternalNodeProcess ?? false,
    acceptsInput: true,
    isPaused: false,
    flushTimer: null,
    inputFlushTimer: null,
    subscribers: new Set(),
    scrollback: new RingBuffer(undefined, {
      onCapacityChange: recordTerminalScrollbackCapacityChange,
    }),
    terminalStateMirror: new TerminalStateMirror(args.cols, args.rows),
    batchBuf: Buffer.alloc(BATCH_MAX),
    batchOffset: 0,
    outputCursor: 0,
    pendingInputQueue: [],
    pendingInputChars: 0,
    orderedInputState: createTerminalOrderedState(),
    orderedResizeState: createTerminalOrderedState(),
    recentInteractiveOutputDeadlineAtMs: 0,
    exitDiagnosticTail: new RingBuffer(TAIL_CAP),
    pauseState: null,
    pauseReasons: new Map(),
    globalRestorePauseLeases: new Map(),
    scopedPauseReasons: {
      'flow-control': new Map(),
      restore: new Map(),
    },
    lifecycleGeneration,
    disposed: false,
  };

  const replacedSessionCleanup = existing
    ? replaceExistingSession(args.agentId, existing)
    : undefined;
  if (replacedSessionCleanup) {
    void replacedSessionCleanup.catch(() => undefined);
  }

  sessions.set(args.agentId, session);

  function handlePtyData(data: string | Uint8Array): void {
    if (sessions.get(args.agentId) !== session) {
      return;
    }

    // The per-byte hot loop only records bytes (scrollback, tail, batch).
    // Decoding plus supervision/port/trace scans and mirror writes happen at
    // flush time in flushSessionBatch so they cannot stall input serving.
    const chunk = normalizePtyOutputBytes(data);
    session.scrollback.write(chunk);

    // Keep exit diagnostics in a fixed-size ring so small chunks never shift
    // the retained tail. It is linearized only when the process exits.
    session.exitDiagnosticTail.write(chunk);

    appendToBatchBuffer(session, chunk);

    // Flush large batches immediately
    if (session.batchOffset >= BATCH_MAX) {
      flushSessionBatch(session);
      return;
    }

    // Recent interactive input gets an immediate echo fast path. Background
    // chatter should not share that lane just because the chunk is small.
    if (shouldFlushOutputImmediately(session, chunk.length)) {
      flushSessionBatch(session);
      return;
    }

    // Otherwise schedule flush on timer
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => flushSessionBatch(session), BATCH_INTERVAL);
    }
  }

  proc.onData(handlePtyData as (data: string) => void);

  proc.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.resolveExit();
    forgetTerminatingSession(session);
    // If this session was replaced by a new spawn with the same agentId,
    // skip cleanup — the new session owns the map entry now.
    if (sessions.get(args.agentId) !== session) {
      if (session.runnerCleanupAwaited) {
        disposeSessionResources(session);
        void cleanupSessionRunner(session).catch(() => undefined);
      } else {
        cleanupSessionResourcesBestEffort(session);
      }
      return;
    }

    // Flush any remaining buffered data
    flushSessionBatch(session);

    // Parse tail buffer into last N lines for exit diagnostics
    const lines = getTailLines(session.exitDiagnosticTail.read());

    sendToAttachedChannels(session, {
      type: 'Exit',
      data: {
        exit_code: exitCode,
        signal: signal === null || signal === undefined ? null : String(signal),
        last_output: lines,
      },
    });

    emitPtyEvent('exit', args.agentId, {
      exitCode,
      generation: session.lifecycleGeneration,
      lastOutput: lines,
      signal,
    });
    recordAgentExit(args.agentId, {
      exitCode,
      lastOutput: lines,
      signal: signal === null || signal === undefined ? null : String(signal),
    });
    sessions.delete(args.agentId);
    if (session.runnerCleanupAwaited) {
      disposeSessionResources(session);
      void cleanupSessionRunner(session).catch(() => undefined);
    } else {
      cleanupSessionResourcesBestEffort(session);
    }
  });

  recordAgentSpawn({
    agentId: args.agentId,
    isShell: args.isShell ?? false,
    ...(args.runnerIdentity !== undefined
      ? {
          runnerInstanceId: args.runnerIdentity.runnerInstanceId,
          runnerProvider: args.runnerIdentity.provider,
        }
      : {}),
    taskId: args.taskId,
  });
  emitPtyEvent('spawn', args.agentId, { generation: session.lifecycleGeneration });
  return {
    channelAttached: channelId !== null,
    kind: 'created-session',
    ...(replacedSessionCleanup !== undefined ? { replacedSessionCleanup } : {}),
  };
}

export function writeToAgent(
  agentId: string,
  data: string,
  traceRequest?: TerminalInputTraceRequest,
  order?: TerminalInputOrderToken,
  callbacks?: TerminalOrderCallbacks,
): void {
  const session = getSessionOrThrow(agentId);
  if (!hasTerminalInputOrder(order)) {
    enqueuePendingInput(session, data, traceRequest, callbacks?.onApplied, callbacks?.onDropped);
    return;
  }

  enqueueTerminalOrderedRequest(
    session.orderedInputState,
    order,
    {
      data,
      ...(callbacks?.onApplied ? { onApplied: callbacks.onApplied } : {}),
      ...(callbacks?.onDropped ? { onDropped: callbacks.onDropped } : {}),
      ...(traceRequest ? { traceRequest } : {}),
    },
    (request) => enqueueTerminalInputRequest(session, request),
    (request) => request.onDropped?.(),
    (request) => request.onApplied?.(),
  );
}

function applyTerminalResizeRequest(
  session: PtySession,
  request: OrderedTerminalResizeRequest,
): void {
  applyTerminalResize(session, request.cols, request.rows);
  request.onApplied?.();
}

function applyTerminalResize(session: PtySession, cols: number, rows: number): void {
  // Forward the pending batch to the mirror first so mirror writes and the
  // resize keep the same relative order as the real PTY byte stream.
  flushSessionBatch(session);
  session.proc.resize(cols, rows);
  session.terminalStateMirror.enqueueResize(cols, rows);
}

export function resizeAgent(
  agentId: string,
  cols: number,
  rows: number,
  order?: TerminalResizeOrderToken,
  callbacks?: TerminalOrderCallbacks,
): void {
  const session = getSessionOrThrow(agentId);
  if (!hasTerminalResizeOrder(order)) {
    applyTerminalResize(session, cols, rows);
    callbacks?.onApplied?.();
    return;
  }

  enqueueTerminalOrderedRequest(
    session.orderedResizeState,
    order,
    {
      cols,
      ...(callbacks?.onApplied ? { onApplied: callbacks.onApplied } : {}),
      ...(callbacks?.onDropped ? { onDropped: callbacks.onDropped } : {}),
      rows,
    },
    (request) => applyTerminalResizeRequest(session, request),
    (request) => request.onDropped?.(),
    (request) => request.onApplied?.(),
  );
}

function addPauseReason(
  session: PtySession,
  reason: PauseReason,
  channelId?: string,
  restoreLeaseId?: string,
): void {
  if (reason === 'restore') {
    if (channelId) {
      addScopedRestorePauseLease(session, session.agentId, channelId, restoreLeaseId);
      return;
    }

    addGlobalRestorePauseLease(session, session.agentId);
    return;
  }

  if (channelId && reason !== 'manual') {
    if (!session.channelIds.has(channelId)) {
      return;
    }
    if (reason === 'flow-control') {
      addScopedFlowControlPauseLease(session, session.agentId, channelId);
    }
    return;
  }
  session.pauseReasons.set(reason, (session.pauseReasons.get(reason) ?? 0) + 1);
}

function removePauseReason(
  session: PtySession,
  reason: PauseReason,
  channelId?: string,
  restoreLeaseId?: string,
): void {
  if (reason === 'restore') {
    if (channelId) {
      clearScopedRestorePauseLease(session, channelId, restoreLeaseId);
      return;
    }

    clearOneGlobalRestorePauseLease(session);
    return;
  }

  if (channelId && reason !== 'manual') {
    if (reason === 'flow-control') {
      clearScopedFlowControlPauseLease(session, channelId);
    }
    return;
  }
  const currentCount = session.pauseReasons.get(reason) ?? 0;
  if (currentCount <= 0) {
    session.pauseReasons.delete(reason);
    return;
  }

  if (currentCount === 1) {
    session.pauseReasons.delete(reason);
    return;
  }

  session.pauseReasons.set(reason, currentCount - 1);
}

export function pauseAgent(
  agentId: string,
  reason: PauseReason = 'manual',
  channelId?: string,
  restoreLeaseId?: string,
): void {
  const session = getSessionOrThrow(agentId);
  addPauseReason(session, reason, channelId, restoreLeaseId);
  syncPauseState(session, agentId);
}

export function resumeAgent(
  agentId: string,
  reason: PauseReason = 'manual',
  channelId?: string,
  restoreLeaseId?: string,
): void {
  const session = getSessionOrThrow(agentId);
  removePauseReason(session, reason, channelId, restoreLeaseId);
  syncPauseState(session, agentId);
}

export function getAgentPauseState(agentId: string): PauseReason | null {
  const session = sessions.get(agentId);
  if (!session) return null;
  return getSessionPauseState(session);
}

export function killAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    clearFlushTimer(session);
    stopAcceptingInput(session);
    clearAllAutomaticPauseState(session);
    // Clear subscribers before kill so the onExit flush doesn't
    // notify stale listeners. Let onExit handle sessions.delete
    // and emitPtyEvent to avoid the race condition.
    session.subscribers.clear();
    session.proc.kill();
  }
  for (const terminatingSession of terminatingSessions.get(agentId) ?? []) {
    terminatingSession.proc.kill();
  }
}

export async function killAgentAndWaitForRunnerCleanup(agentId: string): Promise<void> {
  const activeSession = sessions.get(agentId);
  const cleanupSessions = new Set([
    ...(pendingRunnerCleanupSessions.get(agentId) ?? []),
    ...(terminatingSessions.get(agentId) ?? []),
  ]);
  if (activeSession) {
    cleanupSessions.add(activeSession);
  }
  if (!activeSession && cleanupSessions.size === 0) {
    return;
  }

  const cleanupSessionList = [...cleanupSessions];
  const cleanupResults = await Promise.allSettled(
    cleanupSessionList.map((session) => {
      clearFlushTimer(session);
      stopAcceptingInput(session);
      clearAllAutomaticPauseState(session);
      session.subscribers.clear();
      return terminateSessionAndCleanup(session);
    }),
  );
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw createPtyLifecycleError(
      `Failed to stop agent ${agentId} and clean its runners`,
      cleanupErrors,
    );
  }
}

export async function killAllAgentsAndWaitForRunnerCleanup(): Promise<void> {
  const agentIds = new Set([
    ...sessions.keys(),
    ...pendingRunnerCleanupSessions.keys(),
    ...terminatingSessions.keys(),
  ]);
  const results = await Promise.allSettled(
    [...agentIds].map((agentId) => killAgentAndWaitForRunnerCleanup(agentId)),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw createPtyLifecycleError('Failed to stop all agents and clean their runners', failures);
  }
}

export async function killTaskAgentsAndWaitForRunnerCleanup(
  taskId: string,
  knownAgentIds: readonly string[] = [],
): Promise<void> {
  const agentIds = new Set(knownAgentIds);
  for (const session of sessions.values()) {
    if (session.taskId === taskId) {
      agentIds.add(session.agentId);
    }
  }
  for (const pendingSessions of pendingRunnerCleanupSessions.values()) {
    for (const session of pendingSessions) {
      if (session.taskId === taskId) {
        agentIds.add(session.agentId);
      }
    }
  }
  for (const ownedSessions of terminatingSessions.values()) {
    for (const session of ownedSessions) {
      if (session.taskId === taskId) {
        agentIds.add(session.agentId);
      }
    }
  }

  const results = await Promise.allSettled(
    [...agentIds].map((agentId) => killAgentAndWaitForRunnerCleanup(agentId)),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw createPtyLifecycleError(`Failed to stop agents for task ${taskId}`, failures);
  }
}

export function countRunningAgents(): number {
  return new Set([...sessions.keys(), ...terminatingSessions.keys()]).size;
}

export function killAllAgents(): void {
  for (const [, session] of sessions) {
    clearFlushTimer(session);
    stopAcceptingInput(session);
    clearAllAutomaticPauseState(session);
    session.subscribers.clear();
    session.proc.kill();
  }
  for (const ownedSessions of terminatingSessions.values()) {
    for (const session of ownedSessions) {
      session.proc.kill();
    }
  }
  // Let onExit handlers clean up sessions individually
}

// --- Subscriber helpers for remote access ---

/** Subscribe to live base64-encoded output from an agent. */
export function subscribeToAgent(agentId: string, cb: (encoded: string) => void): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.subscribers.add(cb);
  return true;
}

/** Remove a previously registered output subscriber. */
export function unsubscribeFromAgent(agentId: string, cb: (encoded: string) => void): void {
  sessions.get(agentId)?.subscribers.delete(cb);
}

function clearAutoPauseState(session: PtySession, agentId: string): void {
  clearAllAutomaticPauseState(session);
  syncPauseState(session, agentId);
}

export function detachAgentOutput(agentId: string, channelId: string): void {
  const session = sessions.get(agentId);
  if (!session) return;
  if (!session.channelIds.delete(channelId)) return;
  if (session.channelIds.size === 0) {
    clearAutoPauseState(session, agentId);
    return;
  }

  const beforeFlowCount = session.scopedPauseReasons['flow-control'].size;
  const beforeRestoreCount = getScopedRestorePauseLeaseCount(session);
  clearScopedFlowControlPauseLease(session, channelId);
  clearScopedRestorePauseLeasesForChannel(session, channelId);
  if (
    beforeFlowCount !== session.scopedPauseReasons['flow-control'].size ||
    beforeRestoreCount !== getScopedRestorePauseLeaseCount(session)
  ) {
    syncPauseState(session, agentId);
  }
}

/** Clear automatic pause reasons (flow-control, restore) for agents bound to
 *  the given channel, without removing the channel. Used when the last WebSocket
 *  subscriber disconnects but the PTY channel should remain for reconnection. */
export function clearAutoPauseReasonsForChannel(channelId: string): void {
  for (const [agentId, session] of sessions) {
    if (!session.channelIds.has(channelId)) continue;
    if (session.channelIds.size === 1) {
      session.pauseReasons.delete('flow-control');
      clearGlobalRestorePauseLeases(session);
    }
    const beforeFlowCount = session.scopedPauseReasons['flow-control'].size;
    const beforeRestoreCount = getScopedRestorePauseLeaseCount(session);
    clearScopedFlowControlPauseLease(session, channelId);
    clearScopedRestorePauseLeasesForChannel(session, channelId);
    if (
      session.channelIds.size === 1 ||
      beforeFlowCount !== session.scopedPauseReasons['flow-control'].size ||
      beforeRestoreCount !== getScopedRestorePauseLeaseCount(session)
    ) {
      syncPauseState(session, agentId);
    }
  }
}

/** Get the scrollback buffer for an agent as a base64 string. */
export function getAgentScrollback(agentId: string): string | null {
  return sessions.get(agentId)?.scrollback.toBase64() ?? null;
}

export function getAgentScrollbackBuffer(agentId: string): Buffer | null {
  return sessions.get(agentId)?.scrollback.read() ?? null;
}

export function getAgentTerminalRecovery(
  agentId: string,
  renderedTail: Buffer | null,
  requestedOutputCursor: number | null = null,
  snapshotByteLimit: number | null = null,
): AgentTerminalRecovery {
  const session = sessions.get(agentId);
  const scrollback = session?.scrollback.read() ?? Buffer.alloc(0);
  const cols = getAgentCols(agentId);
  const rows = getAgentRows(agentId);
  return buildAgentTerminalRecovery(
    scrollback,
    cols,
    rows,
    renderedTail,
    session?.outputCursor ?? 0,
    requestedOutputCursor,
    snapshotByteLimit,
  );
}

export async function getAgentTerminalStartupRecovery(
  agentId: string,
  _renderedTail: Buffer | null,
  _requestedOutputCursor: number | null = null,
  role: TerminalStartupRecoveryRole,
  visibleTerminalCount = 1,
): Promise<AgentTerminalRecovery> {
  const session = sessions.get(agentId);
  const scrollback = session?.scrollback.read() ?? Buffer.alloc(0);
  const cols = getAgentCols(agentId);
  const rows = getAgentRows(agentId);
  const outputCursor = session?.outputCursor ?? 0;
  const snapshotByteLimit = getStartupRecoverySnapshotByteLimit(role, visibleTerminalCount);

  if (outputCursor === 0 && scrollback.length === 0) {
    return {
      cols,
      kind: 'noop',
      outputCursor,
      rows,
    };
  }

  // serializeLatest responds against the last applied mirror write (bounded
  // by one in-flight write, never the whole backlog); the remaining bytes are
  // composed from the retained ring buffer so a noisy mirror cannot stall the
  // selected terminal's startup recovery.
  const terminalState = await session?.terminalStateMirror.serializeLatest();
  if (terminalState && session) {
    const currentOutputCursor = session.outputCursor;
    const currentScrollback = session.scrollback.read() ?? Buffer.alloc(0);
    const retainedStartCursor = currentOutputCursor - currentScrollback.length;
    const deltaBytes = currentOutputCursor - terminalState.appliedCursor;
    if (deltaBytes >= 0 && terminalState.appliedCursor >= retainedStartCursor) {
      const delta =
        deltaBytes === 0
          ? Buffer.alloc(0)
          : currentScrollback.subarray(currentScrollback.length - deltaBytes);
      const data =
        delta.length === 0 ? terminalState.data : Buffer.concat([terminalState.data, delta]);
      if (data.length <= snapshotByteLimit) {
        return {
          cols: terminalState.cols,
          data,
          kind: 'terminal-state',
          outputCursor: currentOutputCursor,
          rows: terminalState.rows,
        };
      }
    }

    recordTerminalStateRecoveryFallback();
    return buildStartupSnapshotRecovery(
      currentScrollback,
      cols,
      rows,
      currentOutputCursor,
      snapshotByteLimit,
    );
  }
  if (session) {
    recordTerminalStateRecoveryFallback();
  }

  return buildStartupSnapshotRecovery(scrollback, cols, rows, outputCursor, snapshotByteLimit);
}

/** Return all active agent IDs. */
export function getActiveAgentIds(): string[] {
  return Array.from(sessions.keys());
}

/** Return metadata for a specific agent, or null if not found. */
export function getAgentMeta(agentId: string): {
  agentId: string;
  generation: number;
  isShell: boolean;
  runnerIdentity?: AgentRuntimeIdentity;
  taskId: string;
} | null {
  const s = sessions.get(agentId);
  return s
    ? {
        agentId: s.agentId,
        generation: s.lifecycleGeneration,
        isShell: s.isShell,
        ...(s.runnerIdentity !== undefined ? { runnerIdentity: s.runnerIdentity } : {}),
        taskId: s.taskId,
      }
    : null;
}

/** Return the current column width of an agent's PTY. */
export function getAgentCols(agentId: string): number {
  const s = sessions.get(agentId);
  return s ? s.proc.cols : 80;
}

export function getAgentRows(agentId: string): number {
  const s = sessions.get(agentId);
  return s ? s.proc.rows : 24;
}

export function hasAgentSession(agentId: string): boolean {
  return sessions.has(agentId);
}
