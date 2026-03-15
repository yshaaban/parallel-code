import { IPC } from '../../electron/ipc/channels';
import { invoke } from './ipc';

import type { ScrollbackBatchEntry } from '../ipc/types';

const RECONNECT_BATCH_WINDOW_MS = 12;

type PendingRestore = {
  resolve: (entry: ScrollbackBatchEntry) => void;
  reject: (reason: unknown) => void;
};

const pendingReconnectRestores = new Map<string, PendingRestore[]>();
let reconnectRestoreTimer: number | null = null;
let reconnectRestoreInFlight = false;

function scheduleReconnectRestoreFlush(): void {
  if (reconnectRestoreTimer !== null || typeof window === 'undefined') return;
  reconnectRestoreTimer = window.setTimeout(() => {
    reconnectRestoreTimer = null;
    void flushReconnectRestoreBatch();
  }, RECONNECT_BATCH_WINDOW_MS);
}

async function flushReconnectRestoreBatch(): Promise<void> {
  if (reconnectRestoreInFlight || pendingReconnectRestores.size === 0) return;

  reconnectRestoreInFlight = true;
  const currentBatch = new Map(pendingReconnectRestores);
  pendingReconnectRestores.clear();

  try {
    const results = await invoke(IPC.GetScrollbackBatch, {
      agentIds: Array.from(currentBatch.keys()),
    });
    const byAgentId = new Map(results.map((entry) => [entry.agentId, entry] as const));

    for (const [agentId, listeners] of currentBatch) {
      const entry = byAgentId.get(agentId) ?? { agentId, scrollback: null, cols: 80 };
      listeners.forEach(({ resolve }) => resolve(entry));
    }
  } catch (error) {
    for (const listeners of currentBatch.values()) {
      listeners.forEach(({ reject }) => reject(error));
    }
  } finally {
    reconnectRestoreInFlight = false;
    if (pendingReconnectRestores.size > 0) {
      scheduleReconnectRestoreFlush();
    }
  }
}

export function requestScrollbackRestore(agentId: string): Promise<ScrollbackBatchEntry> {
  return new Promise<ScrollbackBatchEntry>((resolve, reject) => {
    const listeners = pendingReconnectRestores.get(agentId);
    if (listeners) {
      listeners.push({ resolve, reject });
    } else {
      pendingReconnectRestores.set(agentId, [{ resolve, reject }]);
    }
    scheduleReconnectRestoreFlush();
  });
}

export function requestReconnectScrollback(agentId: string): Promise<ScrollbackBatchEntry> {
  return requestScrollbackRestore(agentId);
}
