import { createSignal } from 'solid-js';

// Pre-session keystroke buffer. Keys typed between focusing a terminal and
// the session object existing are buffered here per terminalStartupKey and
// drained into session.handleTerminalData when the session is accepted (the
// same path the in-session pending-input buffer uses, so ordering with later
// keystrokes is preserved). Entries are byte-capped and dropped when stale so
// a very slow attach can never misroute old keys into a fresh session.
const PENDING_SESSION_INPUT_MAX_BYTES = 4_096;
const PENDING_SESSION_INPUT_TTL_MS = 30_000;

interface PendingSessionInputEntry {
  byteLength: number;
  chunks: string[];
  lastEnqueuedAtMs: number;
}

const pendingSessionInputEntries = new Map<string, PendingSessionInputEntry>();
const [pendingSessionInputVersion, setPendingSessionInputVersion] = createSignal(0);
const textEncoder = new TextEncoder();
let deferredVersionBumpScheduled = false;

function bumpPendingSessionInputVersion(): void {
  setPendingSessionInputVersion((version) => version + 1);
}

function schedulePendingSessionInputVersionBump(): void {
  if (deferredVersionBumpScheduled) {
    return;
  }

  deferredVersionBumpScheduled = true;
  queueMicrotask(() => {
    deferredVersionBumpScheduled = false;
    bumpPendingSessionInputVersion();
  });
}

function isPendingSessionInputEntryExpired(
  entry: PendingSessionInputEntry,
  nowMs: number,
): boolean {
  return nowMs - entry.lastEnqueuedAtMs > PENDING_SESSION_INPUT_TTL_MS;
}

function removePendingSessionInputEntry(
  terminalStartupKey: string,
  deferVersionBump = false,
): boolean {
  if (!pendingSessionInputEntries.delete(terminalStartupKey)) {
    return false;
  }

  if (deferVersionBump) {
    schedulePendingSessionInputVersionBump();
  } else {
    bumpPendingSessionInputVersion();
  }
  return true;
}

function pruneExpiredPendingSessionInputEntry(
  terminalStartupKey: string,
  nowMs: number,
  deferVersionBump = false,
): PendingSessionInputEntry | null {
  const entry = pendingSessionInputEntries.get(terminalStartupKey);
  if (!entry) {
    return null;
  }

  if (!isPendingSessionInputEntryExpired(entry, nowMs)) {
    return entry;
  }

  removePendingSessionInputEntry(terminalStartupKey, deferVersionBump);
  return null;
}

export function enqueuePendingSessionInput(
  terminalStartupKey: string,
  data: string,
  nowMs = Date.now(),
): boolean {
  const byteLength = textEncoder.encode(data).byteLength;
  const entry = pruneExpiredPendingSessionInputEntry(terminalStartupKey, nowMs) ?? {
    byteLength: 0,
    chunks: [],
    lastEnqueuedAtMs: nowMs,
  };
  if (entry.byteLength + byteLength > PENDING_SESSION_INPUT_MAX_BYTES) {
    return false;
  }

  entry.byteLength += byteLength;
  entry.chunks.push(data);
  entry.lastEnqueuedAtMs = nowMs;
  pendingSessionInputEntries.set(terminalStartupKey, entry);
  bumpPendingSessionInputVersion();
  return true;
}

export function takePendingSessionInput(
  terminalStartupKey: string,
  nowMs = Date.now(),
): string | null {
  const entry = pruneExpiredPendingSessionInputEntry(terminalStartupKey, nowMs);
  if (!entry) {
    return null;
  }

  pendingSessionInputEntries.delete(terminalStartupKey);
  bumpPendingSessionInputVersion();
  return entry.chunks.join('');
}

export function getPendingSessionInputCount(
  terminalStartupKey: string,
  nowMs = Date.now(),
): number {
  pendingSessionInputVersion();
  pruneExpiredPendingSessionInputEntry(terminalStartupKey, nowMs, true);
  return pendingSessionInputEntries.get(terminalStartupKey)?.chunks.length ?? 0;
}

export function clearPendingSessionInput(terminalStartupKey: string): void {
  removePendingSessionInputEntry(terminalStartupKey);
}

export function clearPendingSessionInputForTask(taskId: string): void {
  let removed = false;
  for (const terminalStartupKey of pendingSessionInputEntries.keys()) {
    if (terminalStartupKey.startsWith(`${taskId}:`)) {
      pendingSessionInputEntries.delete(terminalStartupKey);
      removed = true;
    }
  }

  if (removed) {
    bumpPendingSessionInputVersion();
  }
}

export function resetPendingSessionInputForTests(): void {
  pendingSessionInputEntries.clear();
  deferredVersionBumpScheduled = false;
  bumpPendingSessionInputVersion();
}
