import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import { resolvePersistedTaskMode } from '../../src/domain/task-mode.js';
import type { StorageEnv } from './storage.js';
import {
  TaskStructureConflictError,
  TaskStructureMutationService,
} from './task-structure-mutations.js';
import {
  activateProtectedPolicies,
  changed,
  unchanged,
  WorkspaceMutationService,
  WorkspaceProtectedFieldConflictError,
} from './workspace-state-mutations.js';
import type { TaskRemovalOwnerParticipant } from './task-removal-owner.js';
import {
  createStandaloneWorkspaceStateStorage,
  type JsonObject,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

let root = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;
let structure: TaskStructureMutationService;

const CREATION_OPERATION_ID = Buffer.alloc(16, 0x11).toString(
  'base64url',
) as TaskCreationOperationId;
const OTHER_CREATION_OPERATION_ID = Buffer.alloc(16, 0x22).toString(
  'base64url',
) as TaskCreationOperationId;

function env(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

async function seedProject(): Promise<void> {
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-project' },
    {
      collapsedTaskOrder: [],
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: [],
      tasks: {},
    },
    undefined,
  );
}

function addRequest(overrides: Partial<Parameters<typeof structure.addTask>[1]> = {}) {
  return {
    baseBranch: 'main',
    branchName: 'task/one',
    gitIsolation: 'worktree' as const,
    name: 'Task one',
    projectId: 'project-1',
    projectMode: 'git' as const,
    projectRoot: '/repo',
    taskId: 'task-1',
    taskMode: 'agent' as const,
    worktreePath: '/repo/.worktrees/task-1',
    ...overrides,
  };
}

function managedAddRequest(
  overrides: Partial<Parameters<typeof structure.addManagedTask>[1]> = {},
) {
  return {
    ...addRequest(),
    agent: {
      agentDef: { command: 'agent', id: 'agent-def-1', name: 'Agent' },
      agentDefId: 'agent-def-1',
      agentId: 'agent-1',
      skipPermissions: false,
    },
    branchPrefixPreference: 'feature',
    creationOperationId: CREATION_OPERATION_ID,
    expectedInitialShellGeneration: 0,
    initialPrompt: { deliveryId: 'delivery-1', text: 'Start here' },
    launchOperationId: 'launch-1',
    sessionId: 'session-1',
    ...overrides,
  };
}

async function activateRemovalOwner(): Promise<void> {
  const privateAuthority = workspace.createPrivateMutationAuthority();
  const participant = (
    id: 'agent-session' | 'initial-prompt' | 'task-runtime',
    hookSetVersion: string,
  ): TaskRemovalOwnerParticipant => ({
    async activateLegacyEffectCutover() {
      if (id !== 'initial-prompt') return;
      await privateAuthority.mutate({ operation: 'test-activate-initial-prompt' }, (slices) =>
        changed(
          {
            nextPrivateState: activateProtectedPolicies(slices.privateState, ['initial-prompt']),
          },
          undefined,
        ),
      );
    },
    async drainTaskForRemoval() {
      return { kind: 'complete' };
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
    async finalizeRemovedTaskState() {
      return { kind: 'complete' };
    },
    hookSetVersion,
    id,
    async probe() {
      return { hookSetVersion, kind: 'ready' };
    },
    async verifyLegacyEffectCutover() {
      if (id !== 'initial-prompt') return;
      await privateAuthority.mutate({ operation: 'test-verify-initial-prompt' }, (slices) => {
        const versions = slices.privateState.protectedWorkspacePolicyVersions as JsonObject;
        if (versions?.['initial-prompt'] !== '1') throw new Error('Prompt protection missing');
        return unchanged(undefined);
      });
    },
  });
  await structure.activateTaskRemovalOwner([
    participant('initial-prompt', 'prompt-hooks-v1'),
    participant('agent-session', 'agent-hooks-v1'),
    participant('task-runtime', 'task-runtime-removal-v1'),
  ]);
}

async function activateManagedWriter(): Promise<void> {
  await activateRemovalOwner();
  await structure.activateManagedTaskCreationWriter({
    async classify(_taskId, task) {
      const taskMode = resolvePersistedTaskMode(task.taskMode);
      if (!taskMode) throw new Error('Invalid task mode');
      return taskMode === 'agent'
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

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-structure-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
  structure = new TaskStructureMutationService(workspace);
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('task structure writer cutover', () => {
  it('activates the pre-managed schema on a brand-new empty workspace', async () => {
    await structure.ensurePreManagedWriterCutover();

    expect((await storage.loadCurrent()).record).toMatchObject({
      privateState: {
        protectedWorkspacePolicyVersions: {
          'creation-writer-epoch': '1',
          'task-identity-location': '1',
          'task-structure': '1',
        },
        taskCreationSchema: { activeWriterEpoch: 'pre-managed-v1' },
      },
      sharedRevision: 0,
      storageGeneration: '1',
    });
  });

  it('atomically stamps extant tasks, activates all structural policies, and is idempotent', async () => {
    await workspace.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed' },
      {
        collapsedTaskOrder: [],
        projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
        taskOrder: ['task-legacy'],
        tasks: {
          'task-legacy': {
            branchName: 'task/legacy',
            id: 'task-legacy',
            name: 'Legacy',
            projectId: 'project-1',
            taskMode: 'agent',
            worktreePath: '/repo/.worktrees/legacy',
          },
        },
      },
      undefined,
    );

    await Promise.all([
      structure.ensurePreManagedWriterCutover(),
      structure.ensurePreManagedWriterCutover(),
    ]);
    const first = await storage.loadCurrent();
    expect(first.record).toMatchObject({
      sharedRevision: 2,
      sharedState: {
        tasks: {
          'task-legacy': {
            taskCreationProvenance: { creationWriterEpoch: 'pre-managed-v1' },
          },
        },
      },
      privateState: {
        protectedWorkspacePolicyVersions: {
          'creation-writer-epoch': '1',
          'task-identity-location': '1',
          'task-structure': '1',
        },
        taskCreationSchema: { activeWriterEpoch: 'pre-managed-v1' },
      },
      storageGeneration: '2',
    });

    const secondStructure = new TaskStructureMutationService(workspace);
    await secondStructure.ensurePreManagedWriterCutover();
    const second = await storage.loadCurrent();
    expect(second.record.sharedRevision).toBe(2);
    expect(second.record.storageGeneration).toBe('2');
  });
});

describe('semantic task structure mutations', () => {
  it('constructs the canonical task backend-side in exactly one workspace commit', async () => {
    await seedProject();
    await structure.ensurePreManagedWriterCutover();

    const result = await structure.addTask(
      { expectedSharedRevision: 1, operation: 'prepared-desktop-task' },
      addRequest({ githubUrl: 'https://example.test/repo', stepsTracking: true }),
    );

    expect(result).toMatchObject({ changed: true, revision: 2, result: { taskId: 'task-1' } });
    expect(result.result.task).toEqual({
      agentDef: null,
      agentId: null,
      baseBranch: 'main',
      branchName: 'task/one',
      gitIsolation: 'worktree',
      githubUrl: 'https://example.test/repo',
      id: 'task-1',
      lastPrompt: '',
      name: 'Task one',
      notes: '',
      projectId: 'project-1',
      shellAgentIds: [],
      shellCount: 0,
      stepsTracking: true,
      taskCreationProvenance: { creationWriterEpoch: 'pre-managed-v1' },
      taskMode: 'agent',
      worktreePath: '/repo/.worktrees/task-1',
    });
    expect((await storage.loadCurrent()).record).toMatchObject({
      sharedRevision: 2,
      sharedState: {
        taskOrder: ['task-1'],
        tasks: { 'task-1': result.result.task },
      },
      storageGeneration: '3',
    });
  });

  it('rechecks the project root before committing and leaves state unchanged on conflict', async () => {
    await seedProject();
    await structure.ensurePreManagedWriterCutover();

    await expect(
      structure.addTask(
        { expectedSharedRevision: 1, operation: 'wrong-root' },
        addRequest({ projectRoot: '/other' }),
      ),
    ).rejects.toBeInstanceOf(TaskStructureConflictError);
    expect((await storage.loadCurrent()).record).toMatchObject({
      sharedRevision: 1,
      storageGeneration: '2',
    });
  });

  it('removes canonical membership once and treats an exact retry as unchanged', async () => {
    await seedProject();
    await structure.ensurePreManagedWriterCutover();
    await structure.addTask({ expectedSharedRevision: 1, operation: 'add' }, addRequest());

    await expect(
      structure.removeTask({ expectedSharedRevision: 2, operation: 'remove' }, 'task-1'),
    ).resolves.toEqual({
      changed: true,
      result: { removed: true, taskId: 'task-1' },
      revision: 3,
    });
    await expect(
      structure.removeTask({ expectedSharedRevision: 3, operation: 'remove-retry' }, 'task-1'),
    ).resolves.toEqual({
      changed: false,
      result: { removed: false, taskId: 'task-1' },
      revision: 3,
    });
    expect((await storage.loadCurrent()).record).toMatchObject({
      sharedRevision: 3,
      sharedState: { collapsedTaskOrder: [], taskOrder: [], tasks: {} },
      storageGeneration: '4',
    });
  });

  it('publishes one durable closing transition through the canonical catalog seam', async () => {
    await seedProject();
    await structure.ensurePreManagedWriterCutover();
    await activateRemovalOwner();
    await structure.addTask({ operation: 'add-before-close' }, addRequest());
    const events: Array<{ closing: boolean; taskId: string }> = [];
    const unsubscribe = structure.subscribeTaskRemovalLifecycle((event) => events.push(event));

    await structure.removeTask({ operation: 'remove-with-lifecycle' }, 'task-1');
    unsubscribe();

    expect(events).toEqual([{ closing: true, taskId: 'task-1' }]);
    expect((await storage.loadCurrent()).record.sharedState).toMatchObject({
      taskOrder: [],
      tasks: {},
    });
  });

  it('fails mutation admission closed before cutover and throughout removal', async () => {
    await seedProject();
    await structure.ensurePreManagedWriterCutover();
    await structure.addTask({ operation: 'add-for-admission' }, addRequest());
    expect(structure.isTaskMutationAdmissionClosed('task-1')).toBe(true);

    await activateRemovalOwner();
    expect(structure.isTaskMutationAdmissionClosed('task-1')).toBe(false);

    const removal = structure.removeTask({ operation: 'remove-for-admission' }, 'task-1');
    await vi.waitFor(() => expect(structure.isTaskMutationAdmissionClosed('task-1')).toBe(true));
    await removal;
    expect(structure.isTaskMutationAdmissionClosed('task-1')).toBe(true);
  });

  it('blocks full-save additions, omissions, order tricks, and same-ID location substitution', async () => {
    await seedProject();
    await structure.ensurePreManagedWriterCutover();
    await structure.addTask({ expectedSharedRevision: 1, operation: 'add' }, addRequest());
    const canonical = (await storage.loadCurrent()).record.sharedState;

    const malicious: JsonObject[] = [
      {
        ...canonical,
        tasks: {
          ...(canonical.tasks as JsonObject),
          'task-forged': { id: 'task-forged' },
        },
      },
      { ...canonical, taskOrder: [], tasks: {} },
      { ...canonical, taskOrder: [] },
      { ...canonical, taskOrder: ['task-1', 'task-1'] },
      {
        ...canonical,
        tasks: {
          'task-1': {
            ...((canonical.tasks as JsonObject)['task-1'] as JsonObject),
            worktreePath: '/forged',
          },
        },
      },
      {
        ...canonical,
        tasks: {
          'task-1': {
            ...((canonical.tasks as JsonObject)['task-1'] as JsonObject),
            taskCreationProvenance: {},
          },
        },
      },
    ];

    for (const [index, proposal] of malicious.entries()) {
      await expect(
        workspace.replaceSharedState(
          { expectedSharedRevision: 2, operation: `malicious-${index}` },
          proposal,
          undefined,
        ),
      ).rejects.toBeInstanceOf(WorkspaceProtectedFieldConflictError);
    }
    expect((await storage.loadCurrent()).record.sharedRevision).toBe(2);
  });
});

describe('managed initial-shell writer cutover', () => {
  it('classifies every historical task, activates the exact policies, and survives restart', async () => {
    await workspace.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed-historical-tasks' },
      {
        collapsedTaskOrder: [],
        projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
        taskOrder: ['agent-task', 'legacy-agent-task', 'terminal-task'],
        tasks: {
          'agent-task': {
            branchName: 'task/agent',
            id: 'agent-task',
            name: 'Agent task',
            projectId: 'project-1',
            taskMode: 'agent',
            worktreePath: '/repo/.worktrees/agent',
          },
          'legacy-agent-task': {
            branchName: 'task/legacy-agent',
            id: 'legacy-agent-task',
            name: 'Legacy agent task',
            projectId: 'project-1',
            worktreePath: '/repo/.worktrees/legacy-agent',
          },
          'terminal-task': {
            branchName: 'task/terminal',
            id: 'terminal-task',
            name: 'Terminal task',
            projectId: 'project-1',
            taskMode: 'terminal',
            worktreePath: '/repo/.worktrees/terminal',
          },
        },
      },
      undefined,
    );
    await structure.ensurePreManagedWriterCutover();
    await activateManagedWriter();

    const snapshot = await storage.loadCurrent();
    expect(snapshot.record).toMatchObject({
      privateState: {
        protectedWorkspacePolicyVersions: {
          'creation-operation-link': '1',
          'creation-writer-epoch': '1',
          'initial-prompt': '1',
          'initial-shell-ownership': '1',
          'task-identity-location': '1',
          'task-structure': '1',
        },
        taskCreationSchema: { activeWriterEpoch: 'managed-initial-shell-v1' },
      },
      sharedState: {
        tasks: {
          'agent-task': {
            taskCreationOperationLink: {
              kind: 'pre-operation-journal',
              migrationSchemaVersion: 1,
            },
            taskCreationProvenance: { creationWriterEpoch: 'pre-managed-v1' },
            taskInitialShellOwnership: {
              kind: 'not-applicable-agent',
              migrationSchemaVersion: 1,
            },
          },
          'legacy-agent-task': {
            taskMode: 'agent',
            taskCreationOperationLink: {
              kind: 'pre-operation-journal',
              migrationSchemaVersion: 1,
            },
            taskCreationProvenance: { creationWriterEpoch: 'pre-managed-v1' },
            taskInitialShellOwnership: {
              kind: 'not-applicable-agent',
              migrationSchemaVersion: 1,
            },
          },
          'terminal-task': {
            taskCreationOperationLink: {
              kind: 'pre-operation-journal',
              migrationSchemaVersion: 1,
            },
            taskCreationProvenance: { creationWriterEpoch: 'pre-managed-v1' },
            taskInitialShellOwnership: {
              kind: 'legacy-unmanaged-terminal',
              migrationSchemaVersion: 1,
            },
          },
        },
      },
    });

    const restarted = new TaskStructureMutationService(workspace);
    await restarted.ensurePreManagedWriterCutover();
    expect((await storage.loadCurrent()).record.storageGeneration).toBe(
      snapshot.record.storageGeneration,
    );
  });

  it('repairs an omitted legacy task mode before verifying an already-managed restart', async () => {
    await workspace.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed-legacy-agent-task' },
      {
        collapsedTaskOrder: [],
        projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            id: 'task-1',
            name: 'Legacy agent task',
            projectId: 'project-1',
            worktreePath: '/repo/.worktrees/task-1',
          },
        },
      },
      undefined,
    );
    await activateManagedWriter();

    const privateAuthority = workspace.createPrivateMutationAuthority();
    await privateAuthority.mutate({ operation: 'simulate-missing-managed-task-mode' }, (slices) => {
      const nextSharedState = structuredClone(slices.sharedState);
      const tasks = nextSharedState.tasks as JsonObject;
      const nextTask = structuredClone(tasks['task-1']) as JsonObject;
      delete nextTask.taskMode;
      tasks['task-1'] = nextTask;
      return changed({ nextSharedState }, undefined);
    });
    const beforeRepair = await storage.loadCurrent();

    const restarted = new TaskStructureMutationService(workspace);
    await restarted.ensurePreManagedWriterCutover();

    const repaired = await storage.loadCurrent();
    expect((repaired.record.sharedState.tasks as JsonObject)['task-1']).toMatchObject({
      taskMode: 'agent',
    });
    expect(BigInt(repaired.record.storageGeneration)).toBe(
      BigInt(beforeRepair.record.storageGeneration) + 1n,
    );
  });

  it('fails closed on an explicit invalid task mode in an already-managed snapshot', async () => {
    await workspace.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed-invalid-restart-task' },
      {
        collapsedTaskOrder: [],
        projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            id: 'task-1',
            name: 'Agent task',
            projectId: 'project-1',
            taskMode: 'agent',
            worktreePath: '/repo/.worktrees/task-1',
          },
        },
      },
      undefined,
    );
    await activateManagedWriter();

    const privateAuthority = workspace.createPrivateMutationAuthority();
    await privateAuthority.mutate({ operation: 'simulate-invalid-managed-task-mode' }, (slices) => {
      const nextSharedState = structuredClone(slices.sharedState);
      const tasks = nextSharedState.tasks as JsonObject;
      const nextTask = structuredClone(tasks['task-1']) as JsonObject;
      nextTask.taskMode = null;
      tasks['task-1'] = nextTask;
      return changed({ nextSharedState }, undefined);
    });

    const restarted = new TaskStructureMutationService(workspace);
    await expect(restarted.ensurePreManagedWriterCutover()).rejects.toThrow(
      'Canonical task task-1 has an invalid execution mode',
    );
  });

  it('commits an agent task, prompt draft, operation mapping, and branch prefix atomically', async () => {
    await seedProject();
    await activateManagedWriter();
    const before = await storage.loadCurrent();
    const result = await structure.addManagedTask(
      { expectedSharedRevision: before.record.sharedRevision, operation: 'managed-agent-create' },
      managedAddRequest(),
    );

    expect(result.changed).toBe(true);
    expect(result.result.task).toMatchObject({
      agentDef: { id: 'agent-def-1' },
      agentId: 'agent-1',
      agentIds: ['agent-1'],
      initialPrompt: 'Start here',
      initialPromptDeliveryId: 'delivery-1',
      initialPromptDeliveryMode: 'automatic',
      selectedAgentId: 'agent-1',
      taskCreationOperationLink: {
        creationOperationId: CREATION_OPERATION_ID,
        kind: 'creation-v1',
        launchOperationId: 'launch-1',
      },
      taskCreationProvenance: { creationWriterEpoch: 'managed-initial-shell-v1' },
      taskInitialShellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
    });
    const after = await storage.loadCurrent();
    expect(after.record.sharedRevision).toBe(before.record.sharedRevision + 1);
    expect(after.record.sharedState).toMatchObject({
      projects: [{ branchPrefix: 'feature', id: 'project-1' }],
      taskOrder: ['task-1'],
      tasks: { 'task-1': result.result.task },
    });

    await expect(
      structure.addManagedTask(
        { expectedSharedRevision: after.record.sharedRevision, operation: 'managed-agent-replay' },
        managedAddRequest(),
      ),
    ).resolves.toMatchObject({ changed: false, revision: after.record.sharedRevision });
  });

  it('writes the exact managed terminal tuple and forbids all agent-only fields', async () => {
    await seedProject();
    await activateManagedWriter();
    const revision = (await storage.loadCurrent()).record.sharedRevision;
    const request = managedAddRequest({
      agent: undefined,
      initialPrompt: undefined,
      taskMode: 'terminal',
    });
    const result = await structure.addManagedTask(
      { expectedSharedRevision: revision, operation: 'managed-terminal-create' },
      request,
    );
    expect(result.result.task).toMatchObject({
      agentDef: null,
      agentId: null,
      shellAgentIds: ['session-1'],
      shellCount: 1,
      taskInitialShellOwnership: {
        expectedGeneration: 0,
        kind: 'managed-terminal-v1',
        launchOperationId: 'launch-1',
        sessionId: 'session-1',
      },
    });
    expect(result.result.task).not.toHaveProperty('initialPrompt');
    await expect(
      structure.addManagedTask(
        { operation: 'invalid-terminal' },
        { ...request, initialPrompt: { deliveryId: 'delivery-2', text: 'invalid' } },
      ),
    ).rejects.toThrow('Terminal task cannot carry agent or prompt fields');
  });

  it('commits trusted coordinator metadata and launch environment in the same task write', async () => {
    await seedProject();
    await activateManagedWriter();
    const result = await structure.addManagedTask(
      { operation: 'managed-coordinator-create' },
      managedAddRequest({
        agent: {
          agentDef: {
            command: 'agent',
            env: { EXISTING: 'preserved' },
            id: 'agent-def-1',
            name: 'Agent',
          },
          agentDefId: 'agent-def-1',
          agentId: 'agent-1',
          skipPermissions: false,
        },
        coordinator: {
          credentialPath: '/private/coordinator/task-1.json',
          runId: 'run-1',
          toolCommand: 'node coordinator-tool.mjs',
        },
      }),
    );

    expect(result.result.task).toMatchObject({
      agentDef: {
        env: {
          EXISTING: 'preserved',
          PARALLEL_CODE_COORDINATOR_CREDENTIAL: '/private/coordinator/task-1.json',
          PARALLEL_CODE_COORDINATOR_RUN_ID: 'run-1',
          PARALLEL_CODE_COORDINATOR_TOOL: 'node coordinator-tool.mjs',
        },
      },
      coordinatorCredentialPath: '/private/coordinator/task-1.json',
      coordinatorRole: 'coordinator',
      coordinatorRunId: 'run-1',
      coordinatorToolCommand: 'node coordinator-tool.mjs',
    });

    await expect(
      structure.addManagedTask(
        { operation: 'coordinator-replay-with-changed-runtime' },
        managedAddRequest({
          agent: undefined,
          coordinator: {
            credentialPath: '/private/coordinator/task-1.json',
            runId: 'run-1',
          },
          initialPrompt: undefined,
          taskMode: 'terminal',
        }),
      ),
    ).rejects.toThrow('Terminal task cannot carry agent or prompt fields');
  });

  it('round-trips agent and terminal tasks on a non-Git project without inventing Git state', async () => {
    await workspace.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed-non-git-project' },
      {
        collapsedTaskOrder: [],
        projects: [{ id: 'project-1', name: 'Folder', path: '/repo', projectMode: 'non-git' }],
        taskOrder: [],
        tasks: {},
      },
      undefined,
    );
    await activateManagedWriter();

    const agent = await structure.addManagedTask(
      { operation: 'managed-non-git-agent-create' },
      managedAddRequest({
        baseBranch: undefined,
        branchName: '',
        gitIsolation: undefined,
        projectMode: 'non-git',
        worktreePath: '/repo',
      }),
    );
    const terminal = await structure.addManagedTask(
      { operation: 'managed-non-git-terminal-create' },
      managedAddRequest({
        agent: undefined,
        baseBranch: undefined,
        branchName: '',
        creationOperationId: OTHER_CREATION_OPERATION_ID,
        gitIsolation: undefined,
        initialPrompt: undefined,
        launchOperationId: 'launch-2',
        projectMode: 'non-git',
        sessionId: 'session-2',
        taskId: 'task-2',
        taskMode: 'terminal',
        worktreePath: '/repo',
      }),
    );

    expect(agent.result.task).toMatchObject({
      branchName: '',
      projectMode: 'non-git',
      taskMode: 'agent',
      worktreePath: '/repo',
    });
    expect(terminal.result.task).toMatchObject({
      branchName: '',
      projectMode: 'non-git',
      taskMode: 'terminal',
      worktreePath: '/repo',
    });
    expect(agent.result.task).not.toHaveProperty('baseBranch');
    expect(agent.result.task).not.toHaveProperty('gitIsolation');
    expect(terminal.result.task).not.toHaveProperty('baseBranch');
    expect(terminal.result.task).not.toHaveProperty('gitIsolation');

    await expect(
      structure.addManagedTask(
        { operation: 'invalid-non-git-branch' },
        managedAddRequest({
          baseBranch: undefined,
          gitIsolation: undefined,
          projectMode: 'non-git',
          taskId: 'task-3',
          worktreePath: '/repo',
        }),
      ),
    ).rejects.toThrow('Non-git tasks cannot carry Git location fields');
    await expect(
      structure.addManagedTask(
        { operation: 'invalid-git-branch' },
        managedAddRequest({ branchName: '', taskId: 'task-4' }),
      ),
    ).rejects.toThrow('Git tasks require a canonical branch name');
  });

  it('rejects contradictory migration evidence without switching the host epoch', async () => {
    await workspace.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed-terminal' },
      {
        collapsedTaskOrder: [],
        projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
        taskOrder: ['terminal-task'],
        tasks: {
          'terminal-task': {
            branchName: 'task/terminal',
            id: 'terminal-task',
            name: 'Terminal',
            projectId: 'project-1',
            taskMode: 'terminal',
            worktreePath: '/repo/.worktrees/terminal',
          },
        },
      },
      undefined,
    );
    await structure.ensurePreManagedWriterCutover();
    await activateRemovalOwner();
    await expect(
      structure.activateManagedTaskCreationWriter({
        async classify() {
          return {
            operationLink: { kind: 'pre-operation-journal', migrationSchemaVersion: 1 },
            shellOwnership: { kind: 'not-applicable-agent', migrationSchemaVersion: 1 },
          };
        },
      }),
    ).rejects.toThrow('Terminal task has agent shell ownership evidence');
    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      taskCreationSchema: { activeWriterEpoch: 'pre-managed-v1' },
    });
  });

  it('disables the temporary prepared-task adapter at the managed writer boundary', async () => {
    await seedProject();
    await activateManagedWriter();
    await expect(structure.addTask({ operation: 'legacy-create' }, addRequest())).rejects.toThrow(
      'Prepared task creation does not support writer epoch managed-initial-shell-v1',
    );
  });
});
