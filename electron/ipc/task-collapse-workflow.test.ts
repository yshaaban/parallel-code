import { describe, expect, it, vi } from 'vitest';
import { createTaskCollapseWorkflow } from './task-collapse-workflow.js';
import type { WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';
import type { JsonObject } from './workspace-state-storage.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function harness() {
  let sharedState: JsonObject = {
    tasks: {
      task: { id: 'task', agentId: 'agent', agentDef: { id: 'codex' } },
      peer: { id: 'peer', agentId: 'peer-agent' },
    },
    taskOrder: ['task', 'peer'],
    collapsedTaskOrder: [],
  };
  const privateAuthority: WorkspacePrivateMutationAuthority = {
    async mutate(_request, mutator) {
      const decision = mutator({
        sharedState,
        sharedRevision: 7,
        localState: {},
        privateState: {},
        payloadDigest: 'digest',
        storageGeneration: '1',
      });
      if (decision.kind === 'changed' && decision.nextSharedState)
        sharedState = decision.nextSharedState;
      return { changed: decision.kind === 'changed', result: decision.result, revision: 7 };
    },
  };
  const agentStop = vi.fn(async (_taskId: string, assertAdmitted?: () => void) => {
    assertAdmitted?.();
  });
  const shellStop = vi.fn(async (_taskId: string, assertAdmitted?: () => void) => {
    assertAdmitted?.();
  });
  const stopRemaining = vi.fn(async () => {});
  const cleanup = vi.fn(() => ({ releasedTaskCommandController: null }));
  const suspendSpawns = vi.fn(async () => {});
  const structure = { isTaskMutationAdmissionClosed: vi.fn(() => false) };
  const workflow = createTaskCollapseWorkflow({
    agentSession: { suspendTaskSessions: agentStop },
    shell: { suspendTaskSessions: shellStop },
    privateAuthority,
    structure,
    stopRemainingSessions: stopRemaining,
    cleanupRuntime: cleanup,
    suspendSpawns,
  });
  return {
    workflow,
    agentStop,
    shellStop,
    stopRemaining,
    cleanup,
    suspendSpawns,
    structure,
    read: () => sharedState,
  };
}

describe('canonical task visibility owner', () => {
  it('settles queued work before shutdown and permanently rejects new admission', async () => {
    const test = harness();
    const held = deferred();
    test.agentStop.mockImplementationOnce(async () => held.promise);
    const collapse = test.workflow.setCollapsed({ taskId: 'task', collapsed: true }, () => {});
    await vi.waitFor(() => expect(test.agentStop).toHaveBeenCalledOnce());
    const reopen = test.workflow.setCollapsed({ taskId: 'task', collapsed: false }, () => {});
    let drained = false;
    const drain = test.workflow.drain().then(() => {
      drained = true;
    });
    await expect(
      test.workflow.setCollapsed({ taskId: 'peer', collapsed: true }, () => {}),
    ).rejects.toThrow('shutting down');
    expect(drained).toBe(false);
    held.resolve();
    await Promise.all([collapse, reopen, drain]);
    expect(test.read().taskOrder).toEqual(['peer', 'task']);
    expect(test.read().collapsedTaskOrder).toEqual([]);
    expect((test.read().tasks as JsonObject).peer).toEqual({ id: 'peer', agentId: 'peer-agent' });
    expect(test.agentStop.mock.calls.every(([id]) => id === 'task')).toBe(true);
  });

  it('retains all independent stop failures and keeps reopen closed until retries settle', async () => {
    const test = harness();
    const agentFailure = new Error('agent stop');
    const shellFailure = new Error('shell stop');
    test.agentStop.mockRejectedValueOnce(agentFailure);
    test.shellStop.mockRejectedValueOnce(shellFailure);
    await expect(
      test.workflow.setCollapsed({ taskId: 'task', collapsed: true }, () => {}),
    ).rejects.toMatchObject({ failures: [agentFailure, shellFailure] });
    expect(test.stopRemaining).not.toHaveBeenCalled();
    expect((test.read().tasks as JsonObject).task).toMatchObject({ collapsed: true });
    const held = deferred();
    test.agentStop.mockImplementationOnce(async () => held.promise);
    const reopen = test.workflow.setCollapsed({ taskId: 'task', collapsed: false }, () => {});
    await vi.waitFor(() => expect(test.agentStop).toHaveBeenCalledTimes(2));
    expect((test.read().tasks as JsonObject).task).toMatchObject({ collapsed: true });
    held.resolve();
    await reopen;
    expect((test.read().tasks as JsonObject).task).not.toHaveProperty('collapsed');
    expect(test.suspendSpawns).toHaveBeenLastCalledWith('task', false);
  });

  it('revalidates lease and task closing after asynchronous preparation before stop effects', async () => {
    const test = harness();
    const held = deferred();
    test.suspendSpawns.mockImplementationOnce(async () => held.promise);
    const assertAdmitted = vi.fn(() => {});
    const collapse = test.workflow.setCollapsed(
      { taskId: 'task', collapsed: true },
      assertAdmitted,
    );
    await vi.waitFor(() => expect(test.suspendSpawns).toHaveBeenCalledOnce());
    assertAdmitted.mockImplementation(() => {
      throw new Error('lease expired');
    });
    held.resolve();
    await expect(collapse).rejects.toThrow('lease expired');
    expect(test.agentStop).not.toHaveBeenCalled();
    expect(test.shellStop).not.toHaveBeenCalled();
    expect(test.stopRemaining).not.toHaveBeenCalled();
    expect(test.cleanup).not.toHaveBeenCalled();
  });

  it.each(['agent', 'terminal'])(
    'leaves old erased %s identities collapsed with actionable recovery',
    async (taskMode) => {
      const test = harness();
      (test.read().tasks as JsonObject).task = {
        id: 'task',
        taskMode,
        collapsed: true,
        agentId: null,
        agentIds: [],
        shellAgentIds: [],
      };
      test.read().taskOrder = ['peer'];
      test.read().collapsedTaskOrder = ['task'];
      await expect(
        test.workflow.setCollapsed({ taskId: 'task', collapsed: false }, () => {}),
      ).rejects.toThrow('Restore a workspace backup');
      expect((test.read().tasks as JsonObject).task).toMatchObject({ collapsed: true });
      expect(test.agentStop).not.toHaveBeenCalled();
      expect(test.shellStop).not.toHaveBeenCalled();
    },
  );
});
