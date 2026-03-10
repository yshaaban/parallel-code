import * as pty from 'node-pty';
import type { PauseReason } from '../remote/protocol.js';
import { RingBuffer } from '../remote/ring-buffer.js';
import { validateCommand } from './command-resolver.js';

interface PtySession {
  proc: pty.IPty;
  channelIds: Set<string>;
  sendToChannel: (channelId: string, msg: unknown) => void;
  taskId: string;
  agentId: string;
  isShell: boolean;
  isInternalNodeProcess: boolean;
  isPaused: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<(encoded: string) => void>;
  scrollback: RingBuffer;
  batch: Buffer;
  pauseReasons: Map<PauseReason, number>;
}

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
const BATCH_INTERVAL = 8; // ms
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;

export { validateCommand } from './command-resolver.js';

function clearFlushTimer(session: PtySession): void {
  if (!session.flushTimer) return;
  clearTimeout(session.flushTimer);
  session.flushTimer = null;
}

function sendToAttachedChannels(session: PtySession, msg: unknown): void {
  for (const channelId of session.channelIds) {
    session.sendToChannel(channelId, msg);
  }
}

function flushSessionBatch(session: PtySession): void {
  if (session.batch.length === 0) {
    clearFlushTimer(session);
    return;
  }

  const encoded = session.batch.toString('base64');
  sendToAttachedChannels(session, { type: 'Data', data: encoded });
  for (const sub of session.subscribers) {
    sub(encoded);
  }
  session.batch = Buffer.alloc(0);
  clearFlushTimer(session);
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

function syncPauseState(session: PtySession, agentId: string): void {
  const shouldPause = Array.from(session.pauseReasons.values()).some((count) => count > 0);
  if (shouldPause === session.isPaused) return;
  if (shouldPause) {
    session.proc.pause();
    session.isPaused = true;
    emitPtyEvent('pause', agentId);
    return;
  }
  session.proc.resume();
  session.isPaused = false;
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
    isPaused: false,
    flushTimer: null,
    subscribers: new Set(),
    scrollback: new RingBuffer(),
    batch: Buffer.alloc(0),
    pauseReasons: new Map(),
  };
  sessions.set(args.agentId, session);

  // Batching strategy matching the Rust implementation
  let tailBuf = Buffer.alloc(0);

  proc.onData((data: string) => {
    const chunk = Buffer.from(data, 'utf8');
    session.scrollback.write(chunk);

    // Maintain tail buffer for exit diagnostics
    tailBuf = Buffer.concat([tailBuf, chunk]);
    if (tailBuf.length > TAIL_CAP) {
      tailBuf = tailBuf.subarray(tailBuf.length - TAIL_CAP);
    }

    session.batch = Buffer.concat([session.batch, chunk]);

    // Flush large batches immediately
    if (session.batch.length >= BATCH_MAX) {
      flushSessionBatch(session);
      return;
    }

    // Small read = likely interactive prompt, flush immediately
    if (chunk.length < 1024) {
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

    // Parse tail buffer into last N lines for exit diagnostics
    const lines = getTailLines(tailBuf);

    sendToAttachedChannels(session, {
      type: 'Exit',
      data: {
        exit_code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
        last_output: lines,
      },
    });

    emitPtyEvent('exit', args.agentId, { exitCode, signal });
    sessions.delete(args.agentId);
  });

  emitPtyEvent('spawn', args.agentId);
}

export function writeToAgent(agentId: string, data: string): void {
  if (data.length === 0) return;
  getSessionOrThrow(agentId).proc.write(data);
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  getSessionOrThrow(agentId).proc.resize(cols, rows);
}

export function pauseAgent(agentId: string, reason: PauseReason = 'manual'): void {
  const session = getSessionOrThrow(agentId);
  session.pauseReasons.set(reason, (session.pauseReasons.get(reason) ?? 0) + 1);
  syncPauseState(session, agentId);
}

export function resumeAgent(agentId: string, reason: PauseReason = 'manual'): void {
  const session = getSessionOrThrow(agentId);
  const currentCount = session.pauseReasons.get(reason) ?? 0;
  if (currentCount <= 0) {
    session.pauseReasons.delete(reason);
    return;
  }
  if (currentCount === 1) session.pauseReasons.delete(reason);
  else session.pauseReasons.set(reason, currentCount - 1);
  syncPauseState(session, agentId);
}

export function killAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    clearFlushTimer(session);
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

export function detachAgentOutput(agentId: string, channelId: string): void {
  const session = sessions.get(agentId);
  if (!session) return;
  if (!session.channelIds.delete(channelId)) return;
  if (session.channelIds.size === 0) {
    session.pauseReasons.set('flow-control', 0);
    session.pauseReasons.set('restore', 0);
    syncPauseState(session, agentId);
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
