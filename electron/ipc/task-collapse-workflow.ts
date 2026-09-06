import type { ProductionAgentSessionRuntime } from './agent-session-runtime.js';
import type { ProductionTaskShellSessionRuntime } from './task-shell-session-runtime.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import { cleanupTaskRuntimeWorkflow, setTaskAgentSpawnsSuspended } from './task-workflows.js';
import { killTaskAgentsAndWaitForRunnerCleanup } from './pty.js';
import {
  changed,
  unchanged,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject } from './workspace-state-storage.js';

export interface SetTaskCollapsedRequest {
  taskId: string;
  collapsed: boolean;
}

export interface TaskCollapseWorkflow {
  drain(): Promise<void>;
  setCollapsed(
    request: Readonly<SetTaskCollapsedRequest>,
    assertAdmitted: () => void,
  ): Promise<void>;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Visibility changes never replace canonical session identity. The existing session owners
 * retain exact clean-stop proof so ordinary attach can resume it on this host or after restart. */
export function createTaskCollapseWorkflow(dependencies: {
  agentSession: Pick<ProductionAgentSessionRuntime, 'suspendTaskSessions'>;
  shell: Pick<ProductionTaskShellSessionRuntime, 'suspendTaskSessions'>;
  privateAuthority: WorkspacePrivateMutationAuthority;
  structure: Pick<TaskStructureMutationService, 'isTaskMutationAdmissionClosed'>;
  stopRemainingSessions?: typeof killTaskAgentsAndWaitForRunnerCleanup;
  cleanupRuntime?: typeof cleanupTaskRuntimeWorkflow;
  suspendSpawns?: typeof setTaskAgentSpawnsSuspended;
}): TaskCollapseWorkflow {
  const tails = new Map<string, Promise<void>>();
  let draining = false;

  async function suspend(taskId: string, assertAdmitted: () => void): Promise<void> {
    assertAdmitted();
    await (dependencies.suspendSpawns ?? setTaskAgentSpawnsSuspended)(taskId, true);
    assertAdmitted();
    const results = await Promise.allSettled([
      dependencies.agentSession.suspendTaskSessions(taskId, assertAdmitted),
      dependencies.shell.suspendTaskSessions(taskId, assertAdmitted),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw Object.assign(new Error('Task session suspension failed'), { failures });
    assertAdmitted();
    await (dependencies.stopRemainingSessions ?? killTaskAgentsAndWaitForRunnerCleanup)(taskId);
    assertAdmitted();
    (dependencies.cleanupRuntime ?? cleanupTaskRuntimeWorkflow)({
      agentIds: [],
      removeTaskState: false,
      taskId,
    });
  }

  async function execute(
    request: Readonly<SetTaskCollapsedRequest>,
    assertAdmitted: () => void,
  ): Promise<void> {
    const assertOpen = (): void => {
      assertAdmitted();
      if (dependencies.structure.isTaskMutationAdmissionClosed(request.taskId))
        throw new Error('Task is closing');
    };
    assertOpen();
    if (!request.collapsed) {
      const current = await dependencies.privateAuthority.mutate(
        { operation: 'read-task-collapsed' },
        (slices) => {
          const tasks = slices.sharedState.tasks;
          const task = isObject(tasks) ? tasks[request.taskId] : undefined;
          if (!isObject(task) || task.id !== request.taskId)
            throw new Error('Canonical task is unavailable');
          if (task.collapsed === true) {
            const ids =
              task.taskMode === 'terminal'
                ? task.shellAgentIds
                : Array.isArray(task.agentIds) && task.agentIds.length
                  ? task.agentIds
                  : [task.agentId];
            if (
              !Array.isArray(ids) ||
              ids.length === 0 ||
              !ids.every((id) => typeof id === 'string' && id.trim().length > 0)
            ) {
              throw new Error(
                'This older collapsed task has no recoverable canonical session identity. Its files are preserved. Restore a workspace backup with its original session IDs, or create a new task to continue.',
              );
            }
          }
          return unchanged(task.collapsed === true);
        },
      );
      // Finish a retained failed stop/permit write before removing the admission barrier.
      if (current.result) await suspend(request.taskId, assertOpen);
    }
    await dependencies.privateAuthority.mutate({ operation: 'set-task-collapsed' }, (slices) => {
      assertOpen();
      const tasks = slices.sharedState.tasks;
      const task = isObject(tasks) ? tasks[request.taskId] : undefined;
      if (!isObject(task) || task.id !== request.taskId)
        throw new Error('Canonical task is unavailable');
      const active = slices.sharedState.taskOrder;
      const collapsed = slices.sharedState.collapsedTaskOrder;
      if (
        !Array.isArray(active) ||
        !Array.isArray(collapsed) ||
        !active.every((id) => typeof id === 'string') ||
        !collapsed.every((id) => typeof id === 'string')
      )
        throw new Error('Canonical task order is unavailable');
      const destination = request.collapsed ? collapsed : active;
      if ((task.collapsed === true) === request.collapsed && destination.includes(request.taskId))
        return unchanged(undefined);
      const nextSharedState = cloneJsonObject(slices.sharedState);
      const nextTask = { ...task };
      if (request.collapsed) nextTask.collapsed = true;
      else delete nextTask.collapsed;
      (nextSharedState.tasks as JsonObject)[request.taskId] = nextTask;
      nextSharedState.taskOrder = active.filter((id) => id !== request.taskId);
      nextSharedState.collapsedTaskOrder = collapsed.filter((id) => id !== request.taskId);
      const order = request.collapsed
        ? nextSharedState.collapsedTaskOrder
        : nextSharedState.taskOrder;
      (order as string[]).push(request.taskId);
      return changed({ nextSharedState }, undefined);
    });
    if (!request.collapsed) {
      await (dependencies.suspendSpawns ?? setTaskAgentSpawnsSuspended)(request.taskId, false);
      return;
    }
    // Persist collapsed first: recovery/attach sees the canonical admission barrier while stop
    // and permit persistence settle. A failed attempt stays collapsed and can be retried exactly.
    await suspend(request.taskId, assertOpen);
  }

  return {
    async drain() {
      draining = true;
      await Promise.allSettled([...tails.values()]);
    },
    setCollapsed(request, assertAdmitted) {
      if (draining) return Promise.reject(new Error('Task visibility owner is shutting down'));
      const previous = tails.get(request.taskId) ?? Promise.resolve();
      const stableRequest = { ...request };
      const pending = previous
        .catch(() => undefined)
        .then(() => execute(stableRequest, assertAdmitted));
      tails.set(request.taskId, pending);
      void pending
        .finally(() => {
          if (tails.get(request.taskId) === pending) tails.delete(request.taskId);
        })
        .catch(() => undefined);
      return pending;
    },
  };
}
