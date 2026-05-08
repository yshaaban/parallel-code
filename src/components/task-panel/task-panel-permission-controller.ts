import { createMemo, type Accessor } from 'solid-js';

import { handleTaskPermissionResponse } from '../../app/task-permission-workflows';
import { store } from '../../store/state';
import type { PermissionRequest, Task } from '../../store/types';

interface TaskPanelPermissionControllerOptions {
  task: Accessor<Task>;
}

export interface TaskPermissionRequestEntry {
  agentId: string;
  request: PermissionRequest;
  sourceLabel: string;
}

interface TaskAgentLabelProjection {
  agentIds: string[];
  sourceLabelsByAgentId: ReadonlyMap<string, string>;
}

function getTaskAgentIds(task: Task): string[] {
  return Array.from(new Set([...task.agentIds, ...task.shellAgentIds]));
}

function getPendingTaskPermissionEntries(task: Task): TaskPermissionRequestEntry[] {
  const entries: TaskPermissionRequestEntry[] = [];
  const agentLabelProjection = getTaskAgentLabelProjection(task);

  for (const agentId of agentLabelProjection.agentIds) {
    const requests = store.permissionRequests[agentId];
    if (!requests) {
      continue;
    }

    for (const request of requests) {
      if (request.taskId === task.id && request.status === 'pending') {
        entries.push({
          agentId,
          request,
          sourceLabel: agentLabelProjection.sourceLabelsByAgentId.get(agentId) ?? agentId,
        });
      }
    }
  }

  return entries;
}

function getAgentLabel(agentId: string): string {
  return store.agents[agentId]?.def.name ?? agentId;
}

function getTaskAgentLabelProjection(task: Task): TaskAgentLabelProjection {
  const agentIds = getTaskAgentIds(task);
  const baseLabelsByAgentId = new Map<string, string>();
  const labelCounts = new Map<string, number>();
  const sourceLabelsByAgentId = new Map<string, string>();

  for (const agentId of agentIds) {
    const label = getAgentLabel(agentId);
    baseLabelsByAgentId.set(agentId, label);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  const emittedLabelCounts = new Map<string, number>();
  for (const agentId of agentIds) {
    const label = baseLabelsByAgentId.get(agentId) ?? agentId;
    if ((labelCounts.get(label) ?? 0) <= 1) {
      sourceLabelsByAgentId.set(agentId, label);
      continue;
    }

    const labelIndex = (emittedLabelCounts.get(label) ?? 0) + 1;
    emittedLabelCounts.set(label, labelIndex);
    sourceLabelsByAgentId.set(agentId, `${label} ${labelIndex}`);
  }

  return {
    agentIds,
    sourceLabelsByAgentId,
  };
}

export function createTaskPanelPermissionController(
  options: TaskPanelPermissionControllerOptions,
): {
  approvePermissionRequest: (requestId: string) => Promise<void>;
  denyPermissionRequest: (requestId: string) => Promise<void>;
  firstAgentId: Accessor<string>;
  pendingPermissionEntries: Accessor<TaskPermissionRequestEntry[]>;
} {
  const firstAgentId = createMemo(() => options.task().agentIds[0] ?? '');
  const pendingPermissionEntries = createMemo(() =>
    getPendingTaskPermissionEntries(options.task()),
  );

  async function respondToPermissionRequest(
    requestId: string,
    action: 'approve' | 'deny',
  ): Promise<void> {
    const entry = pendingPermissionEntries().find(
      (permissionEntry) => permissionEntry.request.id === requestId,
    );
    if (!entry) {
      return;
    }

    await handleTaskPermissionResponse(entry.agentId, requestId, action);
  }

  return {
    approvePermissionRequest: async (requestId: string) =>
      respondToPermissionRequest(requestId, 'approve'),
    denyPermissionRequest: async (requestId: string) =>
      respondToPermissionRequest(requestId, 'deny'),
    firstAgentId,
    pendingPermissionEntries,
  };
}
