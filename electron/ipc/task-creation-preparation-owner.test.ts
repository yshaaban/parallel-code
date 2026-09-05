import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskCreationIntent } from '../../src/domain/task-creation.js';
import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import type { AgentDef } from '../../src/ipc/types.js';
import {
  deriveTaskCreationConflictKey,
  taskCreationConflictKeyId,
  type TaskCreationJournalRecord,
  type TaskCreationJournalReconciliationState,
} from './task-creation-journal.js';
import {
  createProductionTaskCreationPreparationOwner,
  type ProductionTaskCreationPreparationAdapters,
} from './task-creation-preparation-owner.js';
import type { TaskCreationAllocatedIdentities } from './task-creation-workflow.js';
import { getManagedWorktreeRecoveryQuarantinePath } from './task-worktree-removal.js';
import { planManagedTaskLocation } from './tasks.js';
import { withRepositoryWorktreeLock } from './git-worktree-lock.js';
import {
  hasPreparedSharedRootTask,
  resetPreparedSharedRootTasksForTests,
} from './task-shared-root-admission.js';
import { WorkspaceMutationService } from './workspace-state-mutations.js';
import {
  createStandaloneWorkspaceStateStorage,
  type JsonObject,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

let root = '';
let projectRoot = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;

const OPERATION_ID = Buffer.alloc(16, 0x11).toString('base64url') as TaskCreationOperationId;
const OTHER_OPERATION_ID = Buffer.alloc(16, 0x22).toString('base64url') as TaskCreationOperationId;

const agentDefinition: AgentDef = {
  args: [],
  command: 'safe-agent',
  description: 'Safe test agent',
  id: 'safe-agent',
  name: 'Safe Agent',
  resume_args: [],
  resume_strategy: 'none',
  skip_permissions_args: ['--unsafe-test-only'],
};

const identities: TaskCreationAllocatedIdentities = {
  agentId: 'agent-1',
  deliveryId: null,
  launchOperationId: 'launch-1',
  sessionId: 'agent-1',
  taskId: 'task-1',
};

function operationResourceId(operationId: string, resource: string): string {
  return `p_${createHmac('sha256', operationId).update(resource, 'utf8').digest('base64url').slice(0, 32)}`;
}

function reconciliationRecord(
  reconciliation: TaskCreationJournalReconciliationState,
  conflictKeys: TaskCreationJournalRecord['activeConflictKeys'],
): TaskCreationJournalRecord {
  return {
    activeConflictKeys: conflictKeys,
    capabilityHash: 'a'.repeat(64),
    commit: { kind: 'not-committed' },
    conflictKeys,
    createdAtMs: 100,
    formatVersion: 1,
    identities,
    issueCode: 'manual-reconciliation-required',
    operationId: OPERATION_ID,
    phase: 'manual-reconciliation-required',
    reconciliation,
    recordVersion: 1,
    retention: { kind: 'nonterminal' },
    semanticFingerprint: 'b'.repeat(64),
    taskMode: 'terminal',
    updatedAtMs: 100,
    warning: { warningReservationBytes: 0 },
    workspacePrincipalHash: 'c'.repeat(64),
  };
}

function intent(overrides: Partial<TaskCreationIntent> = {}): TaskCreationIntent {
  return {
    launch: { kind: 'terminal' },
    location: { kind: 'project-root' },
    name: 'Test task',
    operationCapability: 'capability' as TaskCreationIntent['operationCapability'],
    operationId: OPERATION_ID,
    operationTicket: 'ticket',
    projectId: 'project-1',
    stepsTracking: false,
    ...overrides,
  };
}

async function seedProject(mode: 'git' | 'non-git' = 'git', extra: JsonObject = {}): Promise<void> {
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-project' },
    {
      collapsedTaskOrder: [],
      projects: [
        {
          baseBranch: 'main',
          branchPrefix: 'feature',
          id: 'project-1',
          name: 'Project',
          path: projectRoot,
          ...(mode === 'non-git' ? { projectMode: 'non-git' } : {}),
        },
      ],
      taskOrder: [],
      tasks: {},
      ...extra,
    },
    undefined,
  );
}

function createAdapters() {
  let preparedLocation: { branchName: string; worktreePath: string } | null = null;
  const createManaged = vi.fn<
    ProductionTaskCreationPreparationAdapters['createPlannedManagedTask']
  >(async (_root, location) => {
    preparedLocation = { ...location };
    fs.mkdirSync(location.worktreePath, { recursive: true });
    return {
      branch_name: location.branchName,
      git_isolation: 'worktree',
      symlink_warnings: [{ message: 'Not linked', name: '.env', reason: 'source_missing' }],
      worktree_path: location.worktreePath,
    };
  });
  const adapters: Partial<ProductionTaskCreationPreparationAdapters> = {
    createCurrentBranchTask: vi.fn(async (rootPath, baseBranch) => ({
      base_branch: baseBranch ?? 'main',
      branch_name: baseBranch ?? 'main',
      git_isolation: 'current-branch' as const,
      id: 'discarded-low-level-id',
      worktree_path: rootPath,
    })),
    createPlannedManagedTask: createManaged,
    getAgentDefinitions: () => [structuredClone(agentDefinition)],
    getGitRepoRoot: vi.fn(async (candidate) => candidate),
    getWorktreeSymlinkCandidates: vi.fn(async () => ({
      candidates: [{ isDefault: true, name: '.env' }],
      truncated: false,
    })),
    listBranches: vi.fn(async () => ({
      branches: Array.from({ length: 60 }, (_, index) => ({
        current: index === 0,
        local: true,
        name: index === 0 ? 'main' : `feature-${index}`,
        remote: false,
      })),
      defaultBranch: 'main',
      generatedAt: 1,
    })),
    listGitWorktrees: vi.fn(async () =>
      preparedLocation
        ? [
            {
              branchName: preparedLocation.branchName,
              detached: false,
              path: preparedLocation.worktreePath,
            },
          ]
        : [],
    ),
    listImportableWorktrees: vi.fn(async () => [
      {
        branchName: 'import-me',
        has_committed_changes: false,
        has_uncommitted_changes: false,
        path: path.join(root, 'imported-worktree'),
      },
    ]),
    now: () => 10_000,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => (index % 251) + 1),
  };
  return { adapters, createManaged, getPreparedLocation: () => preparedLocation };
}

beforeEach(async () => {
  resetPreparedSharedRootTasksForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-preparation-'));
  projectRoot = path.join(root, 'repo');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'imported-worktree'), { recursive: true });
  storage = await createStandaloneWorkspaceStateStorage({
    isPackaged: true,
    userDataPath: path.join(root, 'state'),
  });
  workspace = new WorkspaceMutationService(storage);
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('production task-creation preparation owner', () => {
  it('pages opaque picker references and keeps them stable across owner restart', async () => {
    await seedProject();
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });

    const first = await owner.getPickerPage({ kind: 'base-branch', projectId: 'project-1' });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect(first.truncated).toBe(true);
    expect(first.items[0]).toMatchObject({ kind: 'base-branch', label: 'main' });
    expect(first.items[0]?.ref).toMatch(/^b_[A-Za-z0-9_-]{43}$/u);
    expect(first.items[0]?.ref).not.toContain('main');

    const second = await owner.getPickerPage({
      cursor: first.nextCursor ?? undefined,
      kind: 'base-branch',
      projectId: 'project-1',
    });
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();

    const restarted = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-2',
    });
    const replay = await restarted.getPickerPage({
      kind: 'base-branch',
      projectId: 'project-1',
    });
    expect(replay.items[0]?.ref).toBe(first.items[0]?.ref);
  });

  it('authoritatively converts current trusted-local branch and worktree selections to opaque refs', async () => {
    await seedProject();
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const importedWorktreePath = path.join(root, 'imported-worktree');

    const normalized = owner.normalizeTrustedLocalSelection({
      baseBranch: 'main',
      existingWorktreePath: importedWorktreePath,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot,
    });
    expect(test.adapters.listBranches).not.toHaveBeenCalled();
    expect(test.adapters.listImportableWorktrees).not.toHaveBeenCalled();

    const selection = await owner.resolveTrustedLocalSelection({
      baseBranch: 'main',
      existingWorktreePath: importedWorktreePath,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot,
    });
    const branchPage = await owner.getPickerPage({
      kind: 'base-branch',
      projectId: 'project-1',
      query: 'main',
    });
    const worktreePage = await owner.getPickerPage({
      kind: 'existing-worktree',
      projectId: 'project-1',
      query: 'import-me',
    });

    expect(selection).toEqual({
      baseBranchRef: branchPage.items[0]?.ref,
      existingWorktreeRef: worktreePage.items[0]?.ref,
      projectMode: 'git',
    });
    expect(normalized).toEqual(selection);
    await expect(
      owner.resolveTrustedLocalSelection({
        projectId: 'project-1',
        projectRoot: path.join(root, 'stale-repo'),
      }),
    ).rejects.toThrow('Selected project changed before task creation');
    await expect(
      owner.resolveTrustedLocalSelection({
        existingWorktreePath: path.join(root, 'stale-worktree'),
        projectId: 'project-1',
        projectRoot,
      }),
    ).rejects.toThrow('Selected existing worktree is no longer available');
  });

  it('normalizes opaque selections without I/O and rejects stale live selections before preparation', async () => {
    await seedProject();
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const encoded = owner.normalizeTrustedLocalSelection({
      baseBranch: 'main',
      existingWorktreePath: path.join(root, 'imported-worktree'),
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot,
    });
    expect(test.adapters.listBranches).not.toHaveBeenCalled();
    expect(test.adapters.listImportableWorktrees).not.toHaveBeenCalled();
    if (!encoded.baseBranchRef || !encoded.existingWorktreeRef) {
      throw new Error('Expected normalized trusted-local references');
    }

    const branchIntent = intent({
      baseBranchRef: encoded.baseBranchRef,
      location: { kind: 'managed-worktree', requestedLinkNames: [] },
    });
    const branchNormalization = owner.normalizeIntent(branchIntent);
    expect(branchNormalization.kind).toBe('normalized');
    const listBranchesAdapter = test.adapters.listBranches;
    if (!listBranchesAdapter) throw new Error('Expected branch-list adapter');
    vi.mocked(listBranchesAdapter).mockResolvedValueOnce({
      branches: [],
      defaultBranch: 'main',
      generatedAt: 2,
    });
    await expect(
      owner.resolveIntent(
        branchIntent,
        {} as never,
        branchNormalization.kind === 'normalized' ? branchNormalization.semanticRequest : undefined,
      ),
    ).resolves.toEqual({ code: 'capability-denied', kind: 'rejected' });

    const worktreeIntent = intent({
      location: {
        kind: 'existing-worktree',
        worktreeRef: encoded.existingWorktreeRef,
      },
    });
    const worktreeNormalization = owner.normalizeIntent(worktreeIntent);
    expect(worktreeNormalization.kind).toBe('normalized');
    const listWorktreesAdapter = test.adapters.listImportableWorktrees;
    if (!listWorktreesAdapter) throw new Error('Expected worktree-list adapter');
    vi.mocked(listWorktreesAdapter).mockResolvedValueOnce([]);
    await expect(
      owner.resolveIntent(
        worktreeIntent,
        {} as never,
        worktreeNormalization.kind === 'normalized'
          ? worktreeNormalization.semanticRequest
          : undefined,
      ),
    ).resolves.toEqual({ code: 'capability-denied', kind: 'rejected' });

    expect(test.createManaged).not.toHaveBeenCalled();
  });

  it('durably replays one exact managed worktree instead of allocating a duplicate', async () => {
    await seedProject();
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const resolved = await owner.resolveIntent(
      intent({
        launch: {
          agentDefId: 'safe-agent',
          initialPrompt: 'Start here',
          kind: 'agent',
          skipPermissions: true,
        },
        location: { kind: 'managed-worktree', requestedLinkNames: ['.env'] },
      }),
      {} as never,
    );
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') return;
    const planned = planManagedTaskLocation('Test task', projectRoot, 'feature', OPERATION_ID);
    expect(new Set(resolved.value.conflictKeys?.map(taskCreationConflictKeyId))).toEqual(
      new Set([
        taskCreationConflictKeyId(
          deriveTaskCreationConflictKey('managed-worktree', planned.worktreePath),
        ),
        taskCreationConflictKeyId(deriveTaskCreationConflictKey('branch', planned.branchName)),
      ]),
    );

    const first = await owner.prepare({
      identities,
      operationId: OPERATION_ID,
      resolved: resolved.value,
    });
    expect(first).toMatchObject({
      task: {
        branchName: expect.stringMatching(/^feature\/test-task-[0-9a-f]{12}$/u),
        gitIsolation: 'worktree',
        projectMode: 'git',
      },
      warnings: [{ name: '.env', reason: 'source_missing' }],
    });
    expect(test.createManaged).toHaveBeenCalledTimes(1);

    const restarted = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-2',
    });
    const second = await restarted.prepare({
      identities,
      operationId: OPERATION_ID,
      resolved: resolved.value,
    });
    expect(second).toEqual(first);
    expect(test.createManaged).toHaveBeenCalledTimes(1);
    expect((await storage.loadCurrent()).record.privateState).toMatchObject({
      taskCreationPreparationOwnerV1: {
        preparations: {
          [OPERATION_ID]: {
            state: 'prepared',
            taskId: 'task-1',
          },
        },
      },
    });
  });

  it('rejects a changed managed location before any worktree effect', async () => {
    await seedProject();
    const test = createAdapters();
    let planVersion = 1;
    test.adapters.planManagedTaskLocation = vi.fn((_name, rootPath) => ({
      branchName: `feature/test-task-${planVersion}`,
      worktreePath: path.join(rootPath, '.worktrees', `feature/test-task-${planVersion}`),
    }));
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const resolved = await owner.resolveIntent(
      intent({ location: { kind: 'managed-worktree', requestedLinkNames: [] } }),
      {} as never,
    );
    if (resolved.kind !== 'resolved') throw new Error('Expected a resolved managed intent');
    planVersion = 2;

    await expect(
      owner.prepare({ identities, operationId: OPERATION_ID, resolved: resolved.value }),
    ).rejects.toThrow('Managed task location changed after conflict admission');
    expect(test.createManaged).not.toHaveBeenCalled();
  });

  it('supports agent and terminal tasks on a non-Git root with no invented branch', async () => {
    await seedProject('non-git');
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });

    for (const launch of [
      { agentDefId: 'safe-agent', kind: 'agent' as const, skipPermissions: false },
      { kind: 'terminal' as const },
    ]) {
      const resolved = await owner.resolveIntent(intent({ launch }), {} as never);
      expect(resolved.kind).toBe('resolved');
      if (resolved.kind !== 'resolved') continue;
      const prepared = await owner.prepare({
        identities,
        operationId: OPERATION_ID,
        resolved: resolved.value,
      });
      expect(prepared.task).toEqual({
        branchName: '',
        projectMode: 'non-git',
        projectRoot,
        worktreePath: projectRoot,
      });
    }
    await expect(owner.getWorktreeLinkCandidates({ projectId: 'project-1' })).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('allows an occupied shared root while rejecting forged refs and unavailable permission bypass', async () => {
    await seedProject('git', {
      taskOrder: ['existing-root-task'],
      tasks: {
        'existing-root-task': {
          branchName: 'main',
          id: 'existing-root-task',
          name: 'Existing',
          projectId: 'project-1',
          taskMode: 'terminal',
          worktreePath: projectRoot,
        },
      },
    });
    const test = createAdapters();
    test.adapters.getAgentDefinitions = () => [{ ...agentDefinition, skip_permissions_args: [] }];
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });

    await expect(owner.resolveIntent(intent(), {} as never)).resolves.toMatchObject({
      kind: 'resolved',
    });
    await expect(
      owner.resolveIntent(
        intent({
          launch: {
            agentDefId: 'safe-agent',
            kind: 'agent',
            skipPermissions: true,
          },
          location: { kind: 'managed-worktree', requestedLinkNames: [] },
        }),
        {} as never,
      ),
    ).resolves.toMatchObject({ code: 'capability-denied', kind: 'rejected' });
    await expect(
      owner.resolveIntent(
        intent({
          location: { kind: 'existing-worktree', worktreeRef: 'forged' },
        }),
        {} as never,
      ),
    ).resolves.toMatchObject({ code: 'capability-denied', kind: 'rejected' });
  });

  it('allows another root task alongside an exact committed project-root replay', async () => {
    await seedProject('non-git', {
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          branchName: '',
          id: 'task-1',
          name: 'Test task',
          projectId: 'project-1',
          taskCreationOperationLink: {
            creationOperationId: OPERATION_ID,
            kind: 'creation-v1',
            launchOperationId: 'launch-1',
          },
          taskMode: 'terminal',
          worktreePath: projectRoot,
        },
      },
    });
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: createAdapters().adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });

    const replay = await owner.resolveIntent(intent(), {} as never);
    expect(replay.kind).toBe('resolved');
    await expect(
      owner.resolveIntent(intent({ operationId: OTHER_OPERATION_ID }), {} as never),
    ).resolves.toMatchObject({ kind: 'resolved' });
    if (replay.kind !== 'resolved') return;
    await expect(
      owner.prepare({
        identities,
        operationId: OPERATION_ID,
        resolved: replay.value,
      }),
    ).resolves.toMatchObject({ task: { worktreePath: projectRoot } });
  });

  it('preserves single ownership of shared steps while allowing ordinary parallel root agents', async () => {
    await seedProject('git', {
      tasks: {
        'steps-owner': {
          id: 'steps-owner',
          projectId: 'project-1',
          taskMode: 'agent',
          gitIsolation: 'current-branch',
          worktreePath: projectRoot,
          stepsTracking: true,
        },
      },
    });
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    await expect(
      owner.resolveIntent(intent({ stepsTracking: true }), {} as never),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'capability-denied' });
    const normal = await owner.resolveIntent(intent(), {} as never);
    expect(normal.kind).toBe('resolved');
    if (normal.kind !== 'resolved') return;
    await expect(
      owner.prepare({ identities, operationId: OPERATION_ID, resolved: normal.value }),
    ).resolves.toMatchObject({
      task: { gitIsolation: 'current-branch', worktreePath: projectRoot },
    });
    await expect(
      owner.prepare({
        identities,
        operationId: OPERATION_ID,
        resolved: {
          ...normal.value,
          semanticRequest: { ...normal.value.semanticRequest, stepsTracking: true },
        },
      }),
    ).rejects.toThrow('shared task steps');
  });

  it('waits for an earlier Git mutation and holds provisional root admission until absence is proven', async () => {
    await seedProject();
    const test = createAdapters();
    let mutationFinished = false;
    test.adapters.createCurrentBranchTask = vi.fn(async (rootPath) => {
      expect(mutationFinished).toBe(true);
      return {
        id: 'unused',
        branch_name: 'release/next',
        base_branch: 'release/next',
        git_isolation: 'current-branch' as const,
        worktree_path: rootPath,
      };
    });
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const resolved = await owner.resolveIntent(intent(), {} as never);
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind !== 'resolved') return;
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const mutation = withRepositoryWorktreeLock(projectRoot, async () => {
      acquired();
      await gate;
      mutationFinished = true;
    });
    await ready;
    const preparing = owner.prepare({
      identities,
      operationId: OPERATION_ID,
      resolved: resolved.value,
    });
    expect(hasPreparedSharedRootTask(projectRoot)).toBe(false);
    release();
    await mutation;
    const prepared = await preparing;
    expect(prepared.task.branchName).toBe('release/next');
    expect(hasPreparedSharedRootTask(projectRoot)).toBe(true);
    await expect(
      owner.reconcileFailedCommit({
        cause: new Error('commit failed'),
        identities,
        operationId: OPERATION_ID,
        prepared,
        resolved: resolved.value,
      }),
    ).resolves.toEqual({ kind: 'proven-clean' });
    expect(hasPreparedSharedRootTask(projectRoot)).toBe(false);
  });

  it('reports ambiguous canonical commits and never claims a managed artifact was cleaned', async () => {
    await seedProject();
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const prepared = {
      task: {
        branchName: 'feature/task-operation',
        gitIsolation: 'worktree' as const,
        projectMode: 'git' as const,
        projectRoot,
        worktreePath: path.join(projectRoot, '.worktrees/feature/task-operation'),
      },
      warnings: [],
    };
    await expect(
      owner.reconcileFailedCommit({
        cause: new Error('lost result'),
        identities,
        operationId: OPERATION_ID,
        prepared,
        resolved: {} as never,
      }),
    ).resolves.toMatchObject({
      kind: 'manual-reconciliation-required',
      reconciliation: { kind: 'artifact-ambiguous' },
    });

    const current = await storage.loadCurrent();
    await workspace.replaceSharedState(
      { expectedSharedRevision: current.record.sharedRevision, operation: 'seed-ambiguous-commit' },
      {
        ...current.record.sharedState,
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            branchName: prepared.task.branchName,
            id: 'task-1',
            name: 'Task',
            projectId: 'project-1',
            taskCreationOperationLink: {
              creationOperationId: OPERATION_ID,
              kind: 'creation-v1',
              launchOperationId: 'launch-1',
            },
            taskMode: 'agent',
            worktreePath: prepared.task.worktreePath,
          },
        },
      },
      undefined,
    );
    await expect(
      owner.reconcileFailedCommit({
        cause: new Error('lost result'),
        identities,
        operationId: OPERATION_ID,
        prepared,
        resolved: {} as never,
      }),
    ).resolves.toMatchObject({
      kind: 'manual-reconciliation-required',
      reconciliation: { expectedTaskId: 'task-1', kind: 'mapping-ambiguous' },
    });
  });

  it('retains a failed managed commit before any branch cleanup is admitted', async () => {
    await seedProject();
    const test = createAdapters();
    const quarantineLocator = path.join(
      projectRoot,
      '.worktrees/.parallel-code-recovery/1/worktree',
    );
    test.adapters.claimManagedWorktreeRecoveryQuarantine = vi.fn(async () => ({
      branchName: 'feature/task-operation',
      headOid: 'a'.repeat(40),
      operationLockOwnershipWitness: 'w'.repeat(43),
      operationLockResourceId: `worktree-lock:${OPERATION_ID}`,
      quarantineLocator,
      recoveryId: `worktree-recovery:${OPERATION_ID}`,
      resourceId: `managed-worktree:${OPERATION_ID}`,
    }));
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const worktreePath = path.join(projectRoot, '.worktrees/feature/task-operation');

    await expect(
      owner.reconcileFailedCommit({
        cause: new Error('workspace conflict'),
        identities,
        operationId: OPERATION_ID,
        prepared: {
          task: {
            branchName: 'feature/task-operation',
            gitIsolation: 'worktree',
            projectMode: 'git',
            projectRoot,
            worktreePath,
          },
          warnings: [],
        },
        resolved: {} as never,
      }),
    ).resolves.toEqual({
      kind: 'manual-reconciliation-required',
      reconciliation: {
        branchDelete: { state: 'not-applicable' },
        conflictKey: expect.any(Object),
        kind: 'retained-quarantine',
        operationLockOwnershipWitness: 'w'.repeat(43),
        operationLockResourceId: `worktree-lock:${OPERATION_ID}`,
        quarantineLocator,
        recoveryId: `worktree-recovery:${OPERATION_ID}`,
        resourceId: `managed-worktree:${OPERATION_ID}`,
        restore: { kind: 'retained' },
      },
    });
    expect(test.adapters.claimManagedWorktreeRecoveryQuarantine).toHaveBeenCalledWith({
      branchName: 'feature/task-operation',
      operationId: OPERATION_ID,
      projectRoot,
      worktreePath,
    });
  });

  it('adopts only the exact canonical task mapping owned by the structural writer', async () => {
    await seedProject('git', {
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          agentIds: [],
          branchName: 'main',
          id: 'task-1',
          name: 'Task',
          projectId: 'project-1',
          shellAgentIds: ['agent-1'],
          taskCreationOperationLink: {
            creationOperationId: OPERATION_ID,
            kind: 'creation-v1',
            launchOperationId: 'launch-1',
          },
          taskCreationProvenance: { creationWriterEpoch: 'managed-initial-shell-v1' },
          taskInitialShellOwnership: {
            expectedGeneration: 0,
            kind: 'managed-terminal-v1',
            launchOperationId: 'launch-1',
            sessionId: 'agent-1',
          },
          taskMode: 'terminal',
          worktreePath: projectRoot,
        },
      },
    });
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: createAdapters().adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const conflictKey = deriveTaskCreationConflictKey('task', 'task-1');
    const record = reconciliationRecord(
      {
        expectedTaskId: 'task-1',
        kind: 'mapping-ambiguous',
        resource: {
          conflictKey,
          resourceId: operationResourceId(OPERATION_ID, 'task-1'),
        },
      },
      [conflictKey],
    );

    await expect(
      owner.reconciliation.probeCommittedMapping(record, 'task-1'),
    ).resolves.toMatchObject({ kind: 'exact', taskId: 'task-1', workspaceRevision: 1 });
    await expect(
      owner.reconciliation.probeCommittedMapping(
        {
          ...record,
          identities: { ...record.identities, launchOperationId: 'forged-launch' },
        },
        'task-1',
      ),
    ).resolves.toEqual({ kind: 'proof-insufficient' });
  });

  it('proves managed preparation absence only when source and deterministic quarantine are absent', async () => {
    await seedProject();
    const test = createAdapters();
    const owner = await createProductionTaskCreationPreparationOwner({
      adapters: test.adapters,
      privateAuthority: workspace.createPrivateMutationAuthority(),
      serverInstanceId: 'server-1',
    });
    const managedIntent = intent({
      location: { kind: 'managed-worktree', requestedLinkNames: [] },
    });
    const resolved = await owner.resolveIntent(managedIntent, {} as never);
    if (resolved.kind !== 'resolved') throw new Error('Managed test intent did not resolve');
    const prepared = await owner.prepare({
      identities,
      operationId: OPERATION_ID,
      resolved: resolved.value,
    });
    const worktreePath = prepared.task.worktreePath;
    const conflictKey = deriveTaskCreationConflictKey('managed-worktree', worktreePath);
    const resource = {
      conflictKey,
      resourceId: operationResourceId(OPERATION_ID, worktreePath),
    };
    const record = reconciliationRecord({ kind: 'artifact-ambiguous', resources: [resource] }, [
      conflictKey,
    ]);

    fs.rmSync(worktreePath, { force: true, recursive: true });
    const listGitWorktreesAdapter = test.adapters.listGitWorktrees;
    if (!listGitWorktreesAdapter) throw new Error('Expected Git worktree-list adapter');
    vi.mocked(listGitWorktreesAdapter).mockResolvedValue([]);
    await expect(owner.reconciliation.probeOwnedArtifactAbsence(record, resource)).resolves.toEqual(
      { kind: 'exact-absent' },
    );

    const quarantinePath = getManagedWorktreeRecoveryQuarantinePath(worktreePath, OPERATION_ID);
    fs.mkdirSync(quarantinePath, { recursive: true });
    await expect(owner.reconciliation.probeOwnedArtifactAbsence(record, resource)).resolves.toEqual(
      { kind: 'present' },
    );
  });
});
