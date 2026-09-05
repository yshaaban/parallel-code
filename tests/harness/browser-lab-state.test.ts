import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  activateProtectedPolicies,
  mergeProtectedWorkspaceFields,
  PROTECTED_WORKSPACE_POLICY_IDS,
} from '../../electron/ipc/workspace-state-mutations.js';
import type { JsonObject } from '../../electron/ipc/workspace-state-storage.js';
import { runIndependentCleanups } from '../../scripts/lib/cleanup-outcome.mjs';
import { resetMergeProgressProjectionForTests } from '../../src/app/merge-progress.js';
import {
  applyLoadedWorkspaceStateJson,
  getWorkspaceStateSnapshotJson,
} from '../../src/store/persistence.js';
import { resetPersistenceSessionStateForTests } from '../../src/store/persistence-session.js';
import type {
  PersistedState,
  PersistedTask,
  Project,
  WorkspaceSharedState,
} from '../../src/store/types.js';
import { resetStoreForTest } from '../../src/test/store-test-helpers.js';
import { createInteractiveNodeScenario } from '../browser/harness/scenarios.js';
import { MERGE_PROGRESS_SCHEMA_VERSION } from '../../src/domain/task-merge.js';
import {
  getStandaloneStateDir,
  seedBrowserState,
  type SeededBrowserState,
} from '../browser/harness/standalone-server.js';

interface PersistedWorkspaceStateEnvelope {
  revision: number;
  state: WorkspaceSharedState;
}

function readCurrentBranchName(repoDir: string): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
}

async function readSeededStateFiles(seededState: SeededBrowserState): Promise<{
  legacyState: PersistedState;
  workspaceState: PersistedWorkspaceStateEnvelope;
}> {
  const stateDir = getStandaloneStateDir(seededState.userDataPath);
  const [legacyJson, workspaceJson] = await Promise.all([
    readFile(path.join(stateDir, 'state.json'), 'utf8'),
    readFile(path.join(stateDir, 'workspace-state.json'), 'utf8'),
  ]);

  return {
    legacyState: JSON.parse(legacyJson) as PersistedState,
    workspaceState: JSON.parse(workspaceJson) as PersistedWorkspaceStateEnvelope,
  };
}

function getSeededProject(state: WorkspaceSharedState): Project {
  const project = state.projects[0];
  if (!project) {
    throw new Error('Expected the browser-lab seed to contain one project');
  }
  return project;
}

function getSeededTask(state: WorkspaceSharedState, taskId: string): PersistedTask {
  const task = state.tasks[taskId];
  if (!task) {
    throw new Error(`Expected the browser-lab seed to contain task ${taskId}`);
  }
  return task;
}

function expectRendererProjectionToPreserveProtectedFields(
  canonicalState: WorkspaceSharedState,
  revision: number,
): void {
  resetStoreForTest();
  resetPersistenceSessionStateForTests();
  resetMergeProgressProjectionForTests();

  const canonicalJson = JSON.stringify(canonicalState);
  expect(applyLoadedWorkspaceStateJson(canonicalJson, revision)).toBe(true);

  const canonical = JSON.parse(canonicalJson) as JsonObject;
  const rendererProjection = JSON.parse(getWorkspaceStateSnapshotJson()) as JsonObject;
  const activePolicies = activateProtectedPolicies({}, PROTECTED_WORKSPACE_POLICY_IDS);

  expect(() =>
    mergeProtectedWorkspaceFields(canonical, rendererProjection, activePolicies),
  ).not.toThrow();
}

describe('browser-lab standalone seeded state', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await runIndependentCleanups(
      'Browser lab state test temporary directories',
      tempDirs
        .splice(0)
        .map(
          (tempDir, index) =>
            [
              `remove browser lab state temporary directory ${index + 1}`,
              () => rm(tempDir, { recursive: true, force: true }),
            ] as const,
        ),
    );
  });

  it('persists the repo current branch for the default seeded scenario', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-lab-state-'));
    tempDirs.push(tempDir);

    const seededState = await seedBrowserState(tempDir, createInteractiveNodeScenario());
    const { legacyState, workspaceState } = await readSeededStateFiles(seededState);

    expect(readCurrentBranchName(seededState.repoDir)).toBe('main');
    expect(seededState.branchName).toBe('main');
    expect(legacyState.projects[0]?.path).toBe(seededState.repoDir);
    expect(legacyState.tasks[seededState.taskId]).toMatchObject({
      branchName: 'main',
      gitIsolation: 'worktree',
      worktreePath: seededState.repoDir,
    });
    expect(getSeededProject(workspaceState.state)).toMatchObject({
      defaultTaskGitIsolation: 'worktree',
      path: seededState.repoDir,
    });
    expect(workspaceState.state.tasks[seededState.taskId]).toMatchObject({
      branchName: 'main',
      gitIsolation: 'worktree',
      worktreePath: seededState.repoDir,
    });
    expectRendererProjectionToPreserveProtectedFields(
      {
        ...workspaceState.state,
        committedMergeOperationId: 'merge-operation-1',
        mergeOperation: {
          committedAt: '2026-08-04T10:00:00.000Z',
          operationId: 'merge-operation-1',
          progressVersion: 1,
          taskId: 'task-already-merged',
        },
        mergeProgress: {
          schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
          version: 1,
          dateKey: '2026-08-04',
          tasksToday: 1,
          linesAdded: 12,
          linesRemoved: 3,
          updatedAt: '2026-08-04T10:00:00.000Z',
        },
      },
      workspaceState.revision,
    );
  });

  it('preserves an explicit current-branch task through the renderer projection', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-lab-state-'));
    tempDirs.push(tempDir);

    const seededState = await seedBrowserState(tempDir, {
      ...createInteractiveNodeScenario(),
      name: 'current-branch-fixture',
      taskGitIsolation: 'current-branch',
    });
    const { legacyState, workspaceState } = await readSeededStateFiles(seededState);

    expect(legacyState.tasks[seededState.taskId]).toMatchObject({
      directMode: true,
      gitIsolation: 'current-branch',
      worktreePath: seededState.repoDir,
    });
    expect(getSeededProject(workspaceState.state).defaultTaskGitIsolation).toBe('worktree');
    expect(getSeededTask(workspaceState.state, seededState.taskId)).toMatchObject({
      directMode: true,
      gitIsolation: 'current-branch',
      worktreePath: seededState.repoDir,
    });
    expectRendererProjectionToPreserveProtectedFields(
      workspaceState.state,
      workspaceState.revision,
    );
  });

  it('persists the scenario-switched feature branch instead of hardcoding browser-lab/e2e', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-browser-lab-state-'));
    tempDirs.push(tempDir);

    const seededState = await seedBrowserState(tempDir, {
      ...createInteractiveNodeScenario(),
      name: 'feature-branch-fixture',
      seedRepo(repoDir) {
        execFileSync('git', ['checkout', '-B', 'feature/browser-lab-seeded'], { cwd: repoDir });
      },
    });
    const { legacyState, workspaceState } = await readSeededStateFiles(seededState);

    expect(readCurrentBranchName(seededState.repoDir)).toBe('feature/browser-lab-seeded');
    expect(seededState.branchName).toBe('feature/browser-lab-seeded');
    expect(legacyState.tasks[seededState.taskId]?.branchName).toBe('feature/browser-lab-seeded');
    expect(workspaceState.state.tasks[seededState.taskId]?.branchName).toBe(
      'feature/browser-lab-seeded',
    );
  });
});
