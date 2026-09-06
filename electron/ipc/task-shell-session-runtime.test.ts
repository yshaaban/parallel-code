import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TaskCreationJournal, TaskCreationJournalRecord } from './task-creation-journal.js';
import type {
  TaskShellSessionJournal,
  TaskShellSessionJournalRecord,
} from './task-shell-session-journal.js';
import { createAgentSessionWriterRuntime } from './agent-session-writer-authority.js';
import { createTaskCatalogState } from './task-catalog-state.js';
import { createTaskCollapseWorkflow } from './task-collapse-workflow.js';
import { createProductionTaskShellSessionRuntime } from './task-shell-session-runtime.js';
import type { WorkspacePrivateMutationAuthority } from './workspace-state-mutations.js';
import type { JsonObject } from './workspace-state-storage.js';

const CREATION_OPERATION_ID = Buffer.alloc(16, 0x11).toString(
  'base64url',
) as TaskCreationJournalRecord['operationId'];
const OTHER_CREATION_OPERATION_ID = Buffer.alloc(16, 0x22).toString(
  'base64url',
) as TaskCreationJournalRecord['operationId'];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalTask(overrides: JsonObject = {}): JsonObject {
  return {
    baseBranch: 'main',
    branchName: 'task/task-1',
    gitIsolation: 'worktree',
    id: 'task-1',
    name: 'Terminal task',
    notes: '',
    projectId: 'project-1',
    shellAgentIds: ['session-1'],
    shellCount: 1,
    taskCreationOperationLink: {
      creationOperationId: CREATION_OPERATION_ID,
      kind: 'creation-v1',
      launchOperationId: 'launch-1',
    },
    taskInitialShellOwnership: {
      expectedGeneration: 0,
      kind: 'managed-terminal-v1',
      launchOperationId: 'launch-1',
      sessionId: 'session-1',
    },
    taskMode: 'terminal',
    worktreePath: '/workspace/task-1',
    ...overrides,
  };
}

function sharedState(task: JsonObject | null = canonicalTask()): JsonObject {
  return {
    collapsedTaskOrder: [],
    projects: [{ baseBranch: 'main', id: 'project-1', name: 'Project', path: '/workspace' }],
    taskOrder: task ? ['task-1'] : [],
    tasks: task ? { 'task-1': task } : {},
  };
}

function privateAuthority(
  readSharedState: () => JsonObject,
  readLocalState: () => JsonObject = () => ({}),
  writeSharedState?: (state: JsonObject) => void,
): WorkspacePrivateMutationAuthority {
  return {
    async mutate(request, mutator) {
      const decision = mutator({
        localState: readLocalState(),
        payloadDigest: digest('payload'),
        privateState: {},
        sharedRevision: 7,
        sharedState: readSharedState(),
        storageGeneration: 'generation-1',
      });
      if (decision.kind !== 'unchanged') {
        if (!writeSharedState || !decision.nextSharedState)
          throw new Error(`Unexpected write from ${request.operation}`);
        writeSharedState(decision.nextSharedState);
      }
      return { changed: false, result: decision.result, revision: 7 };
    },
  };
}

function memoryShellJournal(): TaskShellSessionJournal {
  const records = new Map<string, TaskShellSessionJournalRecord>();
  return {
    activateFresh: vi.fn(async () => ({ health: 'healthy' as const, topologyEpoch: 'topology-1' })),
    activateFromLegacy: vi.fn(async () => ({
      health: 'healthy' as const,
      topologyEpoch: 'topology-1',
    })),
    close: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ deletedTombstones: 0, markersWritten: 0 })),
    delete: vi.fn(async (operationId) => {
      records.delete(operationId);
      return { kind: 'deleted' } as const;
    }),
    flushDerivedIndex: vi.fn(async () => true),
    get: (operationId) => structuredClone(records.get(operationId) ?? null),
    getByTaskId: (taskId) =>
      structuredClone([...records.values()].find((record) => record.taskId === taskId) ?? null),
    getCounts: () => ({ active: 0, chargedBytes: 0, lifecycle: 0, records: 0, richAndReserved: 0 }),
    getHealth: () => 'healthy',
    getTopologyEpoch: () => 'topology-1',
    list: () => structuredClone([...records.values()]),
    repairDurability: vi.fn(async () => true),
    save: vi.fn(async (record, expectedVersion) => {
      const current = records.get(record.operationId);
      if ((current?.recordVersion ?? null) !== expectedVersion) {
        return { cause: new Error('version conflict'), kind: 'not-committed' } as const;
      }
      records.set(record.operationId, structuredClone(record));
      return { kind: 'committed' } as const;
    }),
    startup: vi.fn(async () => ({ health: 'healthy' as const, topologyEpoch: 'topology-1' })),
  };
}

function creationRecord(): TaskCreationJournalRecord {
  return {
    activeConflictKeys: [],
    capabilityHash: digest('capability'),
    commit: { kind: 'not-committed' },
    conflictKeys: [],
    createdAtMs: 1,
    formatVersion: 1,
    identities: {
      deliveryId: null,
      launchOperationId: 'launch-1',
      sessionId: 'session-1',
      taskId: 'task-1',
    },
    issueCode: null,
    operationId: CREATION_OPERATION_ID,
    phase: 'validating',
    reconciliation: { kind: 'none' },
    recordVersion: 1,
    retention: { kind: 'nonterminal' },
    semanticFingerprint: digest('semantic'),
    taskMode: 'terminal',
    updatedAtMs: 1,
    warning: { warningReservationBytes: 0 },
    workspacePrincipalHash: digest('principal'),
  };
}

function buildHarness(
  overrides: {
    journal?: TaskShellSessionJournal;
    localState?: JsonObject;
    task?: JsonObject | null;
    waitForInFlightInitialLaunch?: Parameters<
      typeof createProductionTaskShellSessionRuntime
    >[0]['waitForInFlightInitialLaunch'];
  } = {},
) {
  let currentSharedState = sharedState(
    overrides.task === undefined ? canonicalTask() : overrides.task,
  );
  const catalog = createTaskCatalogState({ serverInstanceId: 'server-1' });
  catalog.replace({
    sessionRuntime: [{ generation: 0, sessionId: 'session-1', state: 'not-started' }],
    sharedState: currentSharedState,
  });
  const metadata = new Map<
    string,
    {
      agentId: string;
      compatibilityCreatorClientId?: string;
      generation: number;
      isShell: boolean;
      taskId: string;
    }
  >();
  const generations = new Map<string, number>();
  const getAgentMetadata = vi.fn((agentId: string) => metadata.get(agentId) ?? null);
  const writer = createAgentSessionWriterRuntime({
    getCurrentGeneration: (agentId) => generations.get(agentId) ?? null,
  });
  writer.activate('cutover-1');
  const spawnAllocated = vi.fn(async (_context, request, permit) => {
    writer.assertSpawnPermit(permit, { agentId: request.agentId, taskId: request.taskId });
    generations.set(request.agentId, permit.targetGeneration);
    metadata.set(request.agentId, {
      agentId: request.agentId,
      generation: permit.targetGeneration,
      isShell: true,
      taskId: request.taskId,
    });
    return { channelAttached: false, kind: 'created-session' as const };
  });
  let removalCommitted = false;
  const verifyTaskIdentityForRemoval = vi.fn(async () => true);
  const shellJournal = overrides.journal ?? memoryShellJournal();
  const record = creationRecord();
  const workspace = privateAuthority(
    () => currentSharedState,
    () => overrides.localState ?? {},
    (state) => {
      currentSharedState = state;
    },
  );
  const runtime = createProductionTaskShellSessionRuntime({
    adapters: {
      closeAgent: vi.fn(async (agentId) => {
        metadata.delete(agentId);
      }),
      getAgentCols: () => 80,
      getAgentGeneration: (agentId) => generations.get(agentId) ?? null,
      getAgentMetadata,
      getAgentRows: () => 24,
      spawnAllocated,
    },
    catalog,
    context: {
      agentSessionWriter: writer,
      isPackaged: true,
      sendToChannel: vi.fn(),
      userDataPath: '/unused',
    },
    creationJournal: {
      getByOperationId: (operationId) =>
        operationId === record.operationId ? structuredClone(record) : null,
    } as TaskCreationJournal,
    journal: shellJournal,
    privateAuthority: workspace,
    waitForInFlightInitialLaunch: overrides.waitForInFlightInitialLaunch,
    removalGate: {
      getTaskSnapshot: () => ({
        current: catalog.getCurrentTaskProjection('task-1'),
        cutoverEpoch: 'cutover-1',
        hookSetVersion: 'task-runtime-removal-v1',
        kind: 'active',
      }),
      verifyCommittedRemoval: () => removalCommitted,
    },
    verifyTaskIdentityForRemoval,
  });
  return {
    catalog,
    record,
    getAgentMetadata,
    runtime,
    workspace,
    readSharedState: () => currentSharedState,
    setRemovalCommitted: () => {
      removalCommitted = true;
    },
    setSharedState: (state: JsonObject) => {
      currentSharedState = state;
    },
    stopSession: (sessionId: string) => {
      metadata.delete(sessionId);
    },
    setSession: (session: {
      agentId: string;
      compatibilityCreatorClientId?: string;
      generation: number;
      isShell: boolean;
      taskId: string;
    }) => {
      metadata.set(session.agentId, session);
      generations.set(session.agentId, session.generation);
    },
    shellJournal,
    spawnAllocated,
    verifyTaskIdentityForRemoval,
  };
}

describe('production task-shell-session runtime', () => {
  it('reattaches an admitted live browser scratch shell for its creator and authenticated observers', async () => {
    const harness = buildHarness({ task: null });
    const request = { sessionId: 'scratch-shell', taskId: 'scratch-panel' };
    const options = { clientId: 'browser-owner' };
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession(request, {
        ...options,
        compatibilityIntent: 'create',
      }),
    ).resolves.toMatchObject({ kind: 'unmanaged' });
    harness.setSession({
      agentId: request.sessionId,
      taskId: request.taskId,
      isShell: true,
      generation: 3,
      compatibilityCreatorClientId: options.clientId,
    });
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession(request, options),
    ).resolves.toMatchObject({ kind: 'existing', generation: 3, ...request });
    for (const compatibilityIntent of [undefined, 'create'] as const) {
      await expect(
        harness.runtime.restoreCanonicalTaskShellSession(request, {
          clientId: 'observer-client',
          ...(compatibilityIntent ? { compatibilityIntent } : {}),
        }),
      ).resolves.toMatchObject({ kind: 'existing', generation: 3, ...request });
    }
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession(
        { ...request, sessionId: 'foreign-shell' },
        options,
      ),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    await expect(harness.runtime.restoreCanonicalTaskShellSession(request)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    const original = harness.getAgentMetadata(request.sessionId);
    if (!original) throw new Error('Scratch fixture lost its live session');
    for (const changed of [
      { ...original, taskId: 'foreign-task' },
      { ...original, isShell: false },
      { ...original, compatibilityCreatorClientId: undefined },
    ]) {
      harness.setSession(changed);
      await expect(
        harness.runtime.restoreCanonicalTaskShellSession(request, {
          ...options,
          compatibilityIntent: 'create',
        }),
      ).resolves.toMatchObject({ kind: 'unavailable' });
    }
    harness.setSession(original);
    harness.getAgentMetadata.mockImplementationOnce(() => {
      harness.setSession({ ...original, generation: original.generation + 1 });
      return original;
    });
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession(request, options),
    ).resolves.toMatchObject({ kind: 'unavailable', reason: 'identity-unavailable' });
    harness.stopSession(request.sessionId);
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession(request, options),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(harness.spawnAllocated).not.toHaveBeenCalled();
  });

  it('does not use scratch provenance to bypass task removal or restrict shared task sidecars', async () => {
    const harness = buildHarness({
      task: canonicalTask({ taskMode: 'agent', agentIds: ['agent-1'], shellAgentIds: ['sidecar'] }),
    });
    const request = { sessionId: 'sidecar', taskId: 'task-1' };
    harness.setSession({
      agentId: request.sessionId,
      taskId: request.taskId,
      isShell: true,
      generation: 1,
      compatibilityCreatorClientId: 'first-client',
    });
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession(request, { clientId: 'second-client' }),
    ).resolves.toMatchObject({ kind: 'unmanaged' });
    harness.setSharedState(sharedState(null));
    harness.catalog.replace({ sharedState: sharedState(null) });
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession(request, {
        clientId: 'first-client',
        compatibilityIntent: 'create',
      }),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(harness.spawnAllocated).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'joins live initial creation before the shell queue and revalidates collapse (%s)',
    async (collapseWhileWaiting) => {
      let release!: () => void;
      let entered!: () => void;
      const enteredWait = new Promise<undefined>((resolve) => {
        entered = () => resolve(undefined);
      });
      const completedCreation = new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      });
      const waitForInFlightInitialLaunch = vi.fn(async () => {
        entered();
        await completedCreation;
      });
      const harness = buildHarness({ waitForInFlightInitialLaunch });
      const ids = harness.record.identities;
      await harness.runtime.workflow.reserveForTaskCommit({
        capabilityHash: harness.record.capabilityHash,
        creationOperationId: harness.record.operationId,
        expectedGeneration: 0,
        operationId: ids.launchOperationId,
        sessionId: ids.sessionId,
        taskId: ids.taskId,
        workspacePrincipalHash: harness.record.workspacePrincipalHash,
      });
      const restore = harness.runtime.restoreCanonicalTaskShellSession({
        sessionId: ids.sessionId,
        taskId: ids.taskId,
      });
      await enteredWait;
      expect(waitForInFlightInitialLaunch).toHaveBeenCalledWith({
        creationOperationId: harness.record.operationId,
        launchOperationId: ids.launchOperationId,
        sessionId: ids.sessionId,
        taskId: ids.taskId,
      });
      expect(harness.spawnAllocated).not.toHaveBeenCalled();
      // The live creator can enter both shell operations while restore is waiting.
      await harness.runtime.workflow.admitAfterTaskCommit({
        committedWorkspaceRevision: 7,
        creationOperationId: harness.record.operationId,
        operationId: ids.launchOperationId,
        taskId: ids.taskId,
      });
      await harness.runtime.workflow.start({
        creationOperationId: harness.record.operationId,
        operationId: ids.launchOperationId,
        taskId: ids.taskId,
      });
      if (collapseWhileWaiting)
        harness.setSharedState(sharedState(canonicalTask({ collapsed: true })));
      release();
      await expect(restore).resolves.toMatchObject(
        collapseWhileWaiting
          ? { kind: 'unavailable', reason: 'task-unavailable' }
          : { kind: 'existing', generation: 0, sessionId: ids.sessionId, taskId: ids.taskId },
      );
      expect(harness.spawnAllocated).toHaveBeenCalledTimes(1);
    },
  );

  it('does not start an initial managed shell while its canonical task is collapsed', async () => {
    const harness = buildHarness({ task: canonicalTask({ collapsed: true }) });
    await harness.runtime.workflow.reserveForTaskCommit({
      capabilityHash: harness.record.capabilityHash,
      creationOperationId: harness.record.operationId,
      expectedGeneration: 0,
      operationId: harness.record.identities.launchOperationId,
      sessionId: harness.record.identities.sessionId,
      taskId: harness.record.identities.taskId,
      workspacePrincipalHash: harness.record.workspacePrincipalHash,
    });
    await harness.runtime.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 7,
      creationOperationId: harness.record.operationId,
      operationId: harness.record.identities.launchOperationId,
      taskId: harness.record.identities.taskId,
    });
    const result = await harness.runtime.workflow.start({
      creationOperationId: harness.record.operationId,
      operationId: harness.record.identities.launchOperationId,
      taskId: harness.record.identities.taskId,
    });
    expect(result).toMatchObject({ phase: 'admitted' });
    expect(harness.spawnAllocated).not.toHaveBeenCalled();
    expect(harness.runtime.workflow.isTaskSpawnQuarantined('task-1')).toBe(false);
    const owner = createTaskCollapseWorkflow({
      agentSession: { suspendTaskSessions: async () => {} },
      shell: harness.runtime,
      privateAuthority: harness.workspace,
      structure: { isTaskMutationAdmissionClosed: () => false },
      stopRemainingSessions: async () => {},
      cleanupRuntime: () => ({ releasedTaskCommandController: null }),
    });
    await owner.setCollapsed({ taskId: 'task-1', collapsed: false }, () => {});
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession({
        taskId: 'task-1',
        sessionId: 'session-1',
      }),
    ).resolves.toMatchObject({ kind: 'restored', generation: 0, sessionId: 'session-1' });
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession({
        taskId: 'task-1',
        sessionId: 'session-1',
      }),
    ).resolves.toMatchObject({ kind: 'existing', generation: 0 });
    expect(harness.spawnAllocated).toHaveBeenCalledOnce();
  });

  it('reopens a managed terminal repeatedly without changing initial shell ownership or allowing invented identities', async () => {
    const harness = buildHarness();
    await harness.runtime.workflow.reserveForTaskCommit({
      capabilityHash: harness.record.capabilityHash,
      creationOperationId: harness.record.operationId,
      expectedGeneration: 0,
      operationId: harness.record.identities.launchOperationId,
      sessionId: harness.record.identities.sessionId,
      taskId: harness.record.identities.taskId,
      workspacePrincipalHash: harness.record.workspacePrincipalHash,
    });
    await harness.runtime.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 7,
      creationOperationId: harness.record.operationId,
      operationId: harness.record.identities.launchOperationId,
      taskId: harness.record.identities.taskId,
    });
    await harness.runtime.workflow.start({
      creationOperationId: harness.record.operationId,
      operationId: harness.record.identities.launchOperationId,
      taskId: harness.record.identities.taskId,
    });
    const owner = createTaskCollapseWorkflow({
      agentSession: { suspendTaskSessions: async () => {} },
      shell: harness.runtime,
      privateAuthority: harness.workspace,
      structure: { isTaskMutationAdmissionClosed: () => false },
      stopRemainingSessions: async () => {},
      cleanupRuntime: () => ({ releasedTaskCommandController: null }),
    });
    const request = { taskId: 'task-1', sessionId: 'session-1' };
    for (const generation of [1, 2, 3]) {
      await owner.setCollapsed({ taskId: 'task-1', collapsed: true }, () => {});
      await expect(
        harness.runtime.restoreCanonicalTaskShellSession(request),
      ).resolves.toMatchObject({ kind: 'unavailable' });
      await owner.setCollapsed({ taskId: 'task-1', collapsed: false }, () => {});
      if (generation === 2) {
        harness.spawnAllocated.mockImplementationOnce(async () => {
          harness.setSharedState(sharedState(canonicalTask({ collapsed: true })));
          throw new Error('Collapsed while preparing the process');
        });
        await expect(
          harness.runtime.restoreCanonicalTaskShellSession(request),
        ).resolves.toMatchObject({ kind: 'unavailable' });
        expect(harness.shellJournal.get('launch-1')).toMatchObject({
          phase: 'clean-restart-pending',
        });
        expect(harness.runtime.workflow.isTaskSpawnQuarantined('task-1')).toBe(false);
        await owner.setCollapsed({ taskId: 'task-1', collapsed: false }, () => {});
      }
      await expect(
        harness.runtime.restoreCanonicalTaskShellSession(request),
      ).resolves.toMatchObject({ kind: 'restored', generation });
      await expect(
        harness.runtime.restoreCanonicalTaskShellSession(request),
      ).resolves.toMatchObject({ kind: 'existing', generation });
      expect((harness.readSharedState().tasks as JsonObject)['task-1']).toMatchObject({
        shellAgentIds: ['session-1'],
        taskInitialShellOwnership: { expectedGeneration: 0, sessionId: 'session-1' },
      });
    }
    expect(harness.spawnAllocated).toHaveBeenCalledTimes(5);
    await expect(
      harness.runtime.restoreCanonicalTaskShellSession({
        taskId: 'task-1',
        sessionId: 'invented-session',
      }),
    ).resolves.toMatchObject({ kind: 'unavailable' });
  });

  it('reserves from the exact creation record and spawns one admitted shell tuple', async () => {
    const harness = buildHarness();
    await harness.runtime.workflow.reserveForTaskCommit({
      capabilityHash: harness.record.capabilityHash,
      creationOperationId: harness.record.operationId,
      expectedGeneration: 0,
      operationId: harness.record.identities.launchOperationId,
      sessionId: harness.record.identities.sessionId,
      taskId: harness.record.identities.taskId,
      workspacePrincipalHash: harness.record.workspacePrincipalHash,
    });
    await harness.runtime.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 7,
      creationOperationId: harness.record.operationId,
      operationId: harness.record.identities.launchOperationId,
      taskId: harness.record.identities.taskId,
    });
    const replay = await harness.runtime.workflow.start({
      creationOperationId: harness.record.operationId,
      operationId: harness.record.identities.launchOperationId,
      taskId: harness.record.identities.taskId,
    });

    expect(replay).toEqual(
      expect.objectContaining({
        disposition: { kind: 'attempted-no-replay', reason: 'running-at-ack' },
        phase: 'running',
      }),
    );
    expect(harness.spawnAllocated).toHaveBeenCalledOnce();
    expect(harness.spawnAllocated.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        agentId: 'session-1',
        args: [],
        command: '',
        cwd: '/workspace/task-1',
        isShell: true,
        startsTaskWatchers: true,
        taskId: 'task-1',
      }),
    );
    await expect(
      harness.runtime.authority.inspectExactTuple({
        ...replay.identity,
        admissionKind: 'initial',
        initialExpectedGeneration: replay.identity.expectedGeneration,
        launchOperationId: replay.identity.operationId,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: 'running' }));
  });

  it('fails closed before PTY allocation when the canonical operation mapping changes', async () => {
    const harness = buildHarness({
      task: canonicalTask({
        taskCreationOperationLink: {
          creationOperationId: OTHER_CREATION_OPERATION_ID,
          kind: 'creation-v1',
          launchOperationId: 'launch-1',
        },
      }),
    });
    const result = await harness.runtime.authority.spawnExactTuple({
      admissionKind: 'initial',
      committedWorkspaceRevision: 7,
      creationOperationId: CREATION_OPERATION_ID,
      expectedGeneration: 0,
      initialExpectedGeneration: 0,
      launchOperationId: 'launch-1',
      operationId: 'launch-1',
      sessionId: 'session-1',
      taskId: 'task-1',
    });

    expect(result).toEqual({ kind: 'ambiguous', supervisorIdentityHash: null });
    expect(harness.spawnAllocated).not.toHaveBeenCalled();
  });

  it('joins fresh catalog task/session state without exposing canonical paths', async () => {
    const harness = buildHarness();
    const creation = await harness.runtime.readCreationCurrent('task-1', 'terminal');
    const shell = await harness.runtime.readShellCurrent({
      committedWorkspaceRevision: 7,
      creationOperationId: CREATION_OPERATION_ID,
      expectedGeneration: 0,
      operationId: 'launch-1',
      sessionId: 'session-1',
      taskId: 'task-1',
    });

    expect(creation).toEqual(
      expect.objectContaining({ task: expect.objectContaining({ taskMode: 'terminal' }) }),
    );
    expect(shell).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ sessionId: 'session-1', state: 'not-found' }),
        task: expect.objectContaining({ taskMode: 'terminal' }),
        workspaceRevision: 7,
      }),
    );
    expect(JSON.stringify({ creation, shell })).not.toContain('/workspace/task-1');
  });

  it('restores a durable clean-restart permit in a new runtime with no process-local generation', async () => {
    const first = buildHarness();
    await first.runtime.workflow.reserveForTaskCommit({
      capabilityHash: first.record.capabilityHash,
      creationOperationId: first.record.operationId,
      expectedGeneration: 0,
      operationId: first.record.identities.launchOperationId,
      sessionId: first.record.identities.sessionId,
      taskId: first.record.identities.taskId,
      workspacePrincipalHash: first.record.workspacePrincipalHash,
    });
    await first.runtime.workflow.admitAfterTaskCommit({
      committedWorkspaceRevision: 7,
      creationOperationId: first.record.operationId,
      operationId: first.record.identities.launchOperationId,
      taskId: first.record.identities.taskId,
    });
    await first.runtime.workflow.start({
      creationOperationId: first.record.operationId,
      operationId: first.record.identities.launchOperationId,
      taskId: first.record.identities.taskId,
    });
    const [candidate] = await first.runtime.beginCleanRestartDrain();
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('Expected a clean-restart candidate');
    first.stopSession('session-1');
    await expect(first.runtime.persistCleanRestartPermit(candidate)).resolves.toMatchObject({
      kind: 'prepared',
      targetGeneration: 1,
    });

    const restarted = buildHarness({ journal: first.shellJournal });
    await expect(
      restarted.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'session-1',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      cols: 80,
      generation: 1,
      kind: 'restored',
      rows: 24,
      sessionId: 'session-1',
      taskId: 'task-1',
    });
    expect(restarted.spawnAllocated).toHaveBeenCalledOnce();
    expect(restarted.spawnAllocated.mock.calls[0]?.[2]).toMatchObject({ targetGeneration: 1 });
  });

  it('classifies every canonical shell identity without managed-to-compatibility downgrade', async () => {
    const legacy = buildHarness({
      task: canonicalTask({
        taskCreationOperationLink: { kind: 'pre-operation-journal' },
        taskInitialShellOwnership: {
          kind: 'legacy-unmanaged-terminal',
          migrationSchemaVersion: 1,
        },
      }),
    });
    await expect(
      legacy.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'session-1',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({
      kind: 'unmanaged',
      reason: 'legacy-unmanaged',
      sessionId: 'session-1',
      taskId: 'task-1',
    });

    const terminalExtra = buildHarness({
      task: canonicalTask({ shellAgentIds: ['session-1', 'shell-extra'] }),
    });
    await expect(
      terminalExtra.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'shell-extra',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'unmanaged', reason: 'compatibility-shell' });

    const terminalShellBeforePersistence = buildHarness();
    await expect(
      terminalShellBeforePersistence.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'fresh-shell-before-save',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'identity-unavailable' });
    await expect(
      terminalShellBeforePersistence.runtime.restoreCanonicalTaskShellSession(
        {
          sessionId: 'fresh-shell-before-save',
          taskId: 'task-1',
        },
        { compatibilityIntent: 'create' },
      ),
    ).resolves.toMatchObject({ kind: 'unmanaged', reason: 'compatibility-shell' });

    const agentTask = buildHarness({
      task: canonicalTask({
        agentId: 'agent-1',
        agentIds: ['agent-1'],
        shellAgentIds: ['shell-extra'],
        taskInitialShellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
        taskMode: 'agent',
      }),
    });
    await expect(
      agentTask.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'shell-extra',
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'unmanaged', reason: 'compatibility-shell' });
    await expect(
      agentTask.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'fresh-shell-before-save',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'identity-unavailable' });
    await expect(
      agentTask.runtime.restoreCanonicalTaskShellSession(
        {
          sessionId: 'fresh-shell-before-save',
          taskId: 'task-1',
        },
        { compatibilityIntent: 'create' },
      ),
    ).resolves.toMatchObject({ kind: 'unmanaged', reason: 'compatibility-shell' });
    await expect(
      agentTask.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'agent-1',
        taskId: 'task-1',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'identity-unavailable' });

    const standalone = buildHarness({
      localState: {
        terminals: {
          'terminal-panel': {
            agentId: 'standalone-shell',
            id: 'terminal-panel',
            name: 'Standalone',
          },
        },
      },
      task: null,
    });
    await expect(
      standalone.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'standalone-shell',
        taskId: 'terminal-panel',
      }),
    ).resolves.toMatchObject({ kind: 'unmanaged', reason: 'compatibility-shell' });
    await expect(
      standalone.runtime.restoreCanonicalTaskShellSession({
        sessionId: 'stale-shell',
        taskId: 'deleted-task',
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'task-unavailable' });

    const standaloneBeforePersistence = buildHarness({ task: null });
    await expect(
      standaloneBeforePersistence.runtime.restoreCanonicalTaskShellSession(
        {
          sessionId: 'fresh-standalone-shell',
          taskId: 'fresh-terminal-panel',
        },
        { compatibilityIntent: 'create' },
      ),
    ).resolves.toMatchObject({ kind: 'unmanaged', reason: 'compatibility-shell' });

    const removed = buildHarness();
    removed.setSharedState(sharedState(null));
    removed.catalog.replace({ sharedState: sharedState(null) });
    await expect(
      removed.runtime.restoreCanonicalTaskShellSession(
        { sessionId: 'stale-shell', taskId: 'task-1' },
        { compatibilityIntent: 'create' },
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'task-unavailable' });
  });
});
