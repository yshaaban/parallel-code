import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import { TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION } from '../../src/domain/task-removal-owner.js';
import { deriveTaskNotesIncarnation } from './task-notes-operations.js';
import {
  createTaskNotesPrincipalContext,
  TaskNotesService,
  type TaskNotesStructuralAuthority,
} from './task-notes-service.js';
import type {
  TaskRemovalOwnerParticipant,
  TaskRemovalParticipantStepResult,
} from './task-removal-owner.js';
import {
  TaskStructureConflictError,
  TaskStructureMutationService,
} from './task-structure-mutations.js';
import type { StorageEnv } from './storage.js';
import {
  WorkspaceMutationService,
  WorkspaceProtectedFieldConflictError,
  changed,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import {
  cloneJsonObject,
  createStandaloneWorkspaceStateStorage,
  type JsonObject,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

const SERVER_INSTANCE_1 = '00000000-0000-4000-8000-000000000001';
const SERVER_INSTANCE_2 = '00000000-0000-4000-8000-000000000002';

let root = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;
let structure: TaskStructureMutationService;
let nextDeletionOperation = 1;
let nextWitnessByte = 1;

function env(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

function nextWitness(): string {
  const witness = Buffer.alloc(32, nextWitnessByte).toString('base64url');
  nextWitnessByte += 1;
  return witness;
}

function structureOptions(
  serverInstanceId = SERVER_INSTANCE_1,
  privateAuthority?: WorkspacePrivateMutationAuthority,
) {
  return {
    ...(privateAuthority ? { privateAuthority } : {}),
    removalOwner: {
      createCutoverEpoch: () => 'removal-cutover-epoch-1',
      createDeletionOperationId: () => `deletion-operation-${nextDeletionOperation++}`,
      serverInstanceId,
      taskNotes: {
        createCutoverEpoch: () => 'task-notes-cutover-epoch-1',
        createTaskIdentityWitness: nextWitness,
      },
    },
  };
}

function createParticipant(
  id: 'agent-session' | 'initial-prompt' | 'task-runtime',
  options: {
    drain?: () => Promise<TaskRemovalParticipantStepResult>;
    finalize?: () => Promise<TaskRemovalParticipantStepResult>;
  } = {},
): TaskRemovalOwnerParticipant {
  const hookSetVersion =
    id === 'agent-session'
      ? AGENT_SESSION_OWNER_HOOK_SET_VERSION
      : id === 'initial-prompt'
        ? TASK_INITIAL_PROMPT_HOOK_SET_VERSION
        : TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION;
  return {
    activateLegacyEffectCutover: async () => undefined,
    drainTaskForRemoval: options.drain ?? (async () => ({ kind: 'complete' as const })),
    ...(id === 'task-runtime'
      ? {
          async cleanupTaskRuntimeStep(request) {
            return {
              evidence: { state: 'test-complete' },
              kind: 'step-complete' as const,
              step: request.step,
            };
          },
        }
      : {}),
    finalizeRemovedTaskState: options.finalize ?? (async () => ({ kind: 'complete' as const })),
    hookSetVersion,
    id,
    probe: async () => ({ hookSetVersion, kind: 'ready' as const }),
    verifyLegacyEffectCutover: async () => undefined,
  };
}

function participants(
  overrides: {
    agentSession?: Parameters<typeof createParticipant>[1];
    initialPrompt?: Parameters<typeof createParticipant>[1];
  } = {},
): readonly TaskRemovalOwnerParticipant[] {
  return [
    createParticipant('initial-prompt', overrides.initialPrompt),
    createParticipant('agent-session', overrides.agentSession),
    createParticipant('task-runtime'),
  ];
}

async function seedTask(): Promise<void> {
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-task' },
    {
      collapsedTaskOrder: [],
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          agentId: 'agent-1',
          branchName: 'task/one',
          gitIsolation: 'worktree',
          id: 'task-1',
          name: 'Task one',
          notes: 'Initial note',
          projectId: 'project-1',
          taskMode: 'agent',
          worktreePath: '/repo/.worktrees/task-1',
        },
      },
    },
    undefined,
  );
  await structure.ensurePreManagedWriterCutover();
}

async function activateNotes(
  removalParticipants: readonly TaskRemovalOwnerParticipant[] = participants(),
): Promise<TaskNotesStructuralAuthority> {
  await structure.activateTaskRemovalOwner(removalParticipants);
  return structure.activateTaskNotesStructuralAuthority();
}

function addTask2Request() {
  return {
    baseBranch: 'main',
    branchName: 'task/two',
    gitIsolation: 'worktree' as const,
    name: 'Task two',
    projectId: 'project-1',
    projectMode: 'git' as const,
    projectRoot: '/repo',
    taskId: 'task-2',
    taskMode: 'agent' as const,
    worktreePath: '/repo/.worktrees/task-2',
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-notes-structural-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
  nextDeletionOperation = 1;
  nextWitnessByte = 1;
  structure = new TaskStructureMutationService(workspace, structureOptions());
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('task notes structural dark cutover', () => {
  it('stays fail-closed until explicit cutover, then atomically seeds, protects, and serves current', async () => {
    await seedTask();
    const darkAuthority = structure.getTaskNotesStructuralAuthority();
    expect(darkAuthority.getTaskNotesCommonReadiness()).toEqual({
      kind: 'unavailable',
      retryAfterMs: 500,
    });
    await structure.activateTaskRemovalOwner(participants());
    expect(darkAuthority.getTaskNotesCommonReadiness()).toEqual({
      kind: 'unavailable',
      retryAfterMs: 500,
    });

    const authority = await structure.activateTaskNotesStructuralAuthority();
    const readiness = authority.getTaskNotesCommonReadiness();
    expect(readiness).toMatchObject({ kind: 'ready', writable: true });
    if (readiness.kind !== 'ready') throw new Error('Expected notes readiness');

    const collected = await authority.collectTaskNotesCurrentEnvelope({
      readinessGeneration: readiness.generation,
      taskId: 'task-1',
    });
    expect(collected).toMatchObject({
      current: {
        currentNotes: { kind: 'present', snapshot: { notes: 'Initial note', taskId: 'task-1' } },
        currentTask: { taskClosing: false, taskState: 'present' },
        relation: 'same-incarnation',
      },
      kind: 'collected',
    });
    if (collected.kind !== 'collected' || !collected.taskIdentityWitness) {
      throw new Error('Expected private task witness');
    }
    expect(collected.current.currentTask).toMatchObject({
      taskIncarnation: deriveTaskNotesIncarnation(collected.taskIdentityWitness),
    });

    const record = (await storage.loadCurrent()).record;
    expect(record.privateState).toMatchObject({
      protectedWorkspacePolicyVersions: { 'task-notes': '1' },
      taskNotesOperations: { formatVersion: 1, operations: {} },
      taskNotesStructuralAuthority: {
        cutoverEpoch: 'task-notes-cutover-epoch-1',
        phase: 'active',
        schemaVersion: 1,
        witnessesByTaskId: {
          'task-1': { value: collected.taskIdentityWitness, witnessVersion: 1 },
        },
      },
    });

    const forbidden = cloneJsonObject(record.sharedState);
    ((forbidden.tasks as JsonObject)['task-1'] as JsonObject).notes = 'legacy overwrite';
    await expect(
      workspace.replaceSharedState(
        { expectedSharedRevision: record.sharedRevision, operation: 'legacy-notes-writer' },
        forbidden,
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceProtectedFieldConflictError);

    const generationBeforeRetry = (await storage.loadCurrent()).record.storageGeneration;
    await structure.activateTaskNotesStructuralAuthority();
    expect((await storage.loadCurrent()).record.storageGeneration).toBe(generationBeforeRetry);
  });

  it('integrates the real task-notes service without another identity or current owner', async () => {
    await seedTask();
    const authority = await activateNotes();
    const service = new TaskNotesService(workspace.createPrivateMutationAuthority(), authority);
    const principal = createTaskNotesPrincipalContext('workspace-user');

    const loaded = await service.getTaskNotes(principal, { taskId: 'task-1' });
    expect(loaded).toMatchObject({
      ok: true,
      result: {
        current: { currentNotes: { snapshot: { notes: 'Initial note' } } },
        kind: 'loaded',
      },
    });
  });
});

describe('task-closing admission and drain handoff', () => {
  it('drains an admitted winner, rejects every newcomer, then hands fence to durable closing', async () => {
    await seedTask();
    const drain = vi.fn(async () => ({ kind: 'complete' as const }));
    const authority = await activateNotes(
      participants({ initialPrompt: { drain }, agentSession: { drain } }),
    );
    const readiness = authority.getTaskNotesCommonReadiness();
    if (readiness.kind !== 'ready') throw new Error('Expected notes readiness');
    const winner = await authority.admitTaskMutationSet({
      operationId: 'note-operation-1',
      readinessGeneration: readiness.generation,
      taskIds: ['task-1'],
    });
    if (winner.kind !== 'admitted') throw new Error('Expected admitted winner');

    const removal = structure.removeTask(
      { expectedSharedRevision: 2, operation: 'remove-task-1' },
      'task-1',
    );
    await vi.waitFor(() => {
      expect(
        structure
          .createTaskRemovalParticipantGate('initial-prompt', TASK_INITIAL_PROMPT_HOOK_SET_VERSION)
          .getTaskSnapshot('task-1'),
      ).toMatchObject({ current: { taskClosing: true, taskState: 'present' } });
    });
    expect(drain).not.toHaveBeenCalled();
    await expect(
      authority.collectTaskNotesCurrentEnvelope({
        readinessGeneration: readiness.generation,
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({
      current: {
        currentNotes: { kind: 'present', snapshot: { notes: 'Initial note' } },
        currentTask: { taskClosing: true, taskState: 'present' },
        relation: 'same-incarnation',
      },
      kind: 'collected',
    });
    await expect(
      authority.admitTaskMutationSet({
        operationId: 'note-operation-2',
        readinessGeneration: readiness.generation,
        taskIds: ['task-1'],
      }),
    ).resolves.toEqual({ kind: 'task-closing' });

    await winner.lease.release();
    await expect(removal).resolves.toMatchObject({
      changed: true,
      result: { removed: true, removalState: 'complete', taskId: 'task-1' },
    });
    expect(drain).toHaveBeenCalledTimes(2);
    await expect(
      authority.admitTaskMutationSet({
        operationId: 'note-operation-3',
        readinessGeneration: readiness.generation,
        taskIds: ['task-1'],
      }),
    ).resolves.toEqual({ kind: 'task-closing' });

    await expect(
      authority.collectTaskNotesCurrentEnvelope({
        readinessGeneration: readiness.generation,
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({
      current: { relation: 'task-removed' },
      kind: 'collected',
    });
  });

  it('does not block unrelated-task admission while one task is draining', async () => {
    await seedTask();
    const authority = await activateNotes();
    await structure.addTask(
      { expectedSharedRevision: 2, operation: 'add-task-2' },
      addTask2Request(),
    );
    const readiness = authority.getTaskNotesCommonReadiness();
    if (readiness.kind !== 'ready') throw new Error('Expected notes readiness');
    const task1 = await authority.admitTaskMutationSet({
      operationId: 'task-1-note',
      readinessGeneration: readiness.generation,
      taskIds: ['task-1'],
    });
    if (task1.kind !== 'admitted') throw new Error('Expected task-1 admission');
    const removal = structure.removeTask(
      { expectedSharedRevision: 3, operation: 'remove-task-1' },
      'task-1',
    );
    await vi.waitFor(() => {
      expect(
        structure
          .createTaskRemovalParticipantGate('initial-prompt', TASK_INITIAL_PROMPT_HOOK_SET_VERSION)
          .getTaskSnapshot('task-1'),
      ).toMatchObject({ current: { taskClosing: true } });
    });
    await expect(
      authority.admitTaskMutationSet({
        operationId: 'task-1-loser',
        readinessGeneration: readiness.generation,
        taskIds: ['task-1'],
      }),
    ).resolves.toEqual({ kind: 'task-closing' });
    await expect(
      authority.admitTaskMutationSet({
        operationId: 'all-or-none-multi-task',
        readinessGeneration: readiness.generation,
        taskIds: ['task-2', 'task-1'],
      }),
    ).resolves.toEqual({ kind: 'task-closing' });
    const task2 = await authority.admitTaskMutationSet({
      operationId: 'task-2-note',
      readinessGeneration: readiness.generation,
      taskIds: ['task-2'],
    });
    expect(task2.kind).toBe('admitted');
    if (task2.kind === 'admitted') await task2.lease.release();
    await task1.lease.release();
    await removal;
  });

  it('fails closed without corrupting removal indexes on a deletion-identity collision', async () => {
    structure = new TaskStructureMutationService(workspace, {
      ...structureOptions(),
      removalOwner: {
        ...structureOptions().removalOwner,
        createDeletionOperationId: () => 'colliding-deletion-operation',
      },
    });
    await seedTask();
    await activateNotes();
    await structure.addTask(
      { expectedSharedRevision: 2, operation: 'add-task-2-before-collision' },
      addTask2Request(),
    );
    await structure.removeTask(
      { expectedSharedRevision: 3, operation: 'remove-task-1-before-collision' },
      'task-1',
    );

    await expect(
      structure.removeTask(
        { expectedSharedRevision: 4, operation: 'remove-task-2-collision' },
        'task-2',
      ),
    ).rejects.toThrow('already bound to another task');
    expect((await storage.loadCurrent()).record).toMatchObject({
      privateState: {
        taskRemovalOperations: {
          deletionOperationIdByTaskId: {
            'task-1': 'colliding-deletion-operation',
          },
          recordsByDeletionOperationId: {
            'colliding-deletion-operation': { taskId: 'task-1' },
          },
        },
      },
      sharedState: { tasks: { 'task-2': { id: 'task-2' } } },
    });
  });

  it('keeps retry-window holds joinable and host-durability holds globally fail-closed', async () => {
    await seedTask();
    const authority = await activateNotes();
    await structure.addTask(
      { expectedSharedRevision: 2, operation: 'add-task-2-for-host-hold' },
      addTask2Request(),
    );
    const firstReadiness = authority.getTaskNotesCommonReadiness();
    if (firstReadiness.kind !== 'ready') throw new Error('Expected notes readiness');

    const retryWindow = await authority.admitTaskMutationSet({
      operationId: 'stable-operation',
      readinessGeneration: firstReadiness.generation,
      taskIds: ['task-1'],
    });
    if (retryWindow.kind !== 'admitted') throw new Error('Expected retry-window admission');
    retryWindow.lease.retainUntilRetryWindowMaterialized();
    expect(authority.getTaskNotesCommonReadiness()).toEqual(firstReadiness);
    const removal = structure.removeTask(
      { expectedSharedRevision: 3, operation: 'remove-during-retry-window-hold' },
      'task-1',
    );
    await vi.waitFor(() => {
      expect(
        structure
          .createTaskRemovalParticipantGate('initial-prompt', TASK_INITIAL_PROMPT_HOOK_SET_VERSION)
          .getTaskSnapshot('task-1'),
      ).toMatchObject({ current: { taskClosing: true } });
    });
    const joined = await authority.admitTaskMutationSet({
      operationId: 'stable-operation',
      readinessGeneration: firstReadiness.generation,
      taskIds: ['task-1'],
    });
    if (joined.kind !== 'admitted') throw new Error('Expected stable-operation join');
    await expect(
      authority.admitTaskMutationSet({
        operationId: 'new-operation-after-drain',
        readinessGeneration: firstReadiness.generation,
        taskIds: ['task-1'],
      }),
    ).resolves.toEqual({ kind: 'task-closing' });
    await joined.lease.release();
    await removal;

    const hostHold = await authority.admitTaskMutationSet({
      operationId: 'host-durability-operation',
      readinessGeneration: firstReadiness.generation,
      taskIds: ['task-2'],
    });
    if (hostHold.kind !== 'admitted') throw new Error('Expected host hold admission');
    hostHold.lease.retainUntilHostDurable('terminal-outcome');
    expect(authority.getTaskNotesCommonReadiness()).toEqual({
      kind: 'unavailable',
      retryAfterMs: 500,
    });
    await expect(
      authority.admitTaskMutationSet({
        operationId: 'must-not-enter',
        readinessGeneration: firstReadiness.generation,
        taskIds: ['task-2'],
      }),
    ).resolves.toEqual({ kind: 'task-state-unavailable', retryAfterMs: 500 });

    const hostBlockedRemoval = structure.removeTask(
      { expectedSharedRevision: 4, operation: 'remove-during-host-durability-hold' },
      'task-2',
    );
    await vi.waitFor(() => {
      expect(
        structure
          .createTaskRemovalParticipantGate('agent-session', AGENT_SESSION_OWNER_HOOK_SET_VERSION)
          .getTaskSnapshot('task-2'),
      ).toMatchObject({ current: { taskClosing: true, taskState: 'present' } });
    });
    let removalSettled = false;
    void hostBlockedRemoval.then(
      () => {
        removalSettled = true;
      },
      () => {
        removalSettled = true;
      },
    );
    await Promise.resolve();
    expect(removalSettled).toBe(false);
    await structure.recoverTaskNotesStructuralAuthority('host-durability-operation');
    await hostBlockedRemoval;
    const recovered = authority.getTaskNotesCommonReadiness();
    expect(recovered).toMatchObject({ kind: 'ready', writable: true });
    if (recovered.kind !== 'ready') throw new Error('Expected recovered readiness');
    expect(recovered.generation).not.toBe(firstReadiness.generation);
    await expect(
      authority.admitTaskMutationSet({
        operationId: 'old-generation',
        readinessGeneration: firstReadiness.generation,
        taskIds: ['task-2'],
      }),
    ).resolves.toEqual({ kind: 'task-state-unavailable', retryAfterMs: 500 });
  });
});

describe('restart, identity, and coherent collection', () => {
  it('reconstructs durable closing before reopening notes after restart', async () => {
    await seedTask();
    const retryDrain = vi.fn(async () => ({ kind: 'retry-required' as const }));
    await activateNotes(participants({ initialPrompt: { drain: retryDrain } }));
    await expect(
      structure.removeTask({ expectedSharedRevision: 2, operation: 'begin-removal' }, 'task-1'),
    ).resolves.toMatchObject({
      result: { removed: false, removalState: 'cleanup-pending' },
    });

    const restarted = new TaskStructureMutationService(
      workspace,
      structureOptions(SERVER_INSTANCE_2),
    );
    const restartedAuthority = restarted.getTaskNotesStructuralAuthority();
    expect(restartedAuthority.getTaskNotesCommonReadiness().kind).toBe('unavailable');
    await restarted.activateTaskRemovalOwner(participants());
    const readiness = restartedAuthority.getTaskNotesCommonReadiness();
    expect(readiness).toMatchObject({ kind: 'ready', writable: true });
    if (readiness.kind !== 'ready') throw new Error('Expected restart readiness');
    await expect(
      restartedAuthority.admitTaskMutationSet({
        operationId: 'restart-note',
        readinessGeneration: readiness.generation,
        taskIds: ['task-1'],
      }),
    ).resolves.toEqual({ kind: 'task-closing' });
  });

  it('returns task-replaced for a valid same-ID witness change and never reveals replacement notes', async () => {
    await seedTask();
    const authority = await activateNotes();
    const readiness = authority.getTaskNotesCommonReadiness();
    if (readiness.kind !== 'ready') throw new Error('Expected notes readiness');
    const before = await authority.collectTaskNotesCurrentEnvelope({
      readinessGeneration: readiness.generation,
      taskId: 'task-1',
    });
    if (before.kind !== 'collected' || !before.taskIdentityWitness) {
      throw new Error('Expected original witness');
    }
    const originalWitness = before.taskIdentityWitness;
    const replacementWitness = nextWitness();
    await workspace
      .createPrivateMutationAuthority()
      .mutate({ operation: 'simulate-authorized-identity-replacement' }, (slices) => {
        const nextPrivate = cloneJsonObject(slices.privateState);
        const schema = nextPrivate.taskNotesStructuralAuthority as JsonObject;
        const witnesses = schema.witnessesByTaskId as JsonObject;
        (witnesses['task-1'] as JsonObject).value = replacementWitness;
        return changed({ nextPrivateState: nextPrivate }, undefined);
      });

    const replaced = await authority.collectTaskNotesCurrentEnvelope({
      expectedTaskIdentityWitness: originalWitness,
      readinessGeneration: readiness.generation,
      taskId: 'task-1',
    });
    expect(replaced).toMatchObject({
      current: {
        currentNotes: { kind: 'unavailable', reason: 'task-replaced' },
        currentTask: {
          taskIncarnation: deriveTaskNotesIncarnation(replacementWitness),
          taskState: 'present',
        },
        relation: 'task-replaced',
      },
      kind: 'collected',
    });
    expect(replaced).not.toHaveProperty('taskIdentityWitness');
  });

  it('bounds host-generation churn to three attempts without returning partial current', async () => {
    const baseAuthority = workspace.createPrivateMutationAuthority();
    let churn = false;
    let churnCount = 0;
    const churningAuthority: WorkspacePrivateMutationAuthority = {
      async mutate(request, mutator) {
        const result = await baseAuthority.mutate(request, mutator);
        if (churn && request.operation === 'collect-task-notes-current-h1') {
          churnCount += 1;
          await baseAuthority.mutate({ operation: `collector-churn-${churnCount}` }, (slices) => {
            const nextPrivate = cloneJsonObject(slices.privateState);
            nextPrivate.collectorChurn = churnCount;
            return changed({ nextPrivateState: nextPrivate }, undefined);
          });
        }
        return result;
      },
    };
    structure = new TaskStructureMutationService(
      workspace,
      structureOptions(SERVER_INSTANCE_1, churningAuthority),
    );
    await seedTask();
    const authority = await activateNotes();
    const readiness = authority.getTaskNotesCommonReadiness();
    if (readiness.kind !== 'ready') throw new Error('Expected notes readiness');
    churn = true;
    await expect(
      authority.collectTaskNotesCurrentEnvelope({
        readinessGeneration: readiness.generation,
        taskId: 'task-1',
      }),
    ).resolves.toEqual({ kind: 'unavailable', retryAfterMs: 500 });
    expect(churnCount).toBe(3);
    expect(authority.getTaskNotesCommonReadiness()).toEqual(readiness);
  });

  it('closes common readiness across a canonical structural publication window', async () => {
    const baseAuthority = workspace.createPrivateMutationAuthority();
    let blockAdd = false;
    let releaseAdd: (() => void) | undefined;
    let announceBlocked: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      announceBlocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const gatedAuthority: WorkspacePrivateMutationAuthority = {
      async mutate(request, mutator) {
        if (blockAdd && request.operation === 'blocked-task-add') {
          announceBlocked?.();
          await release;
        }
        return baseAuthority.mutate(request, mutator);
      },
    };
    structure = new TaskStructureMutationService(
      workspace,
      structureOptions(SERVER_INSTANCE_1, gatedAuthority),
    );
    await seedTask();
    const authority = await activateNotes();
    const readiness = authority.getTaskNotesCommonReadiness();
    if (readiness.kind !== 'ready') throw new Error('Expected notes readiness');

    blockAdd = true;
    const addition = structure.addTask(
      { expectedSharedRevision: 2, operation: 'blocked-task-add' },
      addTask2Request(),
    );
    await blocked;
    expect(authority.getTaskNotesCommonReadiness()).toEqual({
      kind: 'unavailable',
      retryAfterMs: 500,
    });
    await expect(
      authority.collectTaskNotesCurrentEnvelope({
        readinessGeneration: readiness.generation,
        taskId: 'task-2',
      }),
    ).resolves.toEqual({ kind: 'unavailable', retryAfterMs: 500 });

    releaseAdd?.();
    await addition;
    expect(authority.getTaskNotesCommonReadiness()).toEqual(readiness);
    await expect(
      authority.collectTaskNotesCurrentEnvelope({
        readinessGeneration: readiness.generation,
        taskId: 'task-2',
      }),
    ).resolves.toMatchObject({
      current: { relation: 'same-incarnation' },
      kind: 'collected',
    });
  });

  it('fails restart closed on corrupted private identity state and keeps same-ID reuse blocked', async () => {
    await seedTask();
    await activateNotes();
    await workspace
      .createPrivateMutationAuthority()
      .mutate({ operation: 'corrupt-task-witness' }, (slices) => {
        const nextPrivate = cloneJsonObject(slices.privateState);
        const schema = nextPrivate.taskNotesStructuralAuthority as JsonObject;
        const witnesses = schema.witnessesByTaskId as JsonObject;
        (witnesses['task-1'] as JsonObject).value = 'corrupt';
        return changed({ nextPrivateState: nextPrivate }, undefined);
      });
    const restarted = new TaskStructureMutationService(
      workspace,
      structureOptions(SERVER_INSTANCE_2),
    );
    await expect(restarted.activateTaskRemovalOwner(participants())).rejects.toThrow(
      'Task identity witness task-1 is invalid',
    );
    expect(restarted.getTaskNotesStructuralAuthority().getTaskNotesCommonReadiness()).toEqual({
      kind: 'unavailable',
      retryAfterMs: 500,
    });

    await expect(
      structure.addTask(
        { expectedSharedRevision: 2, operation: 'same-id-reuse' },
        { ...addTask2Request(), taskId: 'task-1' },
      ),
    ).rejects.toBeInstanceOf(TaskStructureConflictError);
  });

  it('fails restart closed when the notes operation segment is missing or corrupt', async () => {
    await seedTask();
    await activateNotes();
    await workspace
      .createPrivateMutationAuthority()
      .mutate({ operation: 'corrupt-task-notes-operation-segment' }, (slices) => {
        const nextPrivate = cloneJsonObject(slices.privateState);
        nextPrivate.taskNotesOperations = { formatVersion: 99, operations: {} };
        return changed({ nextPrivateState: nextPrivate }, undefined);
      });
    const restarted = new TaskStructureMutationService(
      workspace,
      structureOptions(SERVER_INSTANCE_2),
    );
    await expect(restarted.activateTaskRemovalOwner(participants())).rejects.toThrow(
      'Unsupported task notes operation segment version',
    );
    expect(restarted.getTaskNotesStructuralAuthority().getTaskNotesCommonReadiness().kind).toBe(
      'unavailable',
    );
  });
});
