import { IPC } from '../../electron/ipc/channels';
import { invoke } from './ipc';

import type { TerminalRecoveryBatchEntry, TerminalRecoveryRequestEntry } from '../ipc/types';

const RECONNECT_BATCH_WINDOW_MS = 12;

interface TerminalRecoveryRequestOptions {
  outputCursor?: number | null;
  renderedTail?: string | null;
}

type PendingRestore = {
  agentId: string;
  outputCursor: number | null;
  renderedTail: string | null;
  requestId: string;
  resolve: (entry: TerminalRecoveryBatchEntry) => void;
  reject: (reason: unknown) => void;
};

const pendingReconnectRestores: PendingRestore[] = [];
let reconnectRestoreTimer: number | null = null;
let reconnectRestoreInFlight = false;

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

function scheduleReconnectRestoreFlush(): void {
  if (reconnectRestoreTimer !== null || typeof window === 'undefined') return;
  reconnectRestoreTimer = window.setTimeout(() => {
    reconnectRestoreTimer = null;
    void flushReconnectRestoreBatch();
  }, RECONNECT_BATCH_WINDOW_MS);
}

async function flushReconnectRestoreBatch(): Promise<void> {
  if (reconnectRestoreInFlight || pendingReconnectRestores.length === 0) return;

  reconnectRestoreInFlight = true;
  const currentBatch = pendingReconnectRestores.splice(0, pendingReconnectRestores.length);

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
    reconnectRestoreInFlight = false;
    if (pendingReconnectRestores.length > 0) {
      scheduleReconnectRestoreFlush();
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

export function requestReconnectTerminalRecovery(
  agentId: string,
  options: TerminalRecoveryRequestOptions = {},
): Promise<TerminalRecoveryBatchEntry> {
  return new Promise<TerminalRecoveryBatchEntry>((resolve, reject) => {
    pendingReconnectRestores.push({
      agentId,
      outputCursor: options.outputCursor ?? null,
      renderedTail: options.renderedTail ?? null,
      requestId: crypto.randomUUID(),
      resolve,
      reject,
    });
    scheduleReconnectRestoreFlush();
  });
}
