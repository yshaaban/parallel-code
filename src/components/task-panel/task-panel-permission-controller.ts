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

function getTaskAgentIds(task: Task): string[] {
  return Array.from(new Set([...task.agentIds, ...task.shellAgentIds]));
}

function getPendingTaskPermissionEntries(task: Task): TaskPermissionRequestEntry[] {
  const entries: TaskPermissionRequestEntry[] = [];

  for (const agentId of getTaskAgentIds(task)) {
    const requests = store.permissionRequests[agentId];
    if (!requests) {
      continue;
    }

    for (const request of requests) {
      if (request.taskId === task.id && request.status === 'pending') {
        entries.push({
          agentId,
          request,
          sourceLabel: getTaskAgentLabel(task, agentId),
        });
      }
    }
  }

  return entries;
}

function getAgentLabel(agentId: string): string {
  return store.agents[agentId]?.def.name ?? agentId;
}

function getTaskAgentLabel(task: Task, agentId: string): string {
  const agentIds = getTaskAgentIds(task);
  const label = getAgentLabel(agentId);
  const sameLabelAgentIds = agentIds.filter(
    (currentAgentId) => getAgentLabel(currentAgentId) === label,
  );
  if (sameLabelAgentIds.length <= 1) {
    return label;
  }

  const labelIndex = sameLabelAgentIds.indexOf(agentId);
  return `${label} ${labelIndex + 1}`;
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
