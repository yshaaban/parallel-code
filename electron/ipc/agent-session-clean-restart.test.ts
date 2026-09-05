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
    verifyCommittedRemoval: async () => true,
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
      stopAgent: async () => {
        events.push('stop');
        metadata = null;
      },
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
    events,
    journal,
    runtime,
    spawnAllocated,
  };
}

describe('managed agent clean restart', () => {
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
