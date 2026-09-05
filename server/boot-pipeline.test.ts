import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetBackendWorkQueueForTests } from '../electron/ipc/backend-work-queue.js';
import { getDerivedStateFilePath } from '../electron/ipc/derived-state-persistence.js';
import { clearGitStatusSnapshots } from '../electron/ipc/git-status-state.js';
import { resetGitStatusWorkflowRegistryForTests } from '../electron/ipc/git-status-workflows.js';
import {
  getGitSubprocessCount,
  resetBackendRuntimeDiagnostics,
} from '../electron/ipc/runtime-diagnostics.js';
import { clearTaskConvergenceRegistry } from '../electron/ipc/task-convergence-state.js';
import { clearTaskReviewRegistry } from '../electron/ipc/task-review-state.js';
import { clearTaskReviewSignalsRegistry } from '../electron/ipc/task-review-signals.js';
import { clearTaskStepsRegistry } from '../electron/ipc/task-steps.js';
import type { GitStatusSyncSnapshotEvent } from '../src/domain/server-state.js';
import type { AnyServerStateBootstrapSnapshot } from '../src/domain/server-state-bootstrap.js';
import { BROWSER_CLIENT_ID_HEADER } from '../src/domain/browser-ipc.js';
import { startBrowserServer, type BrowserServerController } from './browser-server.js';

const TASK_COUNT = 12;
const AUTH_TOKEN = 'boot-pipeline-test-token';
const CLIENT_ID = 'boot-pipeline-client';
const PROJECT_ID = 'boot-project';
const GIT_SUBPROCESS_BUDGET = 50;

interface BootstrapCategorySnapshot {
  category: string;
  payload: unknown;
  version: number;
}

let fixtureRoot = '';
let userDataPath = '';
let serverController: BrowserServerController | null = null;
let baseUrl = '';
let gitSubprocessCountAtListen = 0;

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function taskIdFor(index: number): string {
  return `boot-task-${index}`;
}

function branchNameFor(index: number): string {
  return `boot/task-${index}`;
}

async function getAvailablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate test port');
  }
  return address.port;
}

function createFixtureWorkspace(): { stateDir: string; worktreePaths: string[] } {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'parallel-code-boot-pipeline-'));
  const repoPath = path.join(fixtureRoot, 'project');
  userDataPath = path.join(fixtureRoot, 'server-data');
  const stateDir = `${userDataPath}-dev`;

  mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ['init', '-b', 'main']);
  runGit(repoPath, ['config', 'user.email', 'boot-pipeline@parallel-code.local']);
  runGit(repoPath, ['config', 'user.name', 'Boot Pipeline']);
  writeFileSync(path.join(repoPath, 'README.md'), '# Boot pipeline fixture\n', 'utf8');
  runGit(repoPath, ['add', '-A']);
  runGit(repoPath, ['commit', '-m', 'Initial fixture commit']);

  const tasks: Record<string, unknown> = {};
  const worktreePaths: string[] = [];
  for (let index = 1; index <= TASK_COUNT; index += 1) {
    const worktreePath = path.join(fixtureRoot, 'worktrees', `task-${index}`);
    runGit(repoPath, ['worktree', 'add', worktreePath, '-b', branchNameFor(index), 'main']);
    writeFileSync(path.join(worktreePath, `change-${index}.txt`), `uncommitted ${index}\n`, 'utf8');
    worktreePaths.push(worktreePath);
    tasks[taskIdFor(index)] = {
      branchName: branchNameFor(index),
      id: taskIdFor(index),
      name: `Boot pipeline task ${index}`,
      projectId: PROJECT_ID,
      ...(index === 1 ? { stepsTracking: true } : {}),
      worktreePath,
    };
  }

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({ projects: [{ id: PROJECT_ID, path: repoPath }], tasks }),
    'utf8',
  );

  const derivedState = {
    formatVersion: 1,
    gitStatus: worktreePaths.map(
      (worktreePath): GitStatusSyncSnapshotEvent => ({
        status: { has_committed_changes: false, has_uncommitted_changes: false },
        worktreePath,
      }),
    ),
    savedAt: Date.now(),
    taskConvergence: worktreePaths.map((worktreePath, index) => ({
      branchFiles: [],
      branchName: branchNameFor(index + 1),
      changedFileCount: 0,
      commitCount: 0,
      conflictingFiles: [],
      hasCommittedChanges: false,
      hasUncommittedChanges: false,
      mainAheadCount: 0,
      overlapWarnings: [],
      projectId: PROJECT_ID,
      state: 'no-changes',
      summary: 'hydrated-from-derived-state',
      taskId: taskIdFor(index + 1),
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 1_000,
      worktreePath,
    })),
    taskReview: worktreePaths.map((worktreePath, index) => ({
      branchName: branchNameFor(index + 1),
      files: [],
      projectId: PROJECT_ID,
      revisionId: `hydrated-review-${index + 1}`,
      source: 'worktree',
      taskId: taskIdFor(index + 1),
      totalAdded: 0,
      totalRemoved: 0,
      updatedAt: 1_000,
      worktreePath,
    })),
    taskReviewSignals: worktreePaths.map((_worktreePath, index) => ({
      ci: { label: 'hydrated-ci', state: 'unconfigured' },
      coverage: { label: 'hydrated-coverage', state: 'missing' },
      taskId: taskIdFor(index + 1),
      updatedAt: 1_000,
    })),
    taskSteps: [],
  };
  writeFileSync(
    getDerivedStateFilePath({ isPackaged: false, userDataPath }),
    JSON.stringify(derivedState),
    'utf8',
  );

  return { stateDir, worktreePaths };
}

async function invokeIpc<T>(channel: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${baseUrl}/api/ipc/${channel}`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      [BROWSER_CLIENT_ID_HEADER]: CLIENT_ID,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; result?: T };
  if (!response.ok) {
    throw new Error(payload.error ?? `IPC ${channel} failed with ${response.status}`);
  }

  return payload.result as T;
}

async function fetchColdBootstrapCategories(): Promise<BootstrapCategorySnapshot[]> {
  const snapshot = await invokeIpc<{
    serverStateBootstrap: AnyServerStateBootstrapSnapshot[];
  }>('get_browser_cold_bootstrap');
  return snapshot.serverStateBootstrap as unknown as BootstrapCategorySnapshot[];
}

function getCategory(
  categories: BootstrapCategorySnapshot[],
  category: string,
): BootstrapCategorySnapshot {
  const entry = categories.find((candidate) => candidate.category === category);
  if (!entry) {
    throw new Error(`Missing bootstrap category ${category}`);
  }
  return entry;
}

describe('boot pipeline (12-task snapshot-first server boot)', () => {
  beforeAll(async () => {
    resetBackendRuntimeDiagnostics();
    createFixtureWorkspace();
    const port = await getAvailablePort();
    serverController = startBrowserServer({
      distDir: path.join(fixtureRoot, 'dist'),
      distRemoteDir: path.join(fixtureRoot, 'dist-remote'),
      port,
      registerProcessHandlers: false,
      token: AUTH_TOKEN,
      userDataPath,
    });
    baseUrl = `http://127.0.0.1:${port}`;
    await serverController.whenReady();
    gitSubprocessCountAtListen = getGitSubprocessCount();
  }, 120_000);

  afterAll(async () => {
    if (serverController) {
      serverController.cleanup();
      await serverController.whenCoordinatorRuntimeStopped();
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    resetBackendWorkQueueForTests();
    resetGitStatusWorkflowRegistryForTests();
    clearGitStatusSnapshots();
    clearTaskConvergenceRegistry();
    clearTaskReviewRegistry();
    clearTaskReviewSignalsRegistry();
    clearTaskStepsRegistry();
    if (fixtureRoot) {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }, 60_000);

  it('reaches listen without scheduling per-task git refresh work', () => {
    // Watcher setup may resolve a git dir per task; the boot storm (4-6 execs
    // per task plus convergence fan-out) must be gone.
    expect(gitSubprocessCountAtListen).toBeLessThanOrEqual(TASK_COUNT + 4);
  });

  it('serves hydrated derived-state categories in the first cold bootstrap', async () => {
    const categories = await fetchColdBootstrapCategories();

    const gitStatus = getCategory(categories, 'git-status');
    const gitStatusEntries = gitStatus.payload as GitStatusSyncSnapshotEvent[];
    expect(gitStatusEntries).toHaveLength(TASK_COUNT);

    const convergence = getCategory(categories, 'task-convergence');
    const convergenceEntries = convergence.payload as Array<{ summary: string; taskId: string }>;
    expect(convergenceEntries).toHaveLength(TASK_COUNT);
    expect(new Set(convergenceEntries.map((entry) => entry.taskId))).toContain(taskIdFor(5));

    const review = getCategory(categories, 'task-review');
    const reviewEntries = review.payload as Array<{ revisionId: string; taskId: string }>;
    expect(reviewEntries).toHaveLength(TASK_COUNT);
    expect(reviewEntries.every((entry) => entry.revisionId.startsWith('hydrated-review-'))).toBe(
      true,
    );

    const reviewSignals = getCategory(categories, 'task-review-signals');
    const signalEntries = reviewSignals.payload as Array<{ taskId: string }>;
    expect(signalEntries).toHaveLength(TASK_COUNT);

    const steps = getCategory(categories, 'task-steps');
    const stepEntries = steps.payload as Array<{ taskId: string }>;
    expect(stepEntries.map((entry) => entry.taskId)).toContain(taskIdFor(1));
  }, 30_000);

  it('answers a single no-retry coordinator call immediately through awaited lazy init', async () => {
    const diagnostics = await invokeIpc<{ promptDelivery?: unknown }>(
      'coordinator_get_diagnostics',
    );
    expect(diagnostics).toBeTruthy();

    const toolCallResponse = await fetch(`${baseUrl}/api/coordinator/tool-call`, {
      body: JSON.stringify({
        callId: 'boot-pipeline-call',
        runId: 'missing-run',
        taskId: 'missing-task',
        token: 'invalid-token',
        toolName: 'get_run_status',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const payload = (await toolCallResponse.json()) as { error?: string };
    expect(toolCallResponse.status).toBe(400);
    expect(payload.error).toBeTruthy();
    expect(payload.error).not.toContain('unavailable');
  }, 30_000);

  it('refreshes the focused task ahead of the untouched background tasks within budget', async () => {
    const before = await fetchColdBootstrapCategories();
    const beforeGitStatus = getCategory(before, 'git-status');
    const beforeEntries = beforeGitStatus.payload as GitStatusSyncSnapshotEvent[];
    expect(beforeEntries.every((entry) => entry.status.has_uncommitted_changes === false)).toBe(
      true,
    );

    await invokeIpc('report_client_task_focus', {
      selectedTaskId: taskIdFor(1),
      visibleTaskIds: [taskIdFor(1)],
    });

    const focusedWorktreeSuffix = path.join('worktrees', 'task-1');
    const deadline = Date.now() + 20_000;
    let refreshedEntries: GitStatusSyncSnapshotEvent[] = [];
    let refreshedVersion = 0;
    while (Date.now() < deadline) {
      const categories = await fetchColdBootstrapCategories();
      const gitStatus = getCategory(categories, 'git-status');
      const entries = gitStatus.payload as GitStatusSyncSnapshotEvent[];
      const focused = entries.find((entry) => entry.worktreePath.endsWith(focusedWorktreeSuffix));
      if (focused?.status.has_uncommitted_changes === true) {
        refreshedEntries = entries;
        refreshedVersion = gitStatus.version;
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    expect(refreshedEntries.length).toBe(TASK_COUNT);
    expect(refreshedVersion).toBeGreaterThan(getCategory(before, 'git-status').version);

    const untouched = refreshedEntries.filter(
      (entry) => !entry.worktreePath.endsWith(focusedWorktreeSuffix),
    );
    expect(untouched).toHaveLength(TASK_COUNT - 1);
    expect(untouched.every((entry) => entry.status.has_uncommitted_changes === false)).toBe(true);

    expect(getGitSubprocessCount()).toBeLessThan(GIT_SUBPROCESS_BUDGET);
  }, 40_000);
});
