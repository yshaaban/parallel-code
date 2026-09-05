import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageEnv } from './storage.js';
import {
  TaskMergeOperationAccessError,
  TaskMergeOperationIssuer,
} from './task-merge-operation-issuer.js';
import { WorkspaceMutationService } from './workspace-state-mutations.js';
import {
  createStandaloneWorkspaceStateStorage,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

let root = '';
let storage: WorkspaceStateStorage;
let workspace: WorkspaceMutationService;

function env(): StorageEnv {
  return { isPackaged: true, userDataPath: root };
}

async function seedTask(): Promise<void> {
  await workspace.replaceSharedState(
    { expectedSharedRevision: 0, operation: 'seed-merge-issuer-task' },
    {
      collapsedTaskOrder: [],
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          branchName: 'task/one',
          gitIsolation: 'worktree',
          id: 'task-1',
          name: 'Task one',
          projectId: 'project-1',
          taskMode: 'agent',
          worktreePath: '/repo/.worktrees/task-1',
        },
      },
    },
    undefined,
  );
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-merge-issuer-'));
  storage = await createStandaloneWorkspaceStateStorage(env());
  workspace = new WorkspaceMutationService(storage);
  await seedTask();
});

afterEach(async () => {
  await storage.close();
  fs.rmSync(root, { force: true, recursive: true });
});

describe('task merge operation issuer', () => {
  it('persists only capability hashes and serializes lost-response supersession', async () => {
    const accesses = [
      { operationCapability: 'a'.repeat(43), operationId: 'merge-operation-1' },
      { operationCapability: 'b'.repeat(43), operationId: 'merge-operation-2' },
    ];
    const cutoverOrder: string[] = [];
    const issuer = new TaskMergeOperationIssuer(workspace.createPrivateMutationAuthority(), {
      createCutoverEpoch: () => 'merge-cutover-1',
      createOperationAccess: () => {
        const access = accesses.shift();
        if (!access) throw new Error('Unexpected operation allocation');
        return access;
      },
      now: () => 1_000,
    });
    await issuer.activate({
      disableLegacyMergeWriters: async (epoch) => {
        cutoverOrder.push(`disable:${epoch}`);
      },
      verifyLegacyMergeWritersDisabled: async (epoch) => {
        cutoverOrder.push(`verify:${epoch}`);
      },
    });

    const first = await issuer.issue({ principalId: 'principal-1', taskId: 'task-1' });
    const second = await issuer.issue({ principalId: 'principal-1', taskId: 'task-1' });

    expect(cutoverOrder).toEqual(['disable:merge-cutover-1', 'verify:merge-cutover-1']);
    await expect(issuer.getAuthorizedRecord('principal-1', first)).resolves.toMatchObject({
      phase: 'superseded-unused',
      recordVersion: 2,
    });
    await expect(issuer.getAuthorizedRecord('principal-1', second)).resolves.toMatchObject({
      phase: 'issued',
      recordVersion: 1,
    });
    await expect(
      issuer.getAuthorizedRecord('principal-1', {
        ...second,
        operationCapability: 'c'.repeat(43),
      }),
    ).rejects.toBeInstanceOf(TaskMergeOperationAccessError);
    await expect(issuer.getAuthorizedRecord('principal-2', second)).rejects.toBeInstanceOf(
      TaskMergeOperationAccessError,
    );

    const persisted = JSON.stringify((await storage.loadCurrent()).record.privateState);
    expect(persisted).not.toContain(first.operationCapability);
    expect(persisted).not.toContain(second.operationCapability);
    expect(persisted).toContain('capabilityHash');
  });

  it('does not publish active capability or progress protection when legacy disable fails', async () => {
    const issuer = new TaskMergeOperationIssuer(workspace.createPrivateMutationAuthority(), {
      createCutoverEpoch: () => 'merge-cutover-failed',
    });
    await expect(
      issuer.activate({
        disableLegacyMergeWriters: vi.fn(async () => {
          throw new Error('disable failed');
        }),
        verifyLegacyMergeWritersDisabled: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow('disable failed');

    expect(issuer.getCapability()).toBeNull();
    expect((await storage.loadCurrent()).record).toMatchObject({
      privateState: {
        protectedWorkspacePolicyVersions: { 'merge-progress': '0' },
        taskMergeOwnerSchema: { phase: 'preparing' },
      },
    });
  });
});
