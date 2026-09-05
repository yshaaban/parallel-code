import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import { TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION } from '../../src/domain/task-removal-owner.js';
import {
  TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveTaskInitialPromptDraftFingerprint,
} from '../../src/domain/task-initial-prompt-delivery.js';
import type { StorageEnv } from './storage.js';
import { createTaskInitialPromptRemovalParticipant } from './task-initial-prompt-removal-participant.js';
import {
  createTaskInitialPromptDeliveryService,
  type TaskInitialPromptDeliveryDependencies,
} from './task-initial-prompt-delivery.js';
import { createWorkspaceTaskInitialPromptPersistence } from './task-initial-prompt-delivery-persistence.js';
import type {
  TaskRemovalCleanupStepRequest,
  TaskRemovalCleanupStepResult,
  TaskRemovalOwnerParticipant,
  TaskRemovalParticipantStepResult,
} from './task-removal-owner.js';
import { WorkspaceTaskRemovalLegacyWriterGate } from './task-removal-legacy-writer-gate.js';
import { TaskStructureMutationService } from './task-structure-mutations.js';
import { WorkspaceMutationService } from './workspace-state-mutations.js';
import {
  createStandaloneWorkspaceStateStorage,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

let root = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;
let structure: TaskStructureMutationService;

function env(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

async function seedTask(promptField: 'none' | 'saved' = 'none'): Promise<void> {
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
          projectId: 'project-1',
          ...(promptField === 'saved' ? { savedInitialPrompt: 'Ship this safely' } : {}),
          taskMode: 'agent',
          worktreePath: '/repo/.worktrees/task-1',
        },
      },
    },
    undefined,
  );
  await structure.ensurePreManagedWriterCutover();
}

async function seedNonGitTask(taskMode: 'agent' | 'terminal'): Promise<void> {
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: `seed-non-git-${taskMode}` },
    {
      collapsedTaskOrder: [],
      projects: [
        {
          id: 'project-1',
          name: 'Project',
          path: '/repo',
          projectMode: 'non-git',
        },
      ],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          agentId: taskMode === 'agent' ? 'agent-1' : null,
          branchName: '',
          id: 'task-1',
          name: 'Root task',
          projectId: 'project-1',
          projectMode: 'non-git',
          shellAgentIds: taskMode === 'terminal' ? ['shell-1'] : [],
          taskMode,
          worktreePath: '/repo',
        },
      },
    },
    undefined,
  );
  await structure.ensurePreManagedWriterCutover();
}

async function seedRootBackedGitTask(taskMode: 'agent' | 'terminal'): Promise<void> {
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: `seed-root-git-${taskMode}` },
    {
      collapsedTaskOrder: [],
      projects: [{ deleteBranchOnClose: true, id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: ['task-1', 'root-peer'],
      tasks: {
        'root-peer': {
          agentId: 'peer-agent',
          branchName: 'feature/root-task',
          gitIsolation: 'current-branch',
          id: 'root-peer',
          name: 'Parallel root agent',
          projectId: 'project-1',
          taskMode: 'agent',
          worktreePath: '/repo',
        },
        'task-1': {
          agentId: taskMode === 'agent' ? 'agent-1' : null,
          branchName: 'feature/root-task',
          gitIsolation: 'current-branch',
          id: 'task-1',
          name: 'Root task',
          projectId: 'project-1',
          shellAgentIds: taskMode === 'terminal' ? ['shell-1'] : [],
          taskMode,
          worktreePath: '/repo',
        },
      },
    },
    undefined,
  );
  await structure.ensurePreManagedWriterCutover();
}

function createParticipant(
  id: 'agent-session' | 'initial-prompt' | 'task-runtime',
  options: {
    activate?: (epoch: string) => Promise<void>;
    cleanupStep?: (request: TaskRemovalCleanupStepRequest) => Promise<TaskRemovalCleanupStepResult>;
    drain?: () => Promise<TaskRemovalParticipantStepResult>;
    finalize?: () => Promise<TaskRemovalParticipantStepResult>;
    probe?: () => Promise<'ready' | 'unavailable'>;
    verify?: (epoch: string) => Promise<void>;
  } = {},
): TaskRemovalOwnerParticipant {
  const hookSetVersion =
    id === 'agent-session'
      ? AGENT_SESSION_OWNER_HOOK_SET_VERSION
      : id === 'initial-prompt'
        ? TASK_INITIAL_PROMPT_HOOK_SET_VERSION
        : TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION;
  return {
    activateLegacyEffectCutover: options.activate ?? (async () => undefined),
    drainTaskForRemoval: options.drain ?? (async () => ({ kind: 'complete' as const })),
    ...(id === 'task-runtime'
      ? {
          async cleanupTaskRuntimeStep(request) {
            if (options.cleanupStep) return options.cleanupStep(request);
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
    async probe() {
      const result = await (options.probe?.() ?? Promise.resolve('ready'));
      return result === 'ready'
        ? { hookSetVersion, kind: 'ready' }
        : { hookSetVersion, kind: 'unavailable', reason: 'journal-unavailable' };
    },
    verifyLegacyEffectCutover: options.verify ?? (async () => undefined),
  };
}

function withTaskRuntime(
  ...participants: TaskRemovalOwnerParticipant[]
): TaskRemovalOwnerParticipant[] {
  return [...participants, createParticipant('task-runtime')];
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-removal-cutover-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
  structure = new TaskStructureMutationService(workspace, {
    removalOwner: {
      createCutoverEpoch: () => 'removal-cutover-epoch-1',
      createDeletionOperationId: () => 'deletion-operation-1',
      serverInstanceId: 'server-instance-1',
    },
  });
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('generic task-removal owner cutover', () => {
  it('publishes one exact epoch only after both dark owners disable and verify legacy effects', async () => {
    await seedTask();
    const calls: string[] = [];
    let assertOriginalOwnerDark = true;
    const prompt = createParticipant('initial-prompt', {
      activate: async (epoch) => {
        calls.push(`prompt-activate:${epoch}`);
        if (assertOriginalOwnerDark) expect(structure.getTaskRemovalOwnerCapability()).toBeNull();
      },
      verify: async (epoch) => {
        calls.push(`prompt-verify:${epoch}`);
      },
    });
    const session = createParticipant('agent-session', {
      activate: async (epoch) => {
        calls.push(`session-activate:${epoch}`);
        if (assertOriginalOwnerDark) expect(structure.getTaskRemovalOwnerCapability()).toBeNull();
      },
      verify: async (epoch) => {
        calls.push(`session-verify:${epoch}`);
      },
    });
    const promptGate = structure.createTaskRemovalParticipantGate(
      'initial-prompt',
      TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    );
    expect(promptGate.getTaskSnapshot('task-1')).toEqual({ kind: 'unavailable' });

    await expect(
      structure.activateTaskRemovalOwner(withTaskRuntime(prompt, session)),
    ).resolves.toEqual({
      cutoverEpoch: 'removal-cutover-epoch-1',
      hookSetVersions: {
        'agent-session': AGENT_SESSION_OWNER_HOOK_SET_VERSION,
        'initial-prompt': TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        'task-runtime': TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
      },
      kind: 'active',
      schemaVersion: 1,
    });
    expect(calls).toEqual([
      'prompt-activate:removal-cutover-epoch-1',
      'session-activate:removal-cutover-epoch-1',
      'prompt-verify:removal-cutover-epoch-1',
      'session-verify:removal-cutover-epoch-1',
    ]);
    expect(promptGate.getTaskSnapshot('task-1')).toMatchObject({
      current: { taskClosing: false, taskState: 'present' },
      cutoverEpoch: 'removal-cutover-epoch-1',
      hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
      kind: 'active',
    });
    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      taskRemovalOwnerSchema: {
        cutoverEpoch: 'removal-cutover-epoch-1',
        hookSetVersions: {
          'agent-session': AGENT_SESSION_OWNER_HOOK_SET_VERSION,
          'initial-prompt': TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
          'task-runtime': TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION,
        },
        legacyEffectsDisabled: true,
        phase: 'active',
        schemaVersion: 1,
      },
    });

    const restarted = new TaskStructureMutationService(workspace, {
      removalOwner: {
        createCutoverEpoch: () => 'must-not-replace-persisted-epoch',
        serverInstanceId: 'server-instance-2',
      },
    });
    assertOriginalOwnerDark = false;
    await restarted.ensurePreManagedWriterCutover();
    await expect(
      restarted.activateTaskRemovalOwner(withTaskRuntime(session, prompt)),
    ).resolves.toMatchObject({
      cutoverEpoch: 'removal-cutover-epoch-1',
      kind: 'active',
    });
    expect(
      restarted
        .createTaskRemovalParticipantGate('initial-prompt', TASK_INITIAL_PROMPT_HOOK_SET_VERSION)
        .getTaskSnapshot('task-1'),
    ).toMatchObject({
      current: { serverInstanceId: 'server-instance-2', taskState: 'present' },
      cutoverEpoch: 'removal-cutover-epoch-1',
      kind: 'active',
    });
  });

  it('retains the preparing epoch and keeps structural admission paused after a callback failure', async () => {
    await seedTask();
    let shouldFail = true;
    const epochs: string[] = [];
    const prompt = createParticipant('initial-prompt', {
      activate: async (epoch) => {
        epochs.push(epoch);
        if (shouldFail) throw new Error('prompt cutover failed');
      },
    });
    const session = createParticipant('agent-session');

    await expect(
      structure.activateTaskRemovalOwner(withTaskRuntime(session, prompt)),
    ).rejects.toThrow('prompt cutover failed');
    expect(structure.getTaskRemovalOwnerCapability()).toBeNull();
    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      taskRemovalOwnerSchema: {
        cutoverEpoch: 'removal-cutover-epoch-1',
        legacyEffectsDisabled: false,
        phase: 'preparing',
      },
    });
    await expect(
      structure.removeTask({ expectedSharedRevision: 2, operation: 'must-stay-paused' }, 'task-1'),
    ).rejects.toThrow('Task structure admission is paused');

    shouldFail = false;
    await structure.activateTaskRemovalOwner(withTaskRuntime(session, prompt));
    expect(epochs).toEqual(['removal-cutover-epoch-1', 'removal-cutover-epoch-1']);
    expect(structure.getTaskRemovalOwnerCapability()).toMatchObject({
      cutoverEpoch: 'removal-cutover-epoch-1',
      kind: 'active',
    });
  });

  it('persists closing before drains, commits absence before finalizers, and replays without effects', async () => {
    await seedTask();
    const effects: string[] = [];
    const sessionGate = structure.createTaskRemovalParticipantGate(
      'agent-session',
      AGENT_SESSION_OWNER_HOOK_SET_VERSION,
    );
    const promptGate = structure.createTaskRemovalParticipantGate(
      'initial-prompt',
      TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    );
    const session = createParticipant('agent-session', {
      drain: async () => {
        effects.push('session-drain');
        expect(sessionGate.getTaskSnapshot('task-1')).toMatchObject({
          current: { taskClosing: true, taskState: 'present' },
        });
        return { kind: 'complete' };
      },
      finalize: async () => {
        effects.push('session-finalize');
        expect(
          sessionGate.verifyCommittedRemoval({
            deletionOperationId: 'deletion-operation-1',
            taskId: 'task-1',
          }),
        ).toBe(true);
        expect((await storage.loadCurrent()).record.sharedState).toMatchObject({ tasks: {} });
        return { kind: 'complete' };
      },
    });
    const prompt = createParticipant('initial-prompt', {
      drain: async () => {
        effects.push('prompt-drain');
        expect(promptGate.getTaskSnapshot('task-1')).toMatchObject({
          current: { taskClosing: true, taskState: 'present' },
        });
        return { kind: 'complete' };
      },
      finalize: async () => {
        effects.push('prompt-finalize');
        expect(
          promptGate.verifyCommittedRemoval({
            deletionOperationId: 'deletion-operation-1',
            taskId: 'task-1',
          }),
        ).toBe(true);
        return { kind: 'complete' };
      },
    });
    await structure.activateTaskRemovalOwner(withTaskRuntime(prompt, session));

    await expect(
      structure.removeTask({ expectedSharedRevision: 2, operation: 'remove-task' }, 'task-1'),
    ).resolves.toEqual({
      changed: true,
      result: {
        deletionOperationId: 'deletion-operation-1',
        removed: true,
        removalState: 'complete',
        taskId: 'task-1',
      },
      revision: 3,
    });
    expect(effects).toEqual([
      'session-drain',
      'prompt-drain',
      'session-finalize',
      'prompt-finalize',
    ]);
    expect(promptGate.getTaskSnapshot('task-1')).toMatchObject({
      current: { taskClosing: false, taskState: 'removed' },
    });

    await expect(
      structure.removeTask({ expectedSharedRevision: 3, operation: 'remove-replay' }, 'task-1'),
    ).resolves.toMatchObject({ changed: false, result: { removed: false }, revision: 3 });
    expect(effects).toHaveLength(4);
    await expect(
      structure.addTask(
        { expectedSharedRevision: 3, operation: 'forbid-task-id-reuse' },
        {
          baseBranch: 'main',
          branchName: 'task/reused',
          gitIsolation: 'worktree',
          name: 'Reused task',
          projectId: 'project-1',
          projectMode: 'git',
          projectRoot: '/repo',
          taskId: 'task-1',
          taskMode: 'agent',
          worktreePath: '/repo/.worktrees/reused-task-1',
        },
      ),
    ).rejects.toThrow('durable removal history');
  });

  it('retains ordered finalizer repair and never repeats the runners drain', async () => {
    await seedTask();
    let failSessionFinalizer = true;
    const sessionDrain = vi.fn(async () => ({ kind: 'complete' as const }));
    const promptDrain = vi.fn(async () => ({ kind: 'complete' as const }));
    const sessionFinalize = vi.fn(async () =>
      failSessionFinalizer
        ? ({ kind: 'retry-required', reason: 'journal-unavailable' } as const)
        : ({ kind: 'complete' } as const),
    );
    const promptFinalize = vi.fn(async () => ({ kind: 'complete' as const }));
    await structure.activateTaskRemovalOwner(
      withTaskRuntime(
        createParticipant('agent-session', {
          drain: sessionDrain,
          finalize: sessionFinalize,
        }),
        createParticipant('initial-prompt', {
          drain: promptDrain,
          finalize: promptFinalize,
        }),
      ),
    );

    await expect(
      structure.removeTask({ expectedSharedRevision: 2, operation: 'remove-task' }, 'task-1'),
    ).resolves.toMatchObject({
      changed: true,
      result: {
        pendingFinalizers: ['agent-session', 'initial-prompt', 'task-runtime'],
        removalState: 'finalizer-repair-pending',
      },
      revision: 3,
    });
    expect(sessionDrain).toHaveBeenCalledTimes(1);
    expect(promptDrain).toHaveBeenCalledTimes(1);
    expect(promptFinalize).not.toHaveBeenCalled();

    failSessionFinalizer = false;
    const repaired = await structure.repairTaskRemoval('task-1');
    expect(repaired).toMatchObject({ removalState: 'complete' });
    expect(repaired).not.toHaveProperty('pendingFinalizers');
    expect(sessionDrain).toHaveBeenCalledTimes(1);
    expect(promptDrain).toHaveBeenCalledTimes(1);
    expect(sessionFinalize).toHaveBeenCalledTimes(2);
    expect(promptFinalize).toHaveBeenCalledTimes(1);
  });

  it('drains an admitted legacy removal before cutover and never strands partial cleanup', async () => {
    await seedTask();
    const gate = new WorkspaceTaskRemovalLegacyWriterGate();
    let releaseLegacyEffect: (() => void) | undefined;
    const legacyEffectStarted = new Promise<void>((resolve) => {
      releaseLegacyEffect = resolve;
    });
    let allowLegacyEffectToFinish: (() => void) | undefined;
    const legacyEffectBlocked = new Promise<void>((resolve) => {
      allowLegacyEffectToFinish = resolve;
    });
    const legacyEffect = vi.fn(async () => {
      releaseLegacyEffect?.();
      await legacyEffectBlocked;
      return 'legacy-cleaned';
    });
    const taskRuntimeActivate = vi.fn((epoch: string) => gate.disableLegacyRemovalWriters(epoch));
    const taskRuntimeVerify = vi.fn((epoch: string) =>
      gate.verifyLegacyRemovalWritersDisabled(epoch),
    );

    const removal = structure.removeTaskWithLegacyFallback(
      { operation: 'legacy-removal-at-cutover' },
      'task-1',
      () => gate.runLegacyRemoval(legacyEffect),
    );
    await legacyEffectStarted;
    const activation = structure.activateTaskRemovalOwner([
      createParticipant('initial-prompt'),
      createParticipant('agent-session'),
      createParticipant('task-runtime', {
        activate: taskRuntimeActivate,
        verify: taskRuntimeVerify,
      }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(taskRuntimeActivate).not.toHaveBeenCalled();
    expect((await storage.loadCurrent()).record.sharedState).toMatchObject({
      taskOrder: ['task-1'],
      tasks: { 'task-1': expect.anything() },
    });

    allowLegacyEffectToFinish?.();
    await expect(removal).resolves.toMatchObject({
      effectResult: 'legacy-cleaned',
      kind: 'legacy-fallback',
      removal: { result: { removed: true, taskId: 'task-1' } },
    });
    await expect(activation).resolves.toMatchObject({ kind: 'active' });
    expect(legacyEffect).toHaveBeenCalledTimes(1);
    expect(taskRuntimeActivate).toHaveBeenCalledWith('removal-cutover-epoch-1');
    expect(taskRuntimeVerify).toHaveBeenCalledWith('removal-cutover-epoch-1');
    expect((await storage.loadCurrent()).record.sharedState).toMatchObject({
      taskOrder: [],
      tasks: {},
    });
  });

  it('restarts at the first unfinished cleanup step without repeating durable effects', async () => {
    await seedTask();
    const steps: string[] = [];
    let failContainers = true;
    const cleanupStep = async (
      request: TaskRemovalCleanupStepRequest,
    ): Promise<TaskRemovalCleanupStepResult> => {
      steps.push(request.step);
      if (request.step === 'containers' && failContainers) {
        return { kind: 'retry-required', reason: 'container-runtime-unavailable' };
      }
      return {
        evidence: { completedBy: request.step },
        kind: 'step-complete',
        step: request.step,
      };
    };
    await structure.activateTaskRemovalOwner([
      createParticipant('initial-prompt'),
      createParticipant('agent-session'),
      createParticipant('task-runtime', { cleanupStep }),
    ]);

    await expect(
      structure.removeTask({ operation: 'remove-before-restart' }, 'task-1'),
    ).resolves.toMatchObject({
      result: { removed: false, removalState: 'cleanup-pending' },
    });
    expect(steps).toEqual(['runners', 'containers']);
    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      taskRemovalOperations: {
        recordsByDeletionOperationId: {
          'deletion-operation-1': {
            cleanupStepEvidence: { runners: { completedBy: 'runners' } },
            completedCleanupSteps: ['runners'],
            phase: 'reserved-before-cleanup',
          },
        },
      },
    });

    failContainers = false;
    const restarted = new TaskStructureMutationService(workspace, {
      removalOwner: {
        createCutoverEpoch: () => 'must-reuse-cutover',
        createDeletionOperationId: () => 'must-reuse-deletion-operation',
        serverInstanceId: 'server-instance-after-restart',
      },
    });
    await restarted.activateTaskRemovalOwner([
      createParticipant('initial-prompt'),
      createParticipant('agent-session'),
      createParticipant('task-runtime', { cleanupStep }),
    ]);
    await expect(
      restarted.removeTask({ operation: 'remove-after-restart' }, 'task-1'),
    ).resolves.toMatchObject({
      result: { removed: true, removalState: 'complete' },
    });
    expect(steps).toEqual([
      'runners',
      'containers',
      'containers',
      'runtime-state',
      'coordinator',
      'worktree-quarantine',
      'branch-release',
      'shell-prepare',
    ]);
    expect((await storage.loadCurrent()).record.sharedState).toMatchObject({ tasks: {} });
  });

  it.each(['terminal', 'agent'] as const)(
    'removes and replays a root-backed non-git %s task without invoking Git cleanup',
    async (taskMode) => {
      await seedNonGitTask(taskMode);
      const requests: TaskRemovalCleanupStepRequest[] = [];
      const cleanupStep = async (
        request: TaskRemovalCleanupStepRequest,
      ): Promise<TaskRemovalCleanupStepResult> => {
        requests.push(structuredClone(request));
        return {
          evidence: { completedBy: request.step },
          kind: 'step-complete',
          step: request.step,
        };
      };
      const participants = [
        createParticipant('initial-prompt'),
        createParticipant('agent-session'),
        createParticipant('task-runtime', { cleanupStep }),
      ];
      await structure.activateTaskRemovalOwner(participants);

      await expect(
        structure.removeTask({ operation: `remove-non-git-${taskMode}` }, 'task-1'),
      ).resolves.toMatchObject({
        result: { removed: true, removalState: 'complete' },
      });
      expect(requests.map((request) => request.step)).toEqual([
        'runners',
        'containers',
        'runtime-state',
        'coordinator',
        'shell-prepare',
      ]);
      expect(requests[0]?.cleanupPlan).toMatchObject({
        branchName: '',
        deleteBranch: false,
        gitCleanup: 'preserve',
        launchOperationId: null,
        projectMode: 'non-git',
        projectRoot: '/repo',
        quarantinePath: null,
        taskMode,
        worktreePath: '/repo',
      });
      expect(requests.map((request) => request.step)).not.toContain('worktree-quarantine');
      expect(requests.map((request) => request.step)).not.toContain('branch-release');

      const restarted = new TaskStructureMutationService(workspace, {
        removalOwner: { serverInstanceId: `restarted-${taskMode}` },
      });
      await restarted.activateTaskRemovalOwner(participants);
      await expect(
        restarted.removeTask({ operation: `replay-non-git-${taskMode}` }, 'task-1'),
      ).resolves.toMatchObject({
        changed: false,
        result: { removed: false, removalState: 'complete' },
      });
      expect(requests).toHaveLength(5);
    },
  );

  it.each(['terminal', 'agent'] as const)(
    'preserves Git while removing a canonical root-backed %s task',
    async (taskMode) => {
      await seedRootBackedGitTask(taskMode);
      const requests: TaskRemovalCleanupStepRequest[] = [];
      const cleanupStep = async (
        request: TaskRemovalCleanupStepRequest,
      ): Promise<TaskRemovalCleanupStepResult> => {
        requests.push(structuredClone(request));
        return {
          evidence: { completedBy: request.step },
          kind: 'step-complete',
          step: request.step,
        };
      };
      await structure.activateTaskRemovalOwner([
        createParticipant('initial-prompt'),
        createParticipant('agent-session'),
        createParticipant('task-runtime', { cleanupStep }),
      ]);

      await expect(
        structure.removeTask({ operation: `remove-root-git-${taskMode}` }, 'task-1'),
      ).resolves.toMatchObject({ result: { removed: true, removalState: 'complete' } });
      expect(requests.map((request) => request.step)).toEqual([
        'runners',
        'containers',
        'runtime-state',
        'coordinator',
        'shell-prepare',
      ]);
      expect(requests[0]?.cleanupPlan).toMatchObject({
        branchName: 'feature/root-task',
        deleteBranch: false,
        gitCleanup: 'preserve',
        projectMode: 'git',
        projectRoot: '/repo',
        quarantinePath: null,
        taskMode,
        worktreePath: '/repo',
      });
      expect(requests[0]?.cleanupPlan.agentIds).not.toContain('peer-agent');
      expect((await storage.loadCurrent()).record.sharedState).toMatchObject({
        taskOrder: ['root-peer'],
        tasks: { 'root-peer': { agentId: 'peer-agent', worktreePath: '/repo' } },
      });
    },
  );
});

describe('D01-owned prompt protection in the shared cutover', () => {
  it('migrates/protects through the dark callback and retains the journal until committed finalization', async () => {
    await seedTask('saved');
    const persistence = createWorkspaceTaskInitialPromptPersistence(workspace);
    await persistence.ensureDarkJournalReady();
    const fingerprint = deriveTaskInitialPromptDraftFingerprint({
      agentId: 'agent-1',
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
      text: 'Ship this safely',
    });
    await persistence.journal.save({
      automationSealed: false,
      draftEditRevision: 0,
      expectedDraftFingerprint: fingerprint,
      request: {
        agentId: 'agent-1',
        deliveryId: 'delivery-1',
        expectedDraftFingerprint: fingerprint,
        readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
        taskId: 'task-1',
      },
      schemaVersion: 1,
      snapshot: {
        agentId: 'agent-1',
        attempts: 0,
        createdAt: '2026-08-04T00:00:00.000Z',
        deliveryId: 'delivery-1',
        status: 'waiting-agent-session',
        taskId: 'task-1',
        updatedAt: '2026-08-04T00:00:00.000Z',
        version: 1,
      },
      writeBegan: false,
    });
    const promptGate = structure.createTaskRemovalParticipantGate(
      'initial-prompt',
      TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    );
    const acquireCommandLease = vi.fn(async () => {
      throw new Error('C5 must not acquire a prompt lease');
    });
    const admitPrompt = vi.fn(async () => {
      throw new Error('C5 must not dispatch prompt bytes');
    });
    const dependencies: TaskInitialPromptDeliveryDependencies = {
      acquireCommandLease,
      admitPrompt,
      draftRepository: persistence.repository,
      getAgentRuntime: () => null,
      getOwnerAvailability: () => ({ kind: 'dark', reason: 'delivery-owner-dark' }),
      journal: persistence.journal,
      removalGate: promptGate,
    };
    const service = createTaskInitialPromptDeliveryService(dependencies);
    const prompt = createTaskInitialPromptRemovalParticipant({ persistence, service });
    const session = createParticipant('agent-session');

    const capability = await structure.activateTaskRemovalOwner(withTaskRuntime(session, prompt));
    let record = (await storage.loadCurrent()).record;
    expect(record.sharedState).toMatchObject({
      tasks: {
        'task-1': {
          initialPrompt: 'Ship this safely',
          initialPromptDeliveryMode: 'automatic',
        },
      },
    });
    expect(record.sharedState).not.toMatchObject({
      tasks: { 'task-1': { savedInitialPrompt: expect.anything() } },
    });
    expect(record.privateState).toMatchObject({
      initialPromptDeliveryOwnerSchema: {
        cutoverEpoch: capability.cutoverEpoch,
        hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
        legacyWritersDisabled: true,
      },
      protectedWorkspacePolicyVersions: { 'initial-prompt': '1' },
      taskRemovalOwnerSchema: {
        cutoverEpoch: capability.cutoverEpoch,
        legacyEffectsDisabled: true,
        phase: 'active',
      },
    });
    await expect(
      service.queue({
        agentId: 'agent-1',
        deliveryId: 'delivery-1',
        expectedDraftFingerprint: fingerprint,
        readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
        taskId: 'task-1',
      }),
    ).resolves.toMatchObject({ kind: 'admission-unavailable', reason: 'delivery-owner-dark' });
    expect(acquireCommandLease).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();

    await expect(persistence.journal.listTaskRecords('task-1')).resolves.toHaveLength(1);
    await structure.removeTask(
      { expectedSharedRevision: record.sharedRevision, operation: 'remove-prompt-task' },
      'task-1',
    );
    record = (await storage.loadCurrent()).record;
    expect(record.sharedState).toMatchObject({ tasks: {} });
    await expect(persistence.journal.listTaskRecords('task-1')).resolves.toHaveLength(0);
    expect(acquireCommandLease).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });
});
