import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyRequestedWorktreeSymlinks,
  encodeTaskWorktreeLinkRequestV1,
  getWorktreeSymlinkCandidates,
} from './git-worktree-symlinks.js';
import { getGitSubprocessCount, resetBackendRuntimeDiagnostics } from './runtime-diagnostics.js';

const WARMUP_ITERATIONS = 3;
const MEASURED_ITERATIONS = 20;
const NORMAL_DISCOVERY_P95_BUDGET_MS = 150;
const LARGE_DISCOVERY_P95_BUDGET_MS = 500;
const NINE_ENTRY_APPLY_P95_BUDGET_MS = 250;
const DISCOVERY_GIT_PROCESSES_PER_CALL = 2;
const APPLY_GIT_PROCESSES_PER_CALL = 4;

interface RepositoryFixture {
  repositoryRoot: string;
  temporaryRoot: string;
}

interface ApplyFixture extends RepositoryFixture {
  excludePath: string;
  names: readonly string[];
  worktreePaths: readonly string[];
}

const temporaryRoots = new Set<string>();
let normalFixture: RepositoryFixture;
let largeFixture: RepositoryFixture;
let applyFixture: ApplyFixture;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function createRepository(ignoreLines: readonly string[]): RepositoryFixture {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'parallel-code-worktree-link-performance-'),
  );
  temporaryRoots.add(temporaryRoot);
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  fs.mkdirSync(repositoryRoot);
  git(repositoryRoot, ['init', '-q']);
  git(repositoryRoot, ['config', 'user.email', 'parallel-code-tests@example.com']);
  git(repositoryRoot, ['config', 'user.name', 'Parallel Code Tests']);
  git(repositoryRoot, ['config', 'core.ignorecase', 'false']);
  fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), `${ignoreLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'performance fixture\n', 'utf8');
  git(repositoryRoot, ['add', '.gitignore', 'README.md']);
  git(repositoryRoot, ['commit', '-qm', 'performance fixture']);
  return { repositoryRoot, temporaryRoot };
}

function createIgnoredDirectories(repositoryRoot: string, names: readonly string[]): void {
  for (const name of names) {
    const directory = path.join(repositoryRoot, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'entry.txt'), 'ignored\n', 'utf8');
  }
}

function indexedNames(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${index.toString().padStart(5, '0')}`,
  );
}

function createDiscoveryFixture(
  names: readonly string[],
  ignoreLines: readonly string[] = names.map((name) => `/${name}/`),
): RepositoryFixture {
  const fixture = createRepository(ignoreLines);
  createIgnoredDirectories(fixture.repositoryRoot, names);
  return fixture;
}

function createApplyFixture(): ApplyFixture {
  const names = indexedNames('shared-cache', 9);
  const fixture = createRepository(names.map((name) => `/${name}/`));
  createIgnoredDirectories(fixture.repositoryRoot, names);
  const worktreesRoot = path.join(fixture.temporaryRoot, 'worktrees');
  fs.mkdirSync(worktreesRoot);
  const worktreePaths = Array.from(
    { length: WARMUP_ITERATIONS + MEASURED_ITERATIONS },
    (_, index) => {
      const worktreePath = path.join(worktreesRoot, `sample-${index}`);
      git(fixture.repositoryRoot, [
        'worktree',
        'add',
        '-q',
        '-b',
        `performance/sample-${index}`,
        worktreePath,
      ]);
      return worktreePath;
    },
  );
  return {
    ...fixture,
    excludePath: path.join(fixture.repositoryRoot, '.git', 'info', 'exclude'),
    names,
    worktreePaths,
  };
}

function summarizeDurations(durations: readonly number[]): { p50Ms: number; p95Ms: number } {
  const ordered = [...durations].sort((left, right) => left - right);
  const percentile = (value: number): number =>
    ordered[Math.ceil(ordered.length * value) - 1] ?? Number.POSITIVE_INFINITY;
  return { p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

async function measureDiscovery(
  fixture: RepositoryFixture,
  expectedCount: number,
): Promise<{
  gitProcessesPerCall: number;
  p50Ms: number;
  p95Ms: number;
}> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    await getWorktreeSymlinkCandidates(fixture.repositoryRoot);
  }
  resetBackendRuntimeDiagnostics();

  const durations: number[] = [];
  for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
    const startedAt = performance.now();
    const result = await getWorktreeSymlinkCandidates(fixture.repositoryRoot);
    durations.push(performance.now() - startedAt);
    expect(result.candidates).toHaveLength(Math.min(expectedCount, 128));
    expect(result.truncated).toBe(expectedCount > 128);
  }
  const gitProcesses = getGitSubprocessCount();
  expect(gitProcesses).toBe(MEASURED_ITERATIONS * DISCOVERY_GIT_PROCESSES_PER_CALL);
  return {
    ...summarizeDurations(durations),
    gitProcessesPerCall: gitProcesses / MEASURED_ITERATIONS,
  };
}

beforeAll(() => {
  normalFixture = createDiscoveryFixture(indexedNames('normal-cache', 9));
  largeFixture = createDiscoveryFixture(indexedNames('large-cache', 10_000), ['/large-cache-*/']);
  applyFixture = createApplyFixture();
}, 60_000);

afterAll(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  temporaryRoots.clear();
  resetBackendRuntimeDiagnostics();
}, 60_000);

describe('worktree link performance with real Git repositories', () => {
  it('keeps normal and 10,000-entry discovery within their real-Git p95 budgets', async () => {
    const normal = await measureDiscovery(normalFixture, 9);
    const large = await measureDiscovery(largeFixture, 10_000);

    process.stderr.write(
      `[benchmark][worktree-link-real-git-discovery] ${JSON.stringify({
        large: {
          fixtureEntries: 10_000,
          gitProcessesPerCall: large.gitProcessesPerCall,
          p50Ms: Number(large.p50Ms.toFixed(4)),
          p95Ms: Number(large.p95Ms.toFixed(4)),
        },
        measuredIterations: MEASURED_ITERATIONS,
        normal: {
          fixtureEntries: 9,
          gitProcessesPerCall: normal.gitProcessesPerCall,
          p50Ms: Number(normal.p50Ms.toFixed(4)),
          p95Ms: Number(normal.p95Ms.toFixed(4)),
        },
        warmupIterations: WARMUP_ITERATIONS,
      })}\n`,
    );

    expect(normal.p95Ms).toBeLessThanOrEqual(NORMAL_DISCOVERY_P95_BUDGET_MS);
    expect(large.p95Ms).toBeLessThanOrEqual(LARGE_DISCOVERY_P95_BUDGET_MS);
  }, 60_000);

  it('keeps fresh nine-entry exclude/link application within its real-Git p95 budget', async () => {
    const request = encodeTaskWorktreeLinkRequestV1(applyFixture.names);
    for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
      fs.writeFileSync(applyFixture.excludePath, '', 'utf8');
      const result = await applyRequestedWorktreeSymlinks(
        applyFixture.repositoryRoot,
        applyFixture.worktreePaths[index] ?? '',
        request,
      );
      expect(result).toEqual({ warnings: [] });
    }
    resetBackendRuntimeDiagnostics();

    const durations: number[] = [];
    for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
      const worktreePath = applyFixture.worktreePaths[index + WARMUP_ITERATIONS];
      if (!worktreePath) {
        throw new Error('Prepared worktree fixture is missing');
      }
      fs.writeFileSync(applyFixture.excludePath, '', 'utf8');
      const startedAt = performance.now();
      const result = await applyRequestedWorktreeSymlinks(
        applyFixture.repositoryRoot,
        worktreePath,
        request,
      );
      durations.push(performance.now() - startedAt);
      expect(result).toEqual({ warnings: [] });
    }

    const gitProcesses = getGitSubprocessCount();
    const summary = summarizeDurations(durations);
    process.stderr.write(
      `[benchmark][worktree-link-real-git-apply] ${JSON.stringify({
        fixtureEntries: applyFixture.names.length,
        gitProcessesPerCall: gitProcesses / MEASURED_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
        p50Ms: Number(summary.p50Ms.toFixed(4)),
        p95Ms: Number(summary.p95Ms.toFixed(4)),
        warmupIterations: WARMUP_ITERATIONS,
      })}\n`,
    );

    expect(gitProcesses).toBe(MEASURED_ITERATIONS * APPLY_GIT_PROCESSES_PER_CALL);
    expect(summary.p95Ms).toBeLessThanOrEqual(NINE_ENTRY_APPLY_P95_BUDGET_MS);
  }, 60_000);
});
