import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../electron/ipc/channels';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

import { setStore } from '../store/core.js';
import { resetStoreForTest } from '../test/store-test-helpers.js';
import type { Agent, Task } from '../store/types';
import {
  ensureAgentSessionForDeferredTerminal,
  reEnsureDeferredAgentSessionsAfterReconnectRestore,
  resetDeferredAgentSessionEnsureForTests,
} from './agent-session-ensure.js';

function buildTask(taskId: string, agentId: string): Task {
  return {
    id: taskId,
    taskMode: 'agent',
    name: 'Deferred task',
    projectId: 'project-1',
    branchName: `task/${taskId}`,
    worktreePath: `/tmp/${taskId}`,
    agentIds: [agentId],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  } as Task;
}

function buildAgent(agentId: string, taskId: string): Agent {
  return {
    id: agentId,
    taskId,
    def: {
      id: 'agent-def-1',
      name: 'Test Agent',
      command: 'test-agent',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: 'test agent',
    },
    resumed: false,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 1,
  } as Agent;
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function getEnsureBatchCalls(): unknown[][] {
  return invokeMock.mock.calls.filter((call) => call[0] === IPC.EnsureAgentSessionsBatch);
}

describe('deferred terminal agent session ensure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    resetDeferredAgentSessionEnsureForTests();
    setStore('tasks', { 'task-1': buildTask('task-1', 'agent-1') });
    setStore('agents', { 'agent-1': buildAgent('agent-1', 'task-1') });
    invokeMock.mockResolvedValue({
      results: [
        {
          agentId: 'agent-1',
          cols: 80,
          generation: 2,
          kind: 'restored',
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });
  });

  it('dedupes repeated deferred ensures per agent', async () => {
    ensureAgentSessionForDeferredTerminal('task-1', 'agent-1');
    await flushMicrotasks();
    ensureAgentSessionForDeferredTerminal('task-1', 'agent-1');
    await flushMicrotasks();

    expect(getEnsureBatchCalls()).toHaveLength(1);
    expect(getEnsureBatchCalls()[0]?.[1]).toEqual({
      reason: 'startup-restore',
      requests: [{ agentId: 'agent-1', taskId: 'task-1' }],
    });
  });

  it('re-issues the ensure for previously ensured agents after a full reconnect restore', async () => {
    ensureAgentSessionForDeferredTerminal('task-1', 'agent-1');
    await flushMicrotasks();
    expect(getEnsureBatchCalls()).toHaveLength(1);

    // A full reconnect restore can follow backend session loss (server
    // restart), so the pre-disconnect dedupe must not keep suppressing the
    // ensure for still-deferred terminals.
    reEnsureDeferredAgentSessionsAfterReconnectRestore();
    await flushMicrotasks();

    expect(getEnsureBatchCalls()).toHaveLength(2);
    const secondRequest = getEnsureBatchCalls()[1]?.[1] as {
      reason: string;
      requests: Array<{ agentId: string; taskId: string }>;
    };
    expect(secondRequest.reason).toBe('startup-restore');
    expect(secondRequest.requests[0]?.agentId).toBe('agent-1');
    expect(secondRequest.requests[0]?.taskId).toBe('task-1');
  });

  it('skips re-ensure for agents removed by restore reconciliation', async () => {
    ensureAgentSessionForDeferredTerminal('task-1', 'agent-1');
    await flushMicrotasks();
    setStore('agents', { 'agent-1': undefined });

    reEnsureDeferredAgentSessionsAfterReconnectRestore();
    await flushMicrotasks();

    expect(getEnsureBatchCalls()).toHaveLength(1);
  });

  it('does not re-issue ensures for agents that never completed an ensure', async () => {
    invokeMock.mockRejectedValueOnce(new Error('ensure failed'));
    ensureAgentSessionForDeferredTerminal('task-1', 'agent-1');
    await flushMicrotasks();

    reEnsureDeferredAgentSessionsAfterReconnectRestore();
    await flushMicrotasks();

    // The failed ensure never entered the ensured set; the reconnect-restore
    // pass only re-issues ensures it previously confirmed.
    expect(getEnsureBatchCalls()).toHaveLength(1);
  });

  it('does not cache a late success after the agent is remapped', async () => {
    let resolveEnsure!: (value: unknown) => void;
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnsure = resolve;
      }),
    );
    ensureAgentSessionForDeferredTerminal('task-1', 'agent-1');
    setStore('tasks', {
      'task-1': { ...buildTask('task-1', 'agent-1'), agentIds: [] },
      'task-2': buildTask('task-2', 'agent-1'),
    });
    setStore('agents', { 'agent-1': buildAgent('agent-1', 'task-2') });
    resolveEnsure({
      results: [
        {
          agentId: 'agent-1',
          cols: 80,
          generation: 2,
          kind: 'restored',
          rows: 24,
          taskId: 'task-1',
        },
      ],
    });
    await flushMicrotasks();

    ensureAgentSessionForDeferredTerminal('task-2', 'agent-1');
    await flushMicrotasks();

    expect(getEnsureBatchCalls()).toHaveLength(2);
    expect(getEnsureBatchCalls()[1]?.[1]).toEqual({
      reason: 'startup-restore',
      requests: [{ agentId: 'agent-1', taskId: 'task-2' }],
    });
  });
});
