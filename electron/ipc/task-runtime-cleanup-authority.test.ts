import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import { createTaskAndGitIpcHandlers } from './task-git-handlers.js';
import { acquireTaskCommandLease, resetTaskCommandLeasesForTest } from './task-command-leases.js';
import {
  getAgentSupervisionSnapshot,
  recordAgentOutput,
  recordAgentSpawn,
  removeTaskSupervision,
} from './agent-supervision.js';

afterEach(() => {
  removeTaskSupervision('cleanup-owner');
  removeTaskSupervision('cleanup-peer');
  resetTaskCommandLeasesForTest();
});

describe('nonfinal runtime cleanup production authority', () => {
  it('a real task lease never authorizes clearing another task supervision, including stale caller hints', async () => {
    recordAgentSpawn({ agentId: 'owner-agent', isShell: false, taskId: 'cleanup-owner' });
    recordAgentSpawn({ agentId: 'owner-sidecar', isShell: true, taskId: 'cleanup-owner' });
    recordAgentSpawn({ agentId: 'peer-agent', isShell: false, taskId: 'cleanup-peer' });
    const handlers = createTaskAndGitIpcHandlers(
      { isPackaged: true, userDataPath: '/unused', sendToChannel: vi.fn() },
      { deleteTask: vi.fn(), registerCreatedTask: vi.fn() },
    );
    acquireTaskCommandLease('cleanup-owner', 'client-1', 'owner-1', 'collapse');
    await expect(
      handlers[IPC.CleanupTaskRuntime]?.({
        taskId: 'cleanup-owner',
        controllerId: 'client-1',
        agentIds: ['peer-agent'],
      }),
    ).rejects.toThrow('belongs to another task');
    expect(getAgentSupervisionSnapshot('owner-agent')).not.toBeNull();
    expect(getAgentSupervisionSnapshot('peer-agent')).not.toBeNull();
    await handlers[IPC.CleanupTaskRuntime]?.({
      taskId: 'cleanup-owner',
      controllerId: 'client-1',
      agentIds: ['stale-agent'],
    });
    expect(getAgentSupervisionSnapshot('owner-agent')).toBeNull();
    expect(getAgentSupervisionSnapshot('owner-sidecar')).toBeNull();
    recordAgentOutput('peer-agent', 'Still running after peer cleanup');
    expect(getAgentSupervisionSnapshot('peer-agent')).toMatchObject({ taskId: 'cleanup-peer' });
  });
});
