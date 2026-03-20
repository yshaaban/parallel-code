import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { resolvePermission } from '../store/review';
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
      await invoke(IPC.WriteToAgent, { agentId, data: response });
    },
  );

  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }

  resolvePermission(agentId, requestId, action === 'approve' ? 'approved' : 'denied');
}
