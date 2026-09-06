import { describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import type { AgentDef } from '../../src/ipc/types.js';
import {
  createMemoryAgentSessionOperationJournal,
  type AgentSessionIdentityMarker,
} from './agent-session-operation-journal.js';
import { createProductionAgentSessionRuntime } from './agent-session-runtime.js';
import { createAgentSessionWriterRuntime } from './agent-session-writer-authority.js';
import type { HandlerContext } from './handler-context.js';
import { createTaskCollapseWorkflow } from './task-collapse-workflow.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import type { WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';
import type { JsonObject } from './workspace-state-storage.js';

const TASK_ID = 'task-1';
const AGENT_ID = 'agent-1';
const CUTOVER_EPOCH = 'cutover-1';
const AGENT_DEF: AgentDef = {
  args: [],
  command: 'codex',
  description: 'Codex',
  id: 'codex',
  name: 'Codex',
  resume_args: ['resume'],
  skip_permissions_args: [],
};

function cleanMarker(sourceGeneration: number): AgentSessionIdentityMarker {
  return {
    agentId: AGENT_ID,
    cleanRestart: {
      agentDefId: AGENT_DEF.id,
      cols: 100,
      generationHighWater: sourceGeneration,
      phase: 'available',
      rows: 30,
      sourceGeneration,
      targetGeneration: sourceGeneration + 1,
    },
    taskId: TASK_ID,
  };
}

function createHarness(options: { initialGeneration?: number; preOperation?: boolean }) {
  let metadata =
    options.initialGeneration === undefined
      ? null
      : {
          agentId: AGENT_ID,
          generation: options.initialGeneration,
          isShell: false,
          taskId: TASK_ID,
        };
  let lastGeneration = options.initialGeneration ?? null;
  const task: JsonObject = {
    agentDef: structuredClone(AGENT_DEF) as unknown as JsonObject,
    agentId: AGENT_ID,
    id: TASK_ID,
    projectId: 'project-1',
    taskCreationOperationLink: options.preOperation
      ? { kind: 'pre-operation-journal', migrationSchemaVersion: 1 }
      : {
          creationOperationId: 'creation-1',
          kind: 'creation-v1',
          launchOperationId: 'launch-1',
        },
    taskMode: 'agent',
    worktreePath: '/tmp/task-1',
  };
  const sharedState: JsonObject = {
    collapsedTaskOrder: [],
    taskOrder: [TASK_ID],
    projects: [{ id: 'project-1' }],
    tasks: { [TASK_ID]: task },
  };
  const privateAuthority = {
    async mutate(_request, mutator) {
      const decision = mutator({
        localState: {},
        payloadDigest: 'digest',
        privateState: {},
        sharedRevision: 7,
        sharedState,
        storageGeneration: '1',
      });
      if (decision.kind === 'changed' && decision.nextSharedState)
        Object.assign(sharedState, decision.nextSharedState);
      return { changed: decision.kind === 'changed', result: decision.result, revision: 7 };
    },
  } satisfies WorkspacePrivateMutationAuthority;
  const current = {
    catalogVersion: 1,
    serverInstanceId: 'server-1',
    taskClosing: false,
    taskState: 'present' as const,
  };
  const gate = {
    getTaskSnapshot: () => ({
      current,
      cutoverEpoch: CUTOVER_EPOCH,
      hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
      kind: 'active' as const,
    }),
    verifyCommittedRemoval: vi.fn(async () => true),
  };
  const structure = {
    createTaskRemovalParticipantGate: () => gate,
    getTaskRemovalOwnerCapability: () => ({
      cutoverEpoch: CUTOVER_EPOCH,
      hookSetVersions: {
        'agent-session': AGENT_SESSION_OWNER_HOOK_SET_VERSION,
        'initial-prompt': 'task-initial-prompt-hooks-v1',
        'task-runtime': 'task-runtime-removal-v1',
      },
      kind: 'active' as const,
      schemaVersion: 1 as const,
    }),
    isTaskMutationAdmissionClosed: () => false,
  } as unknown as TaskStructureMutationService;
  const journal = createMemoryAgentSessionOperationJournal();
  const writer = createAgentSessionWriterRuntime({
    getCurrentGeneration: () => (metadata ? metadata.generation : lastGeneration),
  });
  writer.activate(CUTOVER_EPOCH);
  const events: string[] = [];
  const spawnAllocated = vi.fn(async (_context, request, permit) => {
    request.assertSpawnAdmitted?.();
    metadata = {
      agentId: request.agentId,
      generation: permit.targetGeneration,
      isShell: false,
      taskId: request.taskId,
    };
    lastGeneration = permit.targetGeneration;
    return { channelAttached: false, kind: 'created-session' as const };
  });
  const stopAgent = vi.fn(async () => {
    events.push('stop');
    metadata = null;
  });
  const runtime = createProductionAgentSessionRuntime({
    adapters: {
      getActiveAgentIds: () => (metadata ? [AGENT_ID] : []),
      getAgentCols: () => 100,
      getAgentLifecycleGeneration: () => (metadata ? metadata.generation : lastGeneration),
      getAgentMeta: () => metadata,
      getAgentRows: () => 30,
      hasAgentSession: () => metadata !== null,
      onPtyEvent: () => () => {},
      spawnAllocated,
      stopAgent,
      stopTask: async () => {},
    },
    context: {
      agentSessionWriter: writer,
      isPackaged: true,
      sendToChannel: vi.fn(),
      userDataPath: '/unused',
    } satisfies HandlerContext,
    journal,
    privateAuthority,
    structure,
    writer,
  });
  const originalSaveIdentityMarkers = journal.saveIdentityMarkers.bind(journal);
  vi.spyOn(journal, 'saveIdentityMarkers').mockImplementation(async (markers) => {
    events.push('persist');
    await originalSaveIdentityMarkers(markers);
  });

  return {
    clearProcessState() {
      metadata = null;
      lastGeneration = null;
    },
    changeProcessGeneration(generation: number) {
      if (metadata) metadata.generation = generation;
      lastGeneration = generation;
    },
    events,
    journal,
    privateAuthority,
    runtime,
    sharedState,
    spawnAllocated,
    stopAgent,
    structure,
    verifyCommittedRemoval: gate.verifyCommittedRemoval,
  };
}

describe('managed agent clean restart', () => {
  it('retires retained and prepared shutdown proofs only after verified task removal completes', async () => {
    const harness = createHarness({ initialGeneration: 2 });
    await harness.runtime.startup();
    vi.mocked(harness.journal.saveIdentityMarkers).mockRejectedValueOnce(
      new Error('disk unavailable'),
    );
    await expect(harness.runtime.suspendTaskSessions(TASK_ID)).rejects.toThrow('disk unavailable');
    await harness.runtime.prepareCleanShutdown();
    harness.sharedState.tasks = {};
    harness.sharedState.taskOrder = [];
    await expect(
      harness.runtime.workflow.removalHooks.finalizeRemovedTaskAgentSessionState({
        deletionOperationId: 'delete-1',
        taskId: TASK_ID,
      }),
    ).resolves.toMatchObject({ kind: 'already-complete' });
    await expect(harness.runtime.close()).resolves.toBeUndefined();
    expect(harness.journal.getIdentityMarker(TASK_ID, AGENT_ID)).toBeNull();
    expect(harness.journal.saveIdentityMarkers).toHaveBeenLastCalledWith([]);
  });

  it.each(['witness', 'journal'])(
    'retains exact stop proof after failed %s removal finalization',
    async (failure) => {
      const harness = createHarness({ initialGeneration: 2 });
      await harness.runtime.startup();
      vi.mocked(harness.journal.saveIdentityMarkers).mockRejectedValueOnce(
        new Error('disk unavailable'),
      );
      await expect(harness.runtime.suspendTaskSessions(TASK_ID)).rejects.toThrow(
        'disk unavailable',
      );
      if (failure === 'witness') harness.verifyCommittedRemoval.mockResolvedValueOnce(false);
      else
        vi.spyOn(harness.journal, 'deleteTaskRecords').mockRejectedValueOnce(
          new Error('delete failed'),
        );
      await expect(
        harness.runtime.workflow.removalHooks.finalizeRemovedTaskAgentSessionState({
          deletionOperationId: 'delete-1',
          taskId: TASK_ID,
        }),
      ).resolves.toMatchObject({ kind: 'retry-required' });
      await harness.runtime.close();
      expect(harness.journal.getIdentityMarker(TASK_ID, AGENT_ID)).toMatchObject({
        cleanRestart: { phase: 'available', sourceGeneration: 2, targetGeneration: 3 },
      });
    },
  );

  it('finishes retained failed-collapse proof at clean host shutdown and reopens on a new runtime', async () => {
    const harness = createHarness({ initialGeneration: 2 });
    const owner = createTaskCollapseWorkflow({
      agentSession: harness.runtime,
      shell: { suspendTaskSessions: async () => {} },
      privateAuthority: harness.privateAuthority,
      structure: harness.structure,
      stopRemainingSessions: async () => {},
      cleanupRuntime: () => ({ releasedTaskCommandController: null }),
    });
    await harness.runtime.startup();
    vi.mocked(harness.journal.saveIdentityMarkers).mockRejectedValueOnce(
      new Error('disk unavailable'),
    );
    await expect(
      owner.setCollapsed({ taskId: TASK_ID, collapsed: true }, () => {}),
    ).rejects.toThrow('suspension');
    expect(harness.stopAgent).toHaveBeenCalledOnce();
    await owner.drain();
    await harness.runtime.close();
    const persisted = harness.journal.getIdentityMarker(TASK_ID, AGENT_ID);
    expect(persisted).toMatchObject({
      cleanRestart: { phase: 'available', sourceGeneration: 2, targetGeneration: 3 },
    });
    if (!persisted) throw new Error('Expected the retained clean-stop proof to be persisted');
    const restarted = createHarness({});
    Object.assign(restarted.sharedState, structuredClone(harness.sharedState));
    await restarted.journal.saveIdentityMarkers([persisted]);
    await restarted.runtime.startup();
    await expect(
      restarted.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    const reopenedOwner = createTaskCollapseWorkflow({
      agentSession: restarted.runtime,
      shell: { suspendTaskSessions: async () => {} },
      privateAuthority: restarted.privateAuthority,
      structure: restarted.structure,
      stopRemainingSessions: async () => {},
      cleanupRuntime: () => ({ releasedTaskCommandController: null }),
    });
    await reopenedOwner.setCollapsed({ taskId: TASK_ID, collapsed: false }, () => {});
    await expect(
      restarted.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ kind: 'restored', generation: 3 });
    await expect(
      restarted.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ kind: 'existing', generation: 3 });
    expect(restarted.spawnAllocated).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'deduplicates retained live proof but rejects changed generation (changed=%s)',
    async (changed) => {
      const harness = createHarness({ initialGeneration: 2 });
      await harness.runtime.startup();
      harness.stopAgent.mockRejectedValueOnce(new Error('stop failed'));
      await expect(harness.runtime.suspendTaskSessions(TASK_ID)).rejects.toThrow('stop failed');
      if (changed) {
        harness.changeProcessGeneration(3);
        await expect(harness.runtime.close()).rejects.toThrow('retained clean-stop proof');
        expect(harness.journal.saveIdentityMarkers).not.toHaveBeenCalled();
      } else {
        await harness.runtime.close();
        expect(harness.journal.saveIdentityMarkers).toHaveBeenCalledExactlyOnceWith([
          expect.objectContaining({
            agentId: AGENT_ID,
            cleanRestart: expect.objectContaining({ sourceGeneration: 2, targetGeneration: 3 }),
          }),
        ]);
      }
    },
  );

  it('collapses and reopens repeatedly with canonical identity and an exact clean-stop permit', async () => {
    const harness = createHarness({ initialGeneration: 3 });
    const owner = createTaskCollapseWorkflow({
      agentSession: harness.runtime,
      shell: { suspendTaskSessions: async () => {} },
      privateAuthority: harness.privateAuthority,
      structure: harness.structure,
      stopRemainingSessions: async () => {},
      cleanupRuntime: () => ({ releasedTaskCommandController: null }),
    });
    await harness.runtime.startup();
    for (const generation of [4, 5, 6]) {
      await owner.setCollapsed({ taskId: TASK_ID, collapsed: true }, () => {});
      expect(harness.sharedState.taskOrder).toEqual([]);
      expect(harness.sharedState.collapsedTaskOrder).toEqual([TASK_ID]);
      await expect(
        harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
      ).resolves.toMatchObject({ kind: 'unavailable' });
      // Reload/reattach cannot invent a renderer-only identity.
      expect((harness.sharedState.tasks as JsonObject)[TASK_ID]).toMatchObject({
        agentId: AGENT_ID,
        collapsed: true,
      });
      await owner.setCollapsed({ taskId: TASK_ID, collapsed: false }, () => {});
      await expect(
        harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
      ).resolves.toMatchObject({ kind: 'restored', generation });
      await expect(
        harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
      ).resolves.toMatchObject({ kind: 'existing', generation });
    }
    expect(harness.spawnAllocated).toHaveBeenCalledTimes(3);
    expect(harness.sharedState.taskOrder).toEqual([TASK_ID]);
    expect(harness.sharedState.collapsedTaskOrder).toEqual([]);
  });

  it('reopen retries a failed permit write before clearing collapsed admission, including after a host restart', async () => {
    const harness = createHarness({ initialGeneration: 2 });
    const owner = createTaskCollapseWorkflow({
      agentSession: harness.runtime,
      shell: { suspendTaskSessions: async () => {} },
      privateAuthority: harness.privateAuthority,
      structure: harness.structure,
      stopRemainingSessions: async () => {},
      cleanupRuntime: () => ({ releasedTaskCommandController: null }),
    });
    await harness.runtime.startup();
    vi.mocked(harness.journal.saveIdentityMarkers).mockRejectedValueOnce(
      new Error('disk unavailable'),
    );
    await expect(
      owner.setCollapsed({ taskId: TASK_ID, collapsed: true }, () => {}),
    ).rejects.toThrow('suspension');
    expect((harness.sharedState.tasks as JsonObject)[TASK_ID]).toMatchObject({ collapsed: true });
    await owner.setCollapsed({ taskId: TASK_ID, collapsed: false }, () => {});
    expect(harness.stopAgent).toHaveBeenCalledOnce();
    harness.clearProcessState();
    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ kind: 'restored', generation: 3 });
    harness.clearProcessState();
    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ kind: 'unavailable' });
  });
  it('restores one exact next generation and never reuses an ambiguous or consumed permit', async () => {
    const harness = createHarness({});
    await harness.journal.saveIdentityMarkers([cleanMarker(3)]);
    harness.events.length = 0;
    await harness.runtime.startup();

    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ generation: 4, kind: 'restored' });
    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ generation: 4, kind: 'existing' });
    expect(harness.spawnAllocated).toHaveBeenCalledOnce();
    expect(harness.journal.getIdentityMarker(TASK_ID, AGENT_ID)?.cleanRestart).toMatchObject({
      generationHighWater: 4,
      phase: 'restored',
      targetGeneration: 4,
    });

    await harness.runtime.close();
    expect(harness.events.slice(-2)).toEqual(['stop', 'persist']);
    expect(harness.journal.getIdentityMarker(TASK_ID, AGENT_ID)?.cleanRestart).toMatchObject({
      generationHighWater: 4,
      phase: 'available',
      sourceGeneration: 4,
      targetGeneration: 5,
    });
  });

  it('admits a pre-operation task once from canonical state and closes later absence', async () => {
    const harness = createHarness({ preOperation: true });
    await harness.runtime.startup();

    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ generation: 0, kind: 'restored' });
    expect(harness.spawnAllocated.mock.calls[0]?.[1]).toMatchObject({
      agentSessionLaunchReason: 'initial',
      agentSessionResumed: false,
    });
    expect(harness.journal.getIdentityMarker(TASK_ID, AGENT_ID)?.initialLaunch).toMatchObject({
      agentDefId: AGENT_DEF.id,
      lastKnownPhase: 'running',
      targetGeneration: 0,
    });

    harness.clearProcessState();
    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'restore-failed' });
    expect(harness.spawnAllocated).toHaveBeenCalledOnce();
  });

  it('replays only a legacy admission that crashed before the durable spawning phase', async () => {
    const harness = createHarness({ preOperation: true });
    await harness.runtime.startup();
    const saveOperation = harness.journal.saveOperation.bind(harness.journal);
    let failBeforeSpawning = true;
    vi.spyOn(harness.journal, 'saveOperation').mockImplementation(async (record, options) => {
      if (record.snapshot.phase === 'spawning' && failBeforeSpawning) {
        failBeforeSpawning = false;
        throw new Error('pre-effect crash');
      }
      await saveOperation(record, options);
    });

    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'restore-failed' });
    expect(harness.journal.getIdentityMarker(TASK_ID, AGENT_ID)?.initialLaunch).toMatchObject({
      lastKnownPhase: 'admitted',
    });
    expect(harness.spawnAllocated).not.toHaveBeenCalled();

    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ generation: 0, kind: 'restored' });
    expect(harness.spawnAllocated).toHaveBeenCalledOnce();
  });

  it('does not replay a legacy admission after the durable spawning phase was attempted', async () => {
    const harness = createHarness({ preOperation: true });
    harness.spawnAllocated.mockRejectedValueOnce(new Error('spawn acknowledgement lost'));
    await harness.runtime.startup();

    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'restore-failed' });
    expect(harness.journal.getIdentityMarker(TASK_ID, AGENT_ID)?.initialLaunch).toMatchObject({
      lastKnownPhase: 'failed',
      terminalPhase: 'failed',
    });

    await expect(
      harness.runtime.restoreCanonicalSession({ agentId: AGENT_ID, taskId: TASK_ID }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'restore-failed' });
    expect(harness.spawnAllocated).toHaveBeenCalledOnce();
  });
});
