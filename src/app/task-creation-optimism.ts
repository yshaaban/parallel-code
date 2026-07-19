import { createSignal } from 'solid-js';
import { createRandomId } from '../lib/random-id';
import type { TaskMode } from '../domain/task-mode';
import type { TaskGitIsolationMode } from '../store/types';

// Renderer-local optimistic task creation. Pending records render as
// provisional columns while the backend create round trip is in flight; they
// never enter store.tasks/taskOrder, are never persisted or synced, and there
// is deliberately no provisional-id -> real-id swap: the real task lands
// through the unchanged createTask store insert and the pending ghost is
// removed in the same resolve continuation.
export interface PendingTaskCreation {
  baseBranch?: string;
  gitIsolation?: TaskGitIsolationMode;
  launchLabel: string;
  name: string;
  pendingId: string;
  projectId: string;
  startedAtMs: number;
  state: { kind: 'creating' } | { kind: 'error'; message: string };
  taskMode: TaskMode;
}

interface PendingTaskCreationRuntime {
  entry: PendingTaskCreation;
  onCreated: ((taskId: string) => void) | undefined;
  run: () => Promise<string>;
}

const pendingTaskCreationRuntimes = new Map<string, PendingTaskCreationRuntime>();
const [pendingTaskCreations, setPendingTaskCreations] = createSignal<PendingTaskCreation[]>([]);

function syncPendingTaskCreationsSignal(): void {
  setPendingTaskCreations(
    Array.from(pendingTaskCreationRuntimes.values(), (runtime) => runtime.entry),
  );
}

function removePendingTaskCreation(pendingId: string): void {
  if (pendingTaskCreationRuntimes.delete(pendingId)) {
    syncPendingTaskCreationsSignal();
  }
}

function getPendingTaskCreationRuntime(pendingId: string): PendingTaskCreationRuntime | null {
  return pendingTaskCreationRuntimes.get(pendingId) ?? null;
}

function getCreateTaskErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  return message || 'Task creation failed.';
}

function runPendingTaskCreation(pendingId: string): void {
  const runtime = getPendingTaskCreationRuntime(pendingId);
  if (!runtime) {
    return;
  }

  runtime.entry = { ...runtime.entry, state: { kind: 'creating' } };
  syncPendingTaskCreationsSignal();

  void runtime.run().then(
    (taskId) => {
      const currentRuntime = getPendingTaskCreationRuntime(pendingId);
      // The real task is already in the store via the createTask insert;
      // removing the ghost in the same continuation keeps column count
      // continuous (ghost out, real column in).
      removePendingTaskCreation(pendingId);
      currentRuntime?.onCreated?.(taskId);
    },
    (error: unknown) => {
      const currentRuntime = getPendingTaskCreationRuntime(pendingId);
      if (!currentRuntime) {
        return;
      }

      currentRuntime.entry = {
        ...currentRuntime.entry,
        state: { kind: 'error', message: getCreateTaskErrorMessage(error) },
      };
      syncPendingTaskCreationsSignal();
    },
  );
}

export function createTaskOptimistically(options: {
  baseBranch?: string;
  gitIsolation?: TaskGitIsolationMode;
  launchLabel: string;
  name: string;
  onCreated?: (taskId: string) => void;
  projectId: string;
  run: () => Promise<string>;
  taskMode: TaskMode;
}): string {
  const pendingId = `pending-task:${createRandomId()}`;
  pendingTaskCreationRuntimes.set(pendingId, {
    entry: {
      ...(options.baseBranch !== undefined ? { baseBranch: options.baseBranch } : {}),
      ...(options.gitIsolation !== undefined ? { gitIsolation: options.gitIsolation } : {}),
      launchLabel: options.launchLabel,
      name: options.name,
      pendingId,
      projectId: options.projectId,
      startedAtMs: Date.now(),
      state: { kind: 'creating' },
      taskMode: options.taskMode,
    },
    onCreated: options.onCreated,
    run: options.run,
  });
  syncPendingTaskCreationsSignal();
  runPendingTaskCreation(pendingId);
  return pendingId;
}

export function retryPendingTaskCreation(pendingId: string): void {
  const runtime = getPendingTaskCreationRuntime(pendingId);
  if (!runtime || runtime.entry.state.kind !== 'error') {
    return;
  }

  runPendingTaskCreation(pendingId);
}

export function dismissPendingTaskCreation(pendingId: string): void {
  const runtime = getPendingTaskCreationRuntime(pendingId);
  if (!runtime || runtime.entry.state.kind !== 'error') {
    return;
  }

  removePendingTaskCreation(pendingId);
}

export function listPendingTaskCreations(): PendingTaskCreation[] {
  return pendingTaskCreations();
}

export function resetPendingTaskCreationsForTests(): void {
  pendingTaskCreationRuntimes.clear();
  syncPendingTaskCreationsSignal();
}
