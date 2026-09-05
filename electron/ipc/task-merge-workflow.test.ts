import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import { TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION } from '../../src/domain/task-removal-owner.js';
import type { StorageEnv } from './storage.js';
import type {
  TaskRemovalOwnerParticipant,
  TaskRemovalParticipantStepResult,
} from './task-removal-owner.js';
import { TaskStructureMutationService } from './task-structure-mutations.js';
import {
  activateTaskMergeBackend,
  type ActiveTaskMergeBackend,
  type TaskMergeWorkflowFaultPoint,
} from './task-merge-workflow.js';
import {
  WorkspaceMutationService,
  activateProtectedPolicies,
  changed,
} from './workspace-state-mutations.js';
import {
  createStandaloneWorkspaceStateStorage,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

let root = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;
let structure: TaskStructureMutationService;
let backend: ActiveTaskMergeBackend;
let now = Date.parse('2026-08-04T08:00:00.000Z');
let faultPoint: TaskMergeWorkflowFaultPoint | null = null;
let drainResults: TaskRemovalParticipantStepResult[] = [];

const executeGit = vi.fn(async () => ({ linesAdded: 7, linesRemoved: 2 }));
const disableLegacyMergeWriters = vi.fn(async () => undefined);
const verifyLegacyMergeWritersDisabled = vi.fn(async () => undefined);

function env(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

function participant(
  id: 'agent-session' | 'initial-prompt' | 'task-runtime',
): TaskRemovalOwnerParticipant {
  const hookSetVersion =
    id === 'agent-session'
      ? AGENT_SESSION_OWNER_HOOK_SET_VERSION
      : id === 'initial-prompt'
        ? TASK_INITIAL_PROMPT_HOOK_SET_VERSION
        : TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION;
  return {
    activateLegacyEffectCutover: async () => {
      if (id !== 'initial-prompt') return;
      await workspace
        .createPrivateMutationAuthority()
        .mutate({ operation: 'activate-test-initial-prompt-owner' }, (slices) =>
          changed(
            {
              nextPrivateState: activateProtectedPolicies(slices.privateState, ['initial-prompt']),
            },
            undefined,
          ),
        );
    },
    async drainTaskForRemoval() {
      return drainResults.shift() ?? { kind: 'complete' };
    },
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
    finalizeRemovedTaskState: async () => ({ kind: 'complete' }),
    hookSetVersion,
    id,
    probe: async () => ({ hookSetVersion, kind: 'ready' }),
    verifyLegacyEffectCutover: async () => undefined,
  };
}

async function seedTasks(taskIds: readonly string[] = ['task-1']): Promise<void> {
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-task-merge-workspace' },
    {
      collapsedTaskOrder: [],
      completedTaskCount: 0,
      completedTaskDate: '2026-08-04',
      mergedLinesAdded: 0,
      mergedLinesRemoved: 0,
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: [...taskIds],
      tasks: Object.fromEntries(
        taskIds.map((taskId, index) => [
          taskId,
          {
            branchName: `task/branch-${index + 1}`,
            gitIsolation: 'worktree',
            id: taskId,
            name: `Task ${index + 1}`,
            projectId: 'project-1',
            taskMode: 'agent',
            worktreePath: `/repo/.worktrees/${taskId}`,
          },
        ]),
      ),
    },
    undefined,
  );
  await structure.ensurePreManagedWriterCutover();
  await structure.activateTaskRemovalOwner([
    participant('initial-prompt'),
    participant('agent-session'),
    participant('task-runtime'),
  ]);
  await activateManagedWriter(structure);
}

async function activateManagedWriter(service: TaskStructureMutationService): Promise<void> {
  await service.activateManagedTaskCreationWriter({
    async classify(_taskId, task) {
      return task.taskMode === 'agent'
        ? {
            operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
            shellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
          }
        : {
            operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
            shellOwnership: { kind: 'legacy-unmanaged-terminal', migrationSchemaVersion: 1 },
          };
    },
  });
}

async function activateBackend(): Promise<ActiveTaskMergeBackend> {
  backend = await activateTaskMergeBackend({
    authorize: async () => true,
    executeGit,
    faultInjector: async (point) => {
      if (faultPoint === point) {
        faultPoint = null;
        throw new Error(`injected:${point}`);
      }
    },
    issuerOptions: {
      createCutoverEpoch: () => 'task-merge-cutover-1',
      now: () => now,
    },
    legacyWriterCutover: {
      disableLegacyMergeWriters,
      verifyLegacyMergeWritersDisabled,
    },
    now: () => now,
    structure,
    workspace,
  });
  return backend;
}

async function issueAndStart(
  taskId = 'task-1',
  cleanup = true,
): Promise<{
  access: Awaited<ReturnType<ActiveTaskMergeBackend['workflow']['issue']>>;
  request: {
    cleanup: boolean;
    squash: boolean;
    taskId: string;
  };
}> {
  const access = await backend.workflow.issue({ principalId: 'principal-1', taskId });
  const request = { cleanup, squash: false, taskId };
  return { access, request };
}

beforeEach(async () => {
  vi.clearAllMocks();
  now = Date.parse('2026-08-04T08:00:00.000Z');
  faultPoint = null;
  drainResults = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-merge-workflow-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
  structure = new TaskStructureMutationService(workspace, {
    removalOwner: {
      createCutoverEpoch: () => 'task-removal-cutover-1',
      serverInstanceId: 'server-instance-1',
    },
  });
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('backend task merge workflow', () => {
  it('cuts over only after real legacy-writer disable/verification and then protects progress', async () => {
    await seedTasks();
    const structureWithoutManagedCapability = new TaskStructureMutationService(workspace, {
      removalOwner: { serverInstanceId: 'server-instance-without-managed-writer' },
    });
    await structureWithoutManagedCapability.activateTaskRemovalOwner([
      participant('initial-prompt'),
      participant('agent-session'),
      participant('task-runtime'),
    ]);
    await expect(
      activateTaskMergeBackend({
        authorize: async () => true,
        executeGit,
        legacyWriterCutover: {
          disableLegacyMergeWriters,
          verifyLegacyMergeWritersDisabled,
        },
        structure: structureWithoutManagedCapability,
        workspace,
      }),
    ).rejects.toThrow('active managed task creation writer');

    await expect(
      activateTaskMergeBackend({
        authorize: async () => true,
        executeGit,
        issuerOptions: {
          createCutoverEpoch: () => 'task-merge-cutover-1',
          now: () => now,
        },
        legacyWriterCutover: {
          disableLegacyMergeWriters: async () => {
            throw new Error('legacy writer could not be disabled');
          },
          verifyLegacyMergeWritersDisabled,
        },
        structure,
        workspace,
      }),
    ).rejects.toThrow('legacy writer could not be disabled');

    const active = await activateBackend();
    expect(active.capability).toEqual({
      cutoverEpoch: 'task-merge-cutover-1',
      kind: 'active',
      schemaVersion: 1,
    });
    expect(disableLegacyMergeWriters).toHaveBeenCalledWith('task-merge-cutover-1');
    expect(verifyLegacyMergeWritersDisabled).toHaveBeenCalledWith('task-merge-cutover-1');
    expect((await storage.loadCurrent()).record).toMatchObject({
      privateState: {
        protectedWorkspacePolicyVersions: { 'merge-progress': '1' },
        taskMergeOwnerSchema: {
          legacyWritersDisabled: true,
          phase: 'active',
        },
      },
      sharedState: { mergeProgress: { tasksToday: 0, version: 1 } },
    });
  });

  it('uses the merge ID for generic removal and commits all progress values exactly once', async () => {
    await seedTasks();
    await activateBackend();
    const { access, request } = await issueAndStart();

    const first = await backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    expect(first).toMatchObject({
      currentProgress: { linesAdded: 7, linesRemoved: 2, tasksToday: 1, version: 2 },
      currentRemoval: {
        deletionOperationId: access.operationId,
        removalState: 'complete',
        taskId: 'task-1',
      },
      originalOutcome: {
        counted: true,
        operationId: access.operationId,
        phase: 'completed',
        taskReleased: true,
      },
      replayed: false,
    });
    expect(executeGit).toHaveBeenCalledTimes(1);
    expect(executeGit).toHaveBeenCalledWith(
      expect.objectContaining({ cleanup: false, taskId: 'task-1' }),
    );

    const replay = await backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.currentProgress).toEqual(first.currentProgress);
    expect(replay.originalOutcome).toEqual(first.originalOutcome);
    expect(executeGit).toHaveBeenCalledTimes(1);
    expect((await storage.loadCurrent()).record.sharedState).toMatchObject({
      committedMergeOperationId: access.operationId,
      completedTaskCount: 1,
      mergedLinesAdded: 7,
      mergedLinesRemoved: 2,
      tasks: {},
    });
  });

  it('status-joins a lost response after canonical removal without rerunning Git or counting twice', async () => {
    await seedTasks();
    await activateBackend();
    const { access, request } = await issueAndStart();
    faultPoint = 'after-removal-before-terminal-record';

    await expect(
      backend.workflow.start({
        access,
        principalId: 'principal-1',
        semanticRequest: request,
      }),
    ).rejects.toThrow('injected:after-removal-before-terminal-record');
    expect((await storage.loadCurrent()).record.sharedState).toMatchObject({
      completedTaskCount: 1,
      mergedLinesAdded: 7,
      mergedLinesRemoved: 2,
      tasks: {},
    });

    const recovered = await backend.workflow.status({
      access,
      principalId: 'principal-1',
    });
    expect(recovered).toMatchObject({
      currentProgress: { linesAdded: 7, linesRemoved: 2, tasksToday: 1 },
      originalOutcome: { phase: 'completed' },
      replayed: true,
    });
    const replay = await backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    expect(replay.originalOutcome.phase).toBe('completed');
    expect(executeGit).toHaveBeenCalledTimes(1);
  });

  it('terminalizes an older lost response from removal evidence after a newer merge replaces the latest marker', async () => {
    await seedTasks(['task-1', 'task-2']);
    await activateBackend();
    const first = await issueAndStart('task-1');
    faultPoint = 'after-removal-before-terminal-record';
    await expect(
      backend.workflow.start({
        access: first.access,
        principalId: 'principal-1',
        semanticRequest: first.request,
      }),
    ).rejects.toThrow('after-removal-before-terminal-record');

    now += 1_000;
    const second = await issueAndStart('task-2');
    await backend.workflow.start({
      access: second.access,
      principalId: 'principal-1',
      semanticRequest: second.request,
    });
    const recoveredFirst = await backend.workflow.start({
      access: first.access,
      principalId: 'principal-1',
      semanticRequest: first.request,
    });

    expect(recoveredFirst).toMatchObject({
      currentProgress: { tasksToday: 2, version: 3 },
      originalOutcome: {
        phase: 'completed',
        progressVersionAtOutcome: 2,
      },
      replayed: true,
    });
    expect(executeGit).toHaveBeenCalledTimes(2);
  });

  it('keeps Git success resumable while generic cleanup is incomplete', async () => {
    drainResults = [{ kind: 'retry-required', reason: 'runner-still-active' }];
    await seedTasks();
    await activateBackend();
    const { access, request } = await issueAndStart();

    const pending = await backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    expect(pending).toMatchObject({
      currentProgress: { linesAdded: 0, linesRemoved: 0, tasksToday: 0 },
      currentRemoval: { removalState: 'cleanup-pending', removed: false },
      originalOutcome: { gitMerged: true, phase: 'merged-awaiting-removal' },
    });
    expect((await storage.loadCurrent()).record.sharedState.tasks).toHaveProperty('task-1');

    const completed = await backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    expect(completed).toMatchObject({
      currentProgress: { linesAdded: 7, linesRemoved: 2, tasksToday: 1 },
      originalOutcome: { phase: 'completed' },
    });
    expect(executeGit).toHaveBeenCalledTimes(1);
  });

  it('counts nothing for merge-and-keep or a proven Git failure', async () => {
    await seedTasks(['task-1', 'task-2']);
    await activateBackend();
    const keep = await issueAndStart('task-1', false);
    const kept = await backend.workflow.start({
      access: keep.access,
      principalId: 'principal-1',
      semanticRequest: keep.request,
    });
    expect(kept).toMatchObject({
      currentProgress: { linesAdded: 0, linesRemoved: 0, tasksToday: 0 },
      currentRemoval: null,
      originalOutcome: { counted: false, phase: 'completed-not-counted' },
    });

    executeGit.mockRejectedValueOnce(new Error('merge conflict'));
    const failedAccess = await backend.workflow.issue({
      principalId: 'principal-1',
      taskId: 'task-2',
    });
    const failed = await backend.workflow.start({
      access: failedAccess,
      principalId: 'principal-1',
      semanticRequest: { cleanup: true, squash: false, taskId: 'task-2' },
    });
    expect(failed).toMatchObject({
      currentProgress: { linesAdded: 0, linesRemoved: 0, tasksToday: 0 },
      currentRemoval: null,
      originalOutcome: { issue: { code: 'git-failed' }, phase: 'failed' },
    });
    expect((await storage.loadCurrent()).record.sharedState.tasks).toMatchObject({
      'task-1': { id: 'task-1' },
      'task-2': { id: 'task-2' },
    });
  });

  it('single-flights concurrent retries and gives the joiner replay semantics', async () => {
    await seedTasks();
    await activateBackend();
    const { access, request } = await issueAndStart();
    let releaseGit!: () => void;
    executeGit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGit = () => resolve({ linesAdded: 7, linesRemoved: 2 });
        }),
    );

    const first = backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    const joined = backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    await vi.waitFor(() => expect(executeGit).toHaveBeenCalledTimes(1));
    releaseGit();

    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    expect(firstResult.replayed).toBe(false);
    expect(joinedResult.replayed).toBe(true);
    expect(joinedResult.originalOutcome).toEqual(firstResult.originalOutcome);
    expect(executeGit).toHaveBeenCalledTimes(1);
  });

  it('reserves dormant same-ID removal before Git without closing or mutating progress', async () => {
    await seedTasks();
    await activateBackend();
    const { access, request } = await issueAndStart();
    let releaseGit!: () => void;
    executeGit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGit = () => resolve({ linesAdded: 7, linesRemoved: 2 });
        }),
    );
    const pending = backend.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    await vi.waitFor(() => expect(executeGit).toHaveBeenCalledTimes(1));

    await expect(
      backend.workflow.start({
        access: { ...access, operationCapability: 'wrong-live-capability' },
        principalId: 'principal-1',
        semanticRequest: request,
      }),
    ).rejects.toMatchObject({ code: 'task-merge-operation-unavailable' });
    await expect(
      backend.workflow.start({
        access,
        principalId: 'principal-1',
        semanticRequest: { ...request, squash: true },
      }),
    ).rejects.toMatchObject({ code: 'task-merge-operation-conflict' });

    expect((await storage.loadCurrent()).record).toMatchObject({
      privateState: {
        taskRemovalOperations: {
          deletionOperationIdByTaskId: { 'task-1': access.operationId },
          recordsByDeletionOperationId: {
            [access.operationId]: {
              commitExtension: {
                kind: 'commit-completed-merge-progress-v1',
                state: 'awaiting-linked-proof',
              },
              phase: 'reserved-awaiting-activation',
              taskClosing: false,
            },
          },
        },
      },
      sharedState: {
        mergeProgress: { linesAdded: 0, linesRemoved: 0, tasksToday: 0 },
        tasks: { 'task-1': { id: 'task-1' } },
      },
    });
    releaseGit();
    await pending;
  });

  it('rejects superseded, expired, wrong-capability, and changed-intent retries without effects', async () => {
    await seedTasks(['task-1', 'task-2']);
    await activateBackend();
    const superseded = await backend.workflow.issue({
      principalId: 'principal-1',
      taskId: 'task-1',
    });
    await backend.workflow.issue({ principalId: 'principal-1', taskId: 'task-1' });
    const denied = await backend.workflow.start({
      access: superseded,
      principalId: 'principal-1',
      semanticRequest: { cleanup: true, squash: false, taskId: 'task-1' },
    });
    expect(denied.originalOutcome.phase).toBe('superseded-unused');

    const expiring = await backend.workflow.issue({
      principalId: 'principal-1',
      taskId: 'task-2',
    });
    now += 11 * 60 * 1_000;
    const expired = await backend.workflow.start({
      access: expiring,
      principalId: 'principal-1',
      semanticRequest: { cleanup: true, squash: false, taskId: 'task-2' },
    });
    expect(expired.originalOutcome.phase).toBe('expired-unused');
    expect(executeGit).not.toHaveBeenCalled();

    await expect(
      backend.workflow.status({
        access: { ...expiring, operationCapability: 'wrong-capability' },
        principalId: 'principal-1',
      }),
    ).rejects.toMatchObject({ code: 'task-merge-operation-unavailable' });

    now -= 11 * 60 * 1_000;
    drainResults = [{ kind: 'retry-required' }];
    const active = await issueAndStart('task-2');
    await backend.workflow.start({
      access: active.access,
      principalId: 'principal-1',
      semanticRequest: active.request,
    });
    await expect(
      backend.workflow.start({
        access: active.access,
        principalId: 'principal-1',
        semanticRequest: { ...active.request, squash: true },
      }),
    ).rejects.toMatchObject({ code: 'task-merge-operation-conflict' });
    expect(executeGit).toHaveBeenCalledTimes(1);
  });

  it('fails closed after an unrecorded Git return and never blindly invokes Git after restart', async () => {
    await seedTasks();
    await activateBackend();
    const { access, request } = await issueAndStart();
    faultPoint = 'after-git-before-result-record';
    await expect(
      backend.workflow.start({
        access,
        principalId: 'principal-1',
        semanticRequest: request,
      }),
    ).rejects.toThrow('injected:after-git-before-result-record');
    expect(executeGit).toHaveBeenCalledTimes(1);

    const restartedStructure = new TaskStructureMutationService(workspace, {
      removalOwner: { serverInstanceId: 'server-instance-2' },
    });
    await restartedStructure.ensurePreManagedWriterCutover();
    await restartedStructure.activateTaskRemovalOwner([
      participant('initial-prompt'),
      participant('agent-session'),
      participant('task-runtime'),
    ]);
    await activateManagedWriter(restartedStructure);
    const restarted = await activateTaskMergeBackend({
      authorize: async () => true,
      executeGit,
      issuerOptions: { now: () => now },
      legacyWriterCutover: {
        disableLegacyMergeWriters,
        verifyLegacyMergeWritersDisabled,
      },
      now: () => now,
      structure: restartedStructure,
      workspace,
    });
    const recovered = await restarted.workflow.start({
      access,
      principalId: 'principal-1',
      semanticRequest: request,
    });
    expect(recovered).toMatchObject({
      currentProgress: { tasksToday: 0 },
      originalOutcome: {
        issue: { code: 'git-outcome-ambiguous' },
        phase: 'manual-reconciliation-required',
      },
      replayed: true,
    });
    expect(executeGit).toHaveBeenCalledTimes(1);
  });

  it('replays an old immutable outcome beside the newest progress snapshot', async () => {
    await seedTasks(['task-1', 'task-2']);
    await activateBackend();
    const first = await issueAndStart('task-1');
    const firstOutcome = await backend.workflow.start({
      access: first.access,
      principalId: 'principal-1',
      semanticRequest: first.request,
    });
    now += 1_000;
    const second = await issueAndStart('task-2');
    executeGit.mockResolvedValueOnce({ linesAdded: 3, linesRemoved: 1 });
    await backend.workflow.start({
      access: second.access,
      principalId: 'principal-1',
      semanticRequest: second.request,
    });

    const replay = await backend.workflow.status({
      access: first.access,
      principalId: 'principal-1',
    });
    expect(replay.originalOutcome).toEqual(firstOutcome.originalOutcome);
    expect(replay.currentProgress).toMatchObject({
      linesAdded: 10,
      linesRemoved: 3,
      tasksToday: 2,
      version: 3,
    });
  });
});
