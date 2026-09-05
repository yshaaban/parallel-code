import { getActiveAgentIds, getAgentMeta, onPtyEvent } from './pty.js';
import type { TaskCatalogSessionRuntime, TaskCatalogState } from './task-catalog-state.js';

type PtyRuntimeEvent = 'exit' | 'pause' | 'resume' | 'spawn';

export interface TaskCatalogPtyRuntimeDependencies {
  getActiveAgentIds: () => string[];
  getAgentMeta: typeof getAgentMeta;
  onProjectionError?: (error: unknown) => void;
  subscribe: (
    event: PtyRuntimeEvent,
    listener: (agentId: string, data?: unknown) => void,
  ) => () => void;
}

const defaultDependencies: TaskCatalogPtyRuntimeDependencies = {
  getActiveAgentIds,
  getAgentMeta,
  onProjectionError: (error) => console.error('[task-catalog] PTY projection failed:', error),
  subscribe: onPtyEvent,
};

function readLifecycleGeneration(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const generation = (value as { generation?: unknown }).generation;
  return Number.isSafeInteger(generation) && (generation as number) >= 0
    ? (generation as number)
    : null;
}

function readExitState(value: unknown): TaskCatalogSessionRuntime['state'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'failed';
  return (value as { exitCode?: unknown }).exitCode === 0 ? 'stopped' : 'failed';
}

/** Snapshot the PTY owner without exposing command/configuration data to the catalog. */
export function getCurrentTaskCatalogSessionRuntime(
  dependencies: TaskCatalogPtyRuntimeDependencies = defaultDependencies,
): TaskCatalogSessionRuntime[] {
  const runtime: TaskCatalogSessionRuntime[] = [];
  for (const sessionId of dependencies.getActiveAgentIds()) {
    const metadata = dependencies.getAgentMeta(sessionId);
    if (!metadata) continue;
    runtime.push({
      generation: metadata.generation,
      sessionId,
      state: 'running',
    });
  }
  return runtime;
}

/**
 * Narrow event adapter from PTY lifecycle truth to the singleton catalog
 * projection. Structural replacement remains owned by saved-state sync.
 */
export function subscribeTaskCatalogPtyRuntime(
  catalog: Pick<TaskCatalogState, 'updateSessionRuntime'>,
  dependencies: TaskCatalogPtyRuntimeDependencies = defaultDependencies,
): () => void {
  const update = (sessionId: string, data: unknown, state: TaskCatalogSessionRuntime['state']) => {
    const generation =
      readLifecycleGeneration(data) ?? dependencies.getAgentMeta(sessionId)?.generation ?? null;
    if (generation === null) return;
    try {
      catalog.updateSessionRuntime({ generation, sessionId, state });
    } catch (error) {
      dependencies.onProjectionError?.(error);
    }
  };
  const cleanups = [
    dependencies.subscribe('spawn', (sessionId, data) => update(sessionId, data, 'running')),
    dependencies.subscribe('pause', (sessionId, data) => update(sessionId, data, 'running')),
    dependencies.subscribe('resume', (sessionId, data) => update(sessionId, data, 'running')),
    dependencies.subscribe('exit', (sessionId, data) =>
      update(sessionId, data, readExitState(data)),
    ),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
