import * as pty from 'node-pty';
import type { PauseReason } from '../remote/protocol.js';
import type { TerminalInputTraceMessage } from '../../src/domain/terminal-input-tracing.js';
import {
  getTerminalInputBatchPlan,
  takeQueuedTerminalInputBatch,
  type QueuedTerminalInputBatch,
} from '../../src/lib/terminal-input-batching.js';
import { RingBuffer } from '../remote/ring-buffer.js';
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
  recordTerminalInputTraceFailure,
  recordTerminalInputTracePtyEnqueued,
  recordTerminalInputTracePtyFlushed,
  recordTerminalInputTracePtyWritten,
  recordPtyInputWriteFailure,
} from './runtime-diagnostics.js';
import { observeTaskPortsFromOutput } from './task-ports.js';

interface PtySession {
  proc: pty.IPty;
  channelIds: Set<string>;
  sendToChannel: (channelId: string, msg: unknown) => void;
  taskId: string;
  agentId: string;
  isShell: boolean;
  isInternalNodeProcess: boolean;
  acceptsInput: boolean;
  isPaused: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  inputFlushTimer: InputFlushTimer | null;
  subscribers: Set<(encoded: string) => void>;
  scrollback: RingBuffer;
  batchBuf: Buffer;
  batchOffset: number;
  pendingInputQueue: QueuedPtyInputBatch[];
  pendingInputChars: number;
  recentInteractiveOutputDeadlineAtMs: number;
  tailBuf: Buffer;
  tailOffset: number;
  pauseReasons: Map<PauseReason, number>;
  scopedPauseReasons: {
    'flow-control': Set<string>;
    restore: Set<string>;
  };
}

interface TerminalInputTraceRequest {
  clientId: string | null;
  requestId: string;
  taskId: string | null;
  trace: TerminalInputTraceMessage;
}

interface QueuedPtyInputBatch extends QueuedTerminalInputBatch {
  traceRequest?: TerminalInputTraceRequest;
}

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
const INTERACTIVE_OUTPUT_FLUSH_WINDOW_MS = 48;
const INTERACTIVE_OUTPUT_MAX_BYTES = 4 * 1024;
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;

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

  const encoded = session.batchBuf.subarray(0, session.batchOffset).toString('base64');
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
    readOffset += toCopy;
    if (session.batchOffset === BATCH_MAX) flushSessionBatch(session);
  }
}

function appendToTailBuffer(session: PtySession, chunk: Buffer): void {
  if (chunk.length >= TAIL_CAP) {
    chunk.copy(session.tailBuf, 0, chunk.length - TAIL_CAP);
    session.tailOffset = TAIL_CAP;
    return;
  }

  const writable = TAIL_CAP - session.tailOffset;
  if (chunk.length > writable) {
    const bytesToKeep = Math.min(TAIL_CAP - chunk.length, session.tailOffset);
    if (bytesToKeep > 0) {
      session.tailBuf.copyWithin(0, session.tailOffset - bytesToKeep, session.tailOffset);
    }
    session.tailOffset = bytesToKeep;
  }

  chunk.copy(session.tailBuf, session.tailOffset);
  session.tailOffset += chunk.length;
}

function getSessionOrThrow(agentId: string): PtySession {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  return session;
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
  session.pendingInputQueue = [];
  session.pendingInputChars = 0;
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

    const traceEntries = session.pendingInputQueue
      .slice(0, nextBatch.count)
      .map((entry) => entry.traceRequest)
      .filter((entry): entry is TerminalInputTraceRequest => entry !== undefined);
    for (const traceEntry of traceEntries) {
      recordTerminalInputTracePtyFlushed(session.agentId, traceEntry.requestId);
    }

    try {
      session.proc.write(nextBatch.batch);
    } catch {
      recordPtyInputWriteFailure();
      for (const traceEntry of traceEntries) {
        recordTerminalInputTraceFailure(session.agentId, traceEntry.requestId, 'pty-write-failed');
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
    recordPtyInputFlush(nextBatch.count);
    session.pendingInputQueue.splice(0, nextBatch.count);
    session.pendingInputChars -= nextBatch.batch.length;
  }
  session.pendingInputChars = 0;
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
): void {
  if (data.length === 0) {
    return;
  }
  if (!session.acceptsInput) {
    throw new Error(`Agent not accepting input: ${session.agentId}`);
  }

  const wasIdle = session.pendingInputQueue.length === 0 && !session.inputFlushTimer;
  const plan = getTerminalInputBatchPlan(data);

  session.pendingInputQueue.push({
    data,
    ...(traceRequest ? { traceRequest } : {}),
  });
  session.pendingInputChars += data.length;
  recordPtyInputEnqueue(data.length, session.pendingInputChars);
  if (traceRequest) {
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

function syncPauseState(session: PtySession, agentId: string): void {
  const shouldPause =
    Array.from(session.pauseReasons.values()).some((count) => count > 0) ||
    session.scopedPauseReasons['flow-control'].size > 0 ||
    session.scopedPauseReasons.restore.size > 0;
  if (shouldPause === session.isPaused) return;
  if (shouldPause) {
    session.proc.pause();
    session.isPaused = true;
    recordAgentPauseState(agentId, getAgentPauseState(agentId));
    emitPtyEvent('pause', agentId);
    return;
  }
  session.proc.resume();
  session.isPaused = false;
  recordAgentPauseState(agentId, null);
  emitPtyEvent('resume', agentId);
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
    onOutput: { __CHANNEL_ID__: string };
  },
): void {
  const channelId = args.onOutput.__CHANNEL_ID__;
  const command = args.command || process.env.SHELL || '/bin/sh';
  const cwd = args.cwd || process.env.HOME || '/';

  const existing = sessions.get(args.agentId);
  if (existing) {
    const isNewChannel = !existing.channelIds.has(channelId);
    flushSessionBatch(existing);
    existing.channelIds.add(channelId);
    existing.sendToChannel = sendToChannel;
    existing.taskId = args.taskId;
    existing.isShell = args.isShell ?? false;
    existing.isInternalNodeProcess = args.isInternalNodeProcess ?? false;
    existing.proc.resize(args.cols, args.rows);
    const scrollback = existing.scrollback.toBase64();
    if (scrollback && isNewChannel) {
      existing.sendToChannel(channelId, { type: 'Data', data: scrollback });
    }
    return;
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

  // Only allow safe env overrides from renderer. Reject vars that could
  // alter process loading or execution behavior.
  const ENV_BLOCK_LIST = new Set([
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
  ]);
  const safeEnvOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.env ?? {})) {
    if (!ENV_BLOCK_LIST.has(k)) safeEnvOverrides[k] = v;
  }

  const spawnEnv: Record<string, string> = {
    ...filteredEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...safeEnvOverrides,
  };
  if (args.isInternalNodeProcess && process.versions.electron) {
    spawnEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  // Clear env vars that prevent nested agent sessions
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = pty.spawn(command, args.args, {
    name: 'xterm-256color',
    cols: args.cols,
    rows: args.rows,
    cwd,
    env: spawnEnv,
  });

  const session: PtySession = {
    proc,
    channelIds: new Set([channelId]),
    sendToChannel,
    taskId: args.taskId,
    agentId: args.agentId,
    isShell: args.isShell ?? false,
    isInternalNodeProcess: args.isInternalNodeProcess ?? false,
    acceptsInput: true,
    isPaused: false,
    flushTimer: null,
    inputFlushTimer: null,
    subscribers: new Set(),
    scrollback: new RingBuffer(),
    batchBuf: Buffer.alloc(BATCH_MAX),
    batchOffset: 0,
    pendingInputQueue: [],
    pendingInputChars: 0,
    recentInteractiveOutputDeadlineAtMs: 0,
    tailBuf: Buffer.alloc(TAIL_CAP),
    tailOffset: 0,
    pauseReasons: new Map(),
    scopedPauseReasons: {
      'flow-control': new Set(),
      restore: new Set(),
    },
  };
  sessions.set(args.agentId, session);

  proc.onData((data: string) => {
    const chunk = Buffer.from(data, 'utf8');
    session.scrollback.write(chunk);
    recordAgentOutput(args.agentId, data);
    observeTaskPortsFromOutput(args.taskId, data);

    // Maintain tail buffer for exit diagnostics
    appendToTailBuffer(session, chunk);

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
  });

  proc.onExit(({ exitCode, signal }) => {
    // If this session was replaced by a new spawn with the same agentId,
    // skip cleanup — the new session owns the map entry now.
    if (sessions.get(args.agentId) !== session) return;

    // Flush any remaining buffered data
    flushSessionBatch(session);
    stopAcceptingInput(session);

    // Parse tail buffer into last N lines for exit diagnostics
    const lines = getTailLines(session.tailBuf.subarray(0, session.tailOffset));

    sendToAttachedChannels(session, {
      type: 'Exit',
      data: {
        exit_code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
        last_output: lines,
      },
    });

    emitPtyEvent('exit', args.agentId, { exitCode, signal });
    recordAgentExit(args.agentId, {
      exitCode,
      lastOutput: lines,
      signal: signal !== undefined ? String(signal) : null,
    });
    sessions.delete(args.agentId);
  });

  recordAgentSpawn({
    agentId: args.agentId,
    isShell: args.isShell ?? false,
    taskId: args.taskId,
  });
  emitPtyEvent('spawn', args.agentId);
}

export function writeToAgent(
  agentId: string,
  data: string,
  traceRequest?: TerminalInputTraceRequest,
): void {
  enqueuePendingInput(getSessionOrThrow(agentId), data, traceRequest);
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  getSessionOrThrow(agentId).proc.resize(cols, rows);
}

function addPauseReason(session: PtySession, reason: PauseReason, channelId?: string): void {
  if (channelId && reason !== 'manual') {
    session.scopedPauseReasons[reason].add(channelId);
    return;
  }
  session.pauseReasons.set(reason, (session.pauseReasons.get(reason) ?? 0) + 1);
}

function removePauseReason(session: PtySession, reason: PauseReason, channelId?: string): void {
  if (channelId && reason !== 'manual') {
    session.scopedPauseReasons[reason].delete(channelId);
    return;
  }
  const currentCount = session.pauseReasons.get(reason) ?? 0;
  if (currentCount <= 0) {
    session.pauseReasons.delete(reason);
    return;
  }
  if (currentCount === 1) session.pauseReasons.delete(reason);
  else session.pauseReasons.set(reason, currentCount - 1);
}

export function pauseAgent(
  agentId: string,
  reason: PauseReason = 'manual',
  channelId?: string,
): void {
  const session = getSessionOrThrow(agentId);
  addPauseReason(session, reason, channelId);
  syncPauseState(session, agentId);
}

export function resumeAgent(
  agentId: string,
  reason: PauseReason = 'manual',
  channelId?: string,
): void {
  const session = getSessionOrThrow(agentId);
  removePauseReason(session, reason, channelId);
  syncPauseState(session, agentId);
}

export function getAgentPauseState(agentId: string): PauseReason | null {
  const session = sessions.get(agentId);
  if (!session) return null;
  // Return the primary pause reason in priority order (check counts, not just presence)
  if ((session.pauseReasons.get('manual') ?? 0) > 0) return 'manual';
  if (
    (session.pauseReasons.get('flow-control') ?? 0) > 0 ||
    session.scopedPauseReasons['flow-control'].size > 0
  ) {
    return 'flow-control';
  }
  if (
    (session.pauseReasons.get('restore') ?? 0) > 0 ||
    session.scopedPauseReasons.restore.size > 0
  ) {
    return 'restore';
  }
  return null;
}

export function killAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    clearFlushTimer(session);
    stopAcceptingInput(session);
    // Clear subscribers before kill so the onExit flush doesn't
    // notify stale listeners. Let onExit handle sessions.delete
    // and emitPtyEvent to avoid the race condition.
    session.subscribers.clear();
    session.proc.kill();
  }
}

export function countRunningAgents(): number {
  return sessions.size;
}

export function killAllAgents(): void {
  for (const [, session] of sessions) {
    clearFlushTimer(session);
    stopAcceptingInput(session);
    session.subscribers.clear();
    session.proc.kill();
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
  session.pauseReasons.delete('flow-control');
  session.pauseReasons.delete('restore');
  session.scopedPauseReasons['flow-control'].clear();
  session.scopedPauseReasons.restore.clear();
  syncPauseState(session, agentId);
}

export function detachAgentOutput(agentId: string, channelId: string): void {
  const session = sessions.get(agentId);
  if (!session) return;
  if (!session.channelIds.delete(channelId)) return;
  if (session.channelIds.size === 0) clearAutoPauseState(session, agentId);
}

/** Clear automatic pause reasons (flow-control, restore) for agents bound to
 *  the given channel, without removing the channel. Used when the last WebSocket
 *  subscriber disconnects but the PTY channel should remain for reconnection. */
export function clearAutoPauseReasonsForChannel(channelId: string): void {
  for (const [agentId, session] of sessions) {
    if (!session.channelIds.has(channelId)) continue;
    if (session.channelIds.size === 1) {
      session.pauseReasons.delete('flow-control');
      session.pauseReasons.delete('restore');
    }
    const beforeFlowCount = session.scopedPauseReasons['flow-control'].size;
    const beforeRestoreCount = session.scopedPauseReasons.restore.size;
    session.scopedPauseReasons['flow-control'].delete(channelId);
    session.scopedPauseReasons.restore.delete(channelId);
    if (
      session.channelIds.size === 1 ||
      beforeFlowCount !== session.scopedPauseReasons['flow-control'].size ||
      beforeRestoreCount !== session.scopedPauseReasons.restore.size
    ) {
      syncPauseState(session, agentId);
    }
  }
}

/** Get the scrollback buffer for an agent as a base64 string. */
export function getAgentScrollback(agentId: string): string | null {
  return sessions.get(agentId)?.scrollback.toBase64() ?? null;
}

/** Return all active agent IDs. */
export function getActiveAgentIds(): string[] {
  return Array.from(sessions.keys());
}

/** Return metadata for a specific agent, or null if not found. */
export function getAgentMeta(
  agentId: string,
): { taskId: string; agentId: string; isShell: boolean } | null {
  const s = sessions.get(agentId);
  return s ? { taskId: s.taskId, agentId: s.agentId, isShell: s.isShell } : null;
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
