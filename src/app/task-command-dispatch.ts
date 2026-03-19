import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { store } from '../store/state';

const AGENT_WRITE_READY_TIMEOUT_MS = 8_000;
const AGENT_WRITE_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentNotFoundError(error: unknown): boolean {
  return String(error).toLowerCase().includes('agent not found');
}

function isTaskControlledError(error: unknown): boolean {
  return String(error).toLowerCase().includes('controlled by another client');
}

export async function returnFallbackWhenTaskControlled<T>(
  run: () => Promise<T>,
  fallbackValue: T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isTaskControlledError(error)) {
      return fallbackValue;
    }

    throw error;
  }
}

export async function writeToAgentWhenReady(
  agentId: string,
  data: string,
  taskId?: string,
  controllerId?: string,
): Promise<void> {
  const deadline = Date.now() + AGENT_WRITE_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      await invoke(IPC.WriteToAgent, {
        agentId,
        data,
        ...(controllerId ? { controllerId } : {}),
        ...(taskId ? { taskId } : {}),
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isAgentNotFoundError(error)) {
        throw error;
      }

      const agent = store.agents[agentId];
      if (!agent || agent.status === 'exited') {
        throw error;
      }

      await sleep(AGENT_WRITE_RETRY_MS);
    }
  }

  throw lastError ?? new Error(`Timed out waiting for agent ${agentId} to become writable`);
}
