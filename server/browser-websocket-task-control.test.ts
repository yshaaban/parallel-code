import { describe, expect, it, vi } from 'vitest';

import {
  browserAgentControllerStillOwnsTask,
  hasBrowserTaskControlForMessage,
  resolveBrowserAgentTaskId,
} from './browser-websocket-task-control.js';

describe('browser websocket task control helpers', () => {
  it('resolves explicit task ids before consulting backend agent metadata', () => {
    const getAgentTaskId = vi.fn(() => 'task-from-agent');

    expect(
      resolveBrowserAgentTaskId(
        {
          agentId: 'agent-1',
          controllerId: 'client-1',
          taskId: 'task-explicit',
        },
        getAgentTaskId,
      ),
    ).toBe('task-explicit');
    expect(getAgentTaskId).not.toHaveBeenCalled();
  });

  it('rejects browser commands without authenticated client identity', () => {
    expect(hasBrowserTaskControlForMessage({ agentId: 'agent-1' }, null)).toBe(false);
  });

  it('rejects browser commands that declare a different controller id', () => {
    const canControlTask = vi.fn(() => true);
    const getAgentTaskId = vi.fn(() => 'task-1');

    expect(
      hasBrowserTaskControlForMessage(
        {
          agentId: 'agent-1',
          controllerId: 'client-2',
          taskId: 'task-1',
        },
        'client-1',
        canControlTask,
        getAgentTaskId,
      ),
    ).toBe(false);
    expect(canControlTask).not.toHaveBeenCalled();
    expect(getAgentTaskId).not.toHaveBeenCalled();
  });

  it('keeps legacy agent commands allowed when no task id can be resolved', () => {
    const canControlTask = vi.fn(() => false);
    const getAgentTaskId = vi.fn(() => undefined);

    expect(
      hasBrowserTaskControlForMessage(
        {
          agentId: 'agent-1',
        },
        'client-1',
        canControlTask,
        getAgentTaskId,
      ),
    ).toBe(true);
    expect(canControlTask).not.toHaveBeenCalled();
  });

  it('checks task-command ownership when a task id is available', () => {
    const canControlTask = vi.fn((taskId: string, controllerId: string) => {
      return taskId === 'task-1' && controllerId === 'client-1';
    });

    expect(
      hasBrowserTaskControlForMessage(
        {
          agentId: 'agent-1',
          controllerId: 'client-1',
          taskId: 'task-1',
        },
        'client-1',
        canControlTask,
      ),
    ).toBe(true);
    expect(canControlTask).toHaveBeenCalledWith('task-1', 'client-1');
  });

  it('detects whether a stale agent controller still owns the resolved task', () => {
    const canControlTask = vi.fn((taskId: string, controllerId: string) => {
      return taskId === 'task-from-agent' && controllerId === 'stale-client';
    });
    const getAgentTaskId = vi.fn(() => 'task-from-agent');

    expect(
      browserAgentControllerStillOwnsTask(
        {
          agentId: 'agent-1',
        },
        'stale-client',
        canControlTask,
        getAgentTaskId,
      ),
    ).toBe(true);
    expect(canControlTask).toHaveBeenCalledWith('task-from-agent', 'stale-client');
  });
});
