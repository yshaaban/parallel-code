import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentPromptDispatchAt, markTaskPromptDispatch } from '../app/task-prompt-dispatch';
import { IPC } from '../../electron/ipc/channels';
import { setStore, store } from './core';
import {
  addAgentToTask,
  closeAgentInTask,
  getAgentTerminalSessionVersion,
  hydrateAgentGeneration,
  markAgentExited,
  restartAgent,
  switchAgent,
} from './agents';
import { createTestAgent, resetStoreForTest } from '../test/store-test-helpers';
import type { Agent } from './types';

const { invokeMock, saveCurrentRuntimeStateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveCurrentRuntimeStateMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('./persistence-save', () => ({
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
}));

function requireAgent(agentId: string): Agent {
  const agent = store.agents[agentId];
  if (!agent) {
    throw new Error(`Expected agent ${agentId} to exist`);
  }

  return agent;
}

function createDeferredPromise(): {
  promise: Promise<undefined>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<undefined>((nextResolve) => {
    resolve = () => nextResolve(undefined);
  });
  return { promise, resolve };
}

describe('agents store lifecycle guards', () => {
  beforeEach(() => {
    resetStoreForTest();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    saveCurrentRuntimeStateMock.mockReset();
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);
  });

  it('ignores stale exit callbacks from an older agent generation', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 0,
        id: 'agent-1',
      }),
    });

    restartAgent('agent-1', false);
    expect(store.agents['agent-1']?.generation).toBe(1);
    expect(store.agents['agent-1']?.status).toBe('running');

    markAgentExited(
      'agent-1',
      {
        exit_code: 1,
        last_output: ['stale exit'],
        signal: 'SIGTERM',
      },
      0,
    );

    expect(store.agents['agent-1']).toEqual(
      expect.objectContaining({
        exitCode: null,
        generation: 1,
        signal: null,
        status: 'running',
      }),
    );
  });

  it('records exits for the current agent generation', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 2,
        id: 'agent-1',
      }),
    });

    markAgentExited(
      'agent-1',
      {
        exit_code: 17,
        last_output: ['Process exited'],
        signal: 'SIGTERM',
      },
      2,
    );

    expect(store.agents['agent-1']).toEqual(
      expect.objectContaining({
        exitCode: 17,
        generation: 2,
        lastOutput: ['Process exited'],
        signal: 'SIGTERM',
        status: 'exited',
      }),
    );
  });

  it('ignores invalid hydrated agent generations', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 1,
        id: 'agent-1',
      }),
    });

    hydrateAgentGeneration('agent-1', -1);
    hydrateAgentGeneration('agent-1', 1.5);

    expect(store.agents['agent-1']?.generation).toBe(1);
  });

  it('keeps terminal session remount version separate from hydrated backend generations', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 0,
        id: 'agent-1',
      }),
    });

    hydrateAgentGeneration('agent-1', 4);
    expect(store.agents['agent-1']?.generation).toBe(4);
    expect(getAgentTerminalSessionVersion(requireAgent('agent-1'))).toBe(0);

    restartAgent('agent-1', false);
    expect(store.agents['agent-1']?.generation).toBe(5);
    expect(getAgentTerminalSessionVersion(requireAgent('agent-1'))).toBe(1);

    switchAgent('agent-1', {
      id: 'replacement',
      name: 'Replacement',
      command: 'replacement',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: 'replacement',
    });
    expect(store.agents['agent-1']?.generation).toBe(6);
    expect(getAgentTerminalSessionVersion(requireAgent('agent-1'))).toBe(2);
  });

  it('clears prompt dispatch state when an agent exits', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 2,
        id: 'agent-1',
      }),
    });
    markTaskPromptDispatch('agent-1', 2, 1_000);

    markAgentExited(
      'agent-1',
      {
        exit_code: 17,
        last_output: ['Process exited'],
        signal: 'SIGTERM',
      },
      2,
    );

    expect(getAgentPromptDispatchAt('agent-1', 2, 1_100)).toBeNull();
  });

  it('clears prompt dispatch state when an agent restarts or switches', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        generation: 0,
        id: 'agent-1',
      }),
    });
    markTaskPromptDispatch('agent-1', 0, 1_000);

    restartAgent('agent-1', false);
    expect(getAgentPromptDispatchAt('agent-1', 1, 1_100)).toBeNull();

    markTaskPromptDispatch('agent-1', 1, 1_200);
    switchAgent('agent-1', {
      id: 'replacement',
      name: 'Replacement',
      command: 'replacement',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: 'replacement',
    });

    expect(getAgentPromptDispatchAt('agent-1', 2, 1_300)).toBeNull();
  });

  it('adds a task agent as the selected command target', async () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        selectedAgentId: 'agent-1',
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });

    const agentId = await addAgentToTask('task-1', {
      id: 'codex',
      name: 'Codex',
      command: 'codex',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: 'Codex agent',
    });

    expect(agentId).toEqual(expect.any(String));
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1', agentId]);
    expect(store.tasks['task-1']?.selectedAgentId).toBe(agentId);
    expect(store.activeAgentId).toBe(agentId);
    expect(store.lastAgentId).toBe('codex');
    expect(store.agents[agentId ?? '']).toMatchObject({
      def: expect.objectContaining({ id: 'codex' }),
      status: 'running',
      taskId: 'task-1',
    });
    expect(store.agentActive[agentId ?? '']).toBe(true);
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
  });

  it('closes a task agent and selects a remaining sibling when needed', async () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1', 'agent-2'],
        selectedAgentId: 'agent-2',
        terminalLayoutMode: 'split',
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('activeAgentId', 'agent-2');
    setStore('agentActive', { 'agent-2': true });
    markTaskPromptDispatch('agent-2', 0, 1_000);

    await closeAgentInTask('task-1', 'agent-2');

    expect(invokeMock).toHaveBeenCalledWith(IPC.KillAgent, { agentId: 'agent-2' });
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1']);
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-1');
    expect(store.tasks['task-1']?.terminalLayoutMode).toBeUndefined();
    expect(store.activeAgentId).toBe('agent-1');
    expect(store.agents['agent-2']).toBeUndefined();
    expect(store.agentActive['agent-2']).toBeUndefined();
    expect(getAgentPromptDispatchAt('agent-2', 0, 1_100)).toBeNull();
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
  });

  it('closes a passive task agent without moving the selected command target', async () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1', 'agent-2', 'agent-3'],
        selectedAgentId: 'agent-1',
        terminalLayoutMode: 'grid',
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
      'agent-3': createTestAgent({ id: 'agent-3', taskId: 'task-1' }),
    });
    setStore('activeAgentId', 'agent-1');

    await closeAgentInTask('task-1', 'agent-2');

    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1', 'agent-3']);
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-1');
    expect(store.tasks['task-1']?.terminalLayoutMode).toBe('grid');
    expect(store.activeAgentId).toBe('agent-1');
    expect(store.agents['agent-2']).toBeUndefined();
  });

  it('does not close the last task agent', async () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        selectedAgentId: 'agent-1',
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });

    await closeAgentInTask('task-1', 'agent-1');

    expect(invokeMock).not.toHaveBeenCalled();
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1']);
    expect(store.agents['agent-1']).toBeDefined();
    expect(saveCurrentRuntimeStateMock).not.toHaveBeenCalled();
  });

  it('does not kill the last remaining task agent while another sibling close is pending', async () => {
    const killAgent = createDeferredPromise();
    invokeMock.mockReturnValueOnce(killAgent.promise);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1', 'agent-2'],
        selectedAgentId: 'agent-1',
        terminalLayoutMode: 'split',
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('activeAgentId', 'agent-1');

    const firstClose = closeAgentInTask('task-1', 'agent-1');
    const secondClose = closeAgentInTask('task-1', 'agent-2');
    await secondClose;

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(IPC.KillAgent, { agentId: 'agent-1' });
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1', 'agent-2']);

    killAgent.resolve();
    await firstClose;

    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-2']);
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-2');
    expect(store.activeAgentId).toBe('agent-2');
    expect(store.agents['agent-1']).toBeUndefined();
    expect(store.agents['agent-2']).toBeDefined();
  });
});
