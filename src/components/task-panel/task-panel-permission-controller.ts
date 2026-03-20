import { createMemo, type Accessor } from 'solid-js';

import { handleTaskPermissionResponse } from '../../app/task-permission-workflows';
import { store } from '../../store/state';
import type { PermissionRequest, Task } from '../../store/types';

interface TaskPanelPermissionControllerOptions {
  task: Accessor<Task>;
}

export function createTaskPanelPermissionController(
  options: TaskPanelPermissionControllerOptions,
): {
  approvePermissionRequest: (requestId: string) => Promise<void>;
  denyPermissionRequest: (requestId: string) => Promise<void>;
  firstAgentId: Accessor<string>;
  pendingPermission: Accessor<PermissionRequest | undefined>;
} {
  const firstAgentId = createMemo(() => options.task().agentIds[0] ?? '');
  const pendingPermission = createMemo(() => {
    const agentId = firstAgentId();
    if (!agentId) {
      return undefined;
    }

    const requests = store.permissionRequests[agentId];
    if (!requests) {
      return undefined;
    }

    return requests.find((request) => request.status === 'pending');
  });

  async function respondToPermissionRequest(
    requestId: string,
    action: 'approve' | 'deny',
  ): Promise<void> {
    const agentId = firstAgentId();
    if (!agentId) {
      return;
    }

    await handleTaskPermissionResponse(agentId, requestId, action);
  }

  return {
    approvePermissionRequest: async (requestId: string) =>
      respondToPermissionRequest(requestId, 'approve'),
    denyPermissionRequest: async (requestId: string) =>
      respondToPermissionRequest(requestId, 'deny'),
    firstAgentId,
    pendingPermission,
  };
}
