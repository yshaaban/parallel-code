import { IPC } from '../../electron/ipc/channels';
import { invoke } from './ipc';

import type { TerminalRecoveryBatchEntry, TerminalRecoveryRequestEntry } from '../ipc/types';

const ATTACH_BATCH_WINDOW_MS = 12;
const RECONNECT_BATCH_WINDOW_MS = 12;

interface TerminalRecoveryRequestOptions {
  outputCursor?: number | null;
  renderedTail?: string | null;
}

interface PendingRestore {
  agentId: string;
  outputCursor: number | null;
  renderedTail: string | null;
  requestId: string;
  resolve: (entry: TerminalRecoveryBatchEntry) => void;
  reject: (reason: unknown) => void;
}

interface BatchedTerminalRecoveryState {
  inFlight: boolean;
  pending: PendingRestore[];
  timer: number | null;
  windowMs: number;
}

const attachRestoreState = createBatchedTerminalRecoveryState(ATTACH_BATCH_WINDOW_MS);
const reconnectRestoreState = createBatchedTerminalRecoveryState(RECONNECT_BATCH_WINDOW_MS);

function createBatchedTerminalRecoveryState(windowMs: number): BatchedTerminalRecoveryState {
  return {
    inFlight: false,
    pending: [],
    timer: null,
    windowMs,
  };
}

function createTerminalRecoveryRequestEntry(
  agentId: string,
  requestId: string,
  options: TerminalRecoveryRequestOptions,
): TerminalRecoveryRequestEntry {
  return {
    agentId,
    outputCursor: options.outputCursor ?? null,
    renderedTail: options.renderedTail ?? null,
    requestId,
  };
}

function createTerminalRecoveryFallbackEntry(
  agentId: string,
  requestId: string,
): TerminalRecoveryBatchEntry {
  return {
    agentId,
    cols: 80,
    outputCursor: 0,
    recovery: {
      kind: 'snapshot',
      data: null,
    },
    requestId,
  };
}

function scheduleTerminalRecoveryBatchFlush(state: BatchedTerminalRecoveryState): void {
  if (state.timer !== null || typeof window === 'undefined') {
    return;
  }

  state.timer = window.setTimeout(() => {
    state.timer = null;
    void flushTerminalRecoveryBatch(state);
  }, state.windowMs);
}

async function flushTerminalRecoveryBatch(state: BatchedTerminalRecoveryState): Promise<void> {
  if (state.inFlight || state.pending.length === 0) {
    return;
  }

  state.inFlight = true;
  const currentBatch = state.pending.splice(0, state.pending.length);

  try {
    const results = await invokeTerminalRecoveryBatch(
      currentBatch.map((entry) =>
        createTerminalRecoveryRequestEntry(entry.agentId, entry.requestId, entry),
      ),
    );
    const recoveryByRequestId = new Map(results.map((entry) => [entry.requestId, entry] as const));
    for (const listener of currentBatch) {
      resolvePendingTerminalRecovery(listener, recoveryByRequestId.get(listener.requestId));
    }
  } catch (error) {
    for (const listener of currentBatch) {
      listener.reject(error);
    }
  } finally {
    state.inFlight = false;
    if (state.pending.length > 0) {
      scheduleTerminalRecoveryBatchFlush(state);
    }
  }
}

function resolvePendingTerminalRecovery(
  listener: PendingRestore,
  entry: TerminalRecoveryBatchEntry | undefined,
): void {
  listener.resolve(
    entry ?? createTerminalRecoveryFallbackEntry(listener.agentId, listener.requestId),
  );
}

async function invokeTerminalRecoveryBatch(
  requests: TerminalRecoveryRequestEntry[],
): Promise<TerminalRecoveryBatchEntry[]> {
  return invoke(IPC.GetTerminalRecoveryBatch, { requests });
}

export async function requestTerminalRecovery(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  const requestId = crypto.randomUUID();
  const [entry] = await invokeTerminalRecoveryBatch([
    createTerminalRecoveryRequestEntry(agentId, requestId, options),
  ]);

  return entry ?? createTerminalRecoveryFallbackEntry(agentId, requestId);
}

function requestBatchedTerminalRecovery(
  state: BatchedTerminalRecoveryState,
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  return new Promise<TerminalRecoveryBatchEntry>((resolve, reject) => {
    state.pending.push({
      agentId,
      outputCursor: options.outputCursor ?? null,
      renderedTail: options.renderedTail ?? null,
      requestId: crypto.randomUUID(),
      resolve,
      reject,
    });
    scheduleTerminalRecoveryBatchFlush(state);
  });
}

export function requestAttachTerminalRecovery(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  return requestBatchedTerminalRecovery(attachRestoreState, agentId, options);
}

export function requestReconnectTerminalRecovery(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  return requestBatchedTerminalRecovery(reconnectRestoreState, agentId, options);
}
