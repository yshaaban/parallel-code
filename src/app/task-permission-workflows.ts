import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { resolvePermission } from '../store/review';
import { store } from '../store/state';
import { isTaskCommandLeaseSkipped, runWithAgentTaskCommandLease } from './task-command-lease';

export async function handleTaskPermissionResponse(
  agentId: string,
  requestId: string,
  action: 'approve' | 'deny',
): Promise<void> {
  const response = action === 'approve' ? 'y\n' : 'n\n';
  const result = await runWithAgentTaskCommandLease(
    agentId,
    `${action} a permission request`,
    async () => {
      const taskId = store.agents?.[agentId]?.taskId;
      await invoke(IPC.WriteToAgent, {
        agentId,
        controllerId: getRuntimeClientId(),
        data: response,
        ...(taskId ? { taskId } : {}),
      });
    },
  );

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }

  resolvePermission(agentId, requestId, action === 'approve' ? 'approved' : 'denied');
}
