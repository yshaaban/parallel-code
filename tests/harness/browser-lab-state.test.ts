import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInteractiveNodeScenario } from '../browser/harness/scenarios.js';
import {
  getStandaloneStateDir,
  seedBrowserState,
  type SeededBrowserState,
} from '../browser/harness/standalone-server.js';

interface PersistedTaskBranchState {
  projects: Array<{ path: string }>;
  tasks: Record<string, { branchName: string; worktreePath: string }>;
}

interface PersistedWorkspaceStateEnvelope {
  revision: number;
  state: PersistedTaskBranchState;
}

function readCurrentBranchName(repoDir: string): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
}

async function readSeededStateFiles(seededState: SeededBrowserState): Promise<{
  legacyState: PersistedTaskBranchState;
  workspaceState: PersistedWorkspaceStateEnvelope;
}> {
  const stateDir = getStandaloneStateDir(seededState.userDataPath);
  const [legacyJson, workspaceJson] = await Promise.all([
    readFile(path.join(stateDir, 'state.json'), 'utf8'),
    readFile(path.join(stateDir, 'workspace-state.json'), 'utf8'),
  ]);

  return {
    legacyState: JSON.parse(legacyJson) as PersistedTaskBranchState,
    workspaceState: JSON.parse(workspaceJson) as PersistedWorkspaceStateEnvelope,
  };
}

describe('browser-lab standalone seeded state', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
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
      worktreePath: seededState.repoDir,
    });
    expect(workspaceState.state.tasks[seededState.taskId]).toMatchObject({
      branchName: 'main',
      worktreePath: seededState.repoDir,
    });
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
