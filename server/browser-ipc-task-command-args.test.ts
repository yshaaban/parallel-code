import { describe, expect, it, vi } from 'vitest';

import { IPC } from '../electron/ipc/channels.js';
import { normalizeBrowserIpcTaskCommandArgs } from './browser-ipc-task-command-args.js';

describe('browser IPC task-command args', () => {
  it('leaves args unchanged when the browser client identity is missing', () => {
    const args = { agentId: 'agent-1', data: 'echo ok\n' };

    expect(normalizeBrowserIpcTaskCommandArgs(IPC.WriteToAgent, args, null)).toBe(args);
  });

  it('injects browser controller identity into spawned agents', () => {
    expect(
      normalizeBrowserIpcTaskCommandArgs(IPC.SpawnAgent, { taskId: 'task-1' }, 'client-1'),
    ).toEqual({
      controllerId: 'client-1',
      taskId: 'task-1',
    });
  });

  it('preserves explicit task ids on browser terminal writes', () => {
    const getAgentTaskId = vi.fn();

    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.WriteToAgent,
        {
          agentId: 'agent-1',
          data: 'echo ok\n',
          taskId: 'task-explicit',
        },
        'client-1',
        getAgentTaskId,
      ),
    ).toEqual({
      agentId: 'agent-1',
      controllerId: 'client-1',
      data: 'echo ok\n',
      taskId: 'task-explicit',
    });
    expect(getAgentTaskId).not.toHaveBeenCalled();
  });

  it('resolves missing task ids from backend-owned agent metadata for terminal commands', () => {
    const getAgentTaskId = vi.fn(() => 'task-from-agent');

    expect(
      normalizeBrowserIpcTaskCommandArgs(
        IPC.ResizeAgent,
        {
          agentId: 'agent-1',
          cols: 120,
          rows: 32,
        },
        'client-1',
        getAgentTaskId,
      ),
    ).toEqual({
      agentId: 'agent-1',
      cols: 120,
      controllerId: 'client-1',
      rows: 32,
      taskId: 'task-from-agent',
    });
    expect(getAgentTaskId).toHaveBeenCalledWith('agent-1');
  });

  it('does not add controller identity to unrelated IPC channels', () => {
    const args = { json: '{}' };

    expect(normalizeBrowserIpcTaskCommandArgs(IPC.SaveAppState, args, 'client-1')).toBe(args);
  });
});
