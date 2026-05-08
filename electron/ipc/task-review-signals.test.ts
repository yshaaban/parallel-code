import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearTaskReviewSignalsRegistry,
  getTaskReviewSignalsSnapshot,
  refreshTaskReviewSignals,
  registerTaskReviewSignalsTask,
  restoreSavedTaskReviewSignals,
  setTaskReviewSignalsFetchForTests,
  subscribeTaskReviewSignals,
} from './task-review-signals.js';

function createGithubResponse(body: unknown): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

async function createTempWorktree(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'parallel-review-signals-'));
}

async function writeCoverageSummary(worktreePath: string, linesPct = 91.25): Promise<void> {
  const coverageDir = path.join(worktreePath, 'coverage');
  await fs.promises.mkdir(coverageDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(coverageDir, 'coverage-summary.json'),
    JSON.stringify({
      total: {
        branches: { pct: 70 },
        functions: { pct: 80 },
        lines: { pct: linesPct },
        statements: { pct: 90 },
      },
    }),
    'utf8',
  );
}

async function writeLcov(worktreePath: string): Promise<void> {
  const coverageDir = path.join(worktreePath, 'coverage');
  await fs.promises.mkdir(coverageDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(coverageDir, 'lcov.info'),
    [
      'TN:',
      'SF:src/example.ts',
      'LF:4',
      'LH:3',
      'BRF:2',
      'BRH:1',
      'FNF:1',
      'FNH:1',
      'end_of_record',
    ].join('\n'),
    'utf8',
  );
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
}

function waitForTaskReviewSignalsSnapshot(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const existingSnapshot = getTaskReviewSignalsSnapshot(taskId);
    if (existingSnapshot) {
      resolve();
      return;
    }

    const unsubscribe = subscribeTaskReviewSignals((event) => {
      if (event.taskId !== taskId || 'removed' in event) {
        return;
      }

      unsubscribe();
      resolve();
    });
  });
}

describe('task-review-signals', () => {
  let worktreePath: string;

  beforeEach(async () => {
    clearTaskReviewSignalsRegistry();
    worktreePath = await createTempWorktree();
  });

  afterEach(async () => {
    clearTaskReviewSignalsRegistry();
    await fs.promises.rm(worktreePath, { force: true, recursive: true });
  });

  it('loads GitHub PR CI and coverage artifacts into one replayable snapshot', async () => {
    await writeCoverageSummary(worktreePath);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/12')) {
        return createGithubResponse({
          head: { sha: 'abc123' },
          html_url: 'https://github.com/example/repo/pull/12',
        });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return createGithubResponse({
          state: 'success',
          statuses: [{ target_url: 'https://ci.example/status' }],
        });
      }
      if (url.endsWith('/commits/abc123/check-runs')) {
        return createGithubResponse({
          check_runs: [
            {
              conclusion: 'success',
              html_url: 'https://ci.example/check',
              status: 'completed',
            },
          ],
        });
      }

      throw new Error(`Unexpected GitHub URL: ${url}`);
    });
    setTaskReviewSignalsFetchForTests(fetchMock);

    registerTaskReviewSignalsTask({
      githubUrl: 'https://github.com/example/repo/pull/12',
      taskId: 'task-1',
      worktreePath,
    });
    await refreshTaskReviewSignals('task-1');

    expect(getTaskReviewSignalsSnapshot('task-1')).toMatchObject({
      ci: {
        headSha: 'abc123',
        label: 'CI passing',
        state: 'success',
        totalCount: 2,
      },
      coverage: {
        branchesPct: 70,
        functionsPct: 80,
        label: 'Coverage 91.3%',
        linesPct: 91.25,
        source: 'coverage-summary',
        state: 'available',
        statementsPct: 90,
      },
      taskId: 'task-1',
    });
  });

  it('uses explicit unavailable states when no PR URL or coverage artifact exists', async () => {
    registerTaskReviewSignalsTask({
      taskId: 'task-1',
      worktreePath,
    });
    await refreshTaskReviewSignals('task-1');

    expect(getTaskReviewSignalsSnapshot('task-1')).toMatchObject({
      ci: {
        state: 'unconfigured',
      },
      coverage: {
        state: 'missing',
      },
    });
  });

  it('falls back to lcov when coverage summary JSON is malformed', async () => {
    const coverageDir = path.join(worktreePath, 'coverage');
    await fs.promises.mkdir(coverageDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(coverageDir, 'coverage-summary.json'),
      '{not json',
      'utf8',
    );
    await writeLcov(worktreePath);

    registerTaskReviewSignalsTask({
      taskId: 'task-1',
      worktreePath,
    });
    await refreshTaskReviewSignals('task-1');

    expect(getTaskReviewSignalsSnapshot('task-1')).toMatchObject({
      coverage: {
        branchesPct: 50,
        functionsPct: 100,
        label: 'Coverage 75.0%',
        linesPct: 75,
        source: 'lcov',
        state: 'available',
      },
    });
  });

  it('restores task metadata with github URLs from saved state', async () => {
    await writeCoverageSummary(worktreePath);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/99')) {
        return createGithubResponse({
          head: { sha: 'def456' },
          html_url: 'https://github.com/example/repo/pull/99',
        });
      }
      if (url.endsWith('/commits/def456/status')) {
        return createGithubResponse({ state: 'pending', statuses: [] });
      }
      if (url.endsWith('/commits/def456/check-runs')) {
        return createGithubResponse({ check_runs: [] });
      }

      throw new Error(`Unexpected GitHub URL: ${url}`);
    });
    setTaskReviewSignalsFetchForTests(fetchMock);

    const restoredSnapshot = waitForTaskReviewSignalsSnapshot('task-from-key');
    restoreSavedTaskReviewSignals(
      JSON.stringify({
        tasks: {
          'task-from-key': {
            githubUrl: 'https://github.com/example/repo/pull/99',
            worktreePath,
          },
        },
      }),
    );

    await restoredSnapshot;

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/example/repo/pulls/99',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
        }),
      }),
    );
    expect(getTaskReviewSignalsSnapshot('task-from-key')).toMatchObject({
      ci: {
        headSha: 'def456',
        state: 'pending',
      },
      coverage: {
        state: 'available',
      },
    });
  });

  it('ignores stale snapshots when task metadata changes during a refresh', async () => {
    await writeCoverageSummary(worktreePath, 12.5);
    const nextWorktreePath = await createTempWorktree();
    try {
      await writeCoverageSummary(nextWorktreePath, 98.5);
      const oldPullResponse = createDeferred<ReturnType<typeof createGithubResponse>>();
      const observedHeadShas: string[] = [];
      const unsubscribe = subscribeTaskReviewSignals((event) => {
        if ('removed' in event) {
          return;
        }
        if (event.ci.headSha) {
          observedHeadShas.push(event.ci.headSha);
        }
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/pulls/1')) {
          return oldPullResponse.promise;
        }
        if (url.endsWith('/commits/old111/status')) {
          return createGithubResponse({ state: 'success', statuses: [] });
        }
        if (url.endsWith('/commits/old111/check-runs')) {
          return createGithubResponse({ check_runs: [] });
        }
        if (url.endsWith('/pulls/2')) {
          return createGithubResponse({
            head: { sha: 'new222' },
            html_url: 'https://github.com/example/repo/pull/2',
          });
        }
        if (url.endsWith('/commits/new222/status')) {
          return createGithubResponse({ state: 'success', statuses: [] });
        }
        if (url.endsWith('/commits/new222/check-runs')) {
          return createGithubResponse({ check_runs: [] });
        }

        throw new Error(`Unexpected GitHub URL: ${url}`);
      });
      setTaskReviewSignalsFetchForTests(fetchMock);

      registerTaskReviewSignalsTask({
        githubUrl: 'https://github.com/example/repo/pull/1',
        taskId: 'task-1',
        worktreePath,
      });
      const refreshPromise = refreshTaskReviewSignals('task-1');
      registerTaskReviewSignalsTask({
        githubUrl: 'https://github.com/example/repo/pull/2',
        taskId: 'task-1',
        worktreePath: nextWorktreePath,
      });

      oldPullResponse.resolve(
        createGithubResponse({
          head: { sha: 'old111' },
          html_url: 'https://github.com/example/repo/pull/1',
        }),
      );
      await refreshPromise;
      unsubscribe();

      expect(observedHeadShas).toEqual(['new222']);
      expect(getTaskReviewSignalsSnapshot('task-1')).toMatchObject({
        ci: {
          headSha: 'new222',
        },
        coverage: {
          label: 'Coverage 98.5%',
          linesPct: 98.5,
        },
      });
    } finally {
      await fs.promises.rm(nextWorktreePath, { force: true, recursive: true });
    }
  });
});
