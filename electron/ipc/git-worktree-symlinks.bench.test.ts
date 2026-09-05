import { performance } from 'node:perf_hooks';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execGitBufferMock, execGitMock } = vi.hoisted(() => ({
  execGitBufferMock: vi.fn(),
  execGitMock: vi.fn(),
}));

vi.mock('./git-exec.js', () => ({
  execGit: execGitMock,
  execGitBuffer: execGitBufferMock,
}));

import {
  MAX_WORKTREE_SYMLINK_REQUEST_BYTES,
  applyRequestedWorktreeSymlinks,
  encodeTaskWorktreeLinkRequestV1,
  getWorktreeSymlinkCandidates,
} from './git-worktree-symlinks.js';

const MAX_CANONICAL_BYTES = 16 * 1024;
const NORMAL_DISCOVERY_P95_BUDGET_MS = 150;
const LARGE_DISCOVERY_P95_BUDGET_MS = 500;
const NINE_ENTRY_APPLY_P95_BUDGET_MS = 250;
const DISCOVERY_GIT_PROCESS_CEILING = 2;
const APPLY_GIT_PROCESS_CEILING = 4;
const temporaryRoots = new Set<string>();

let commonDirectory = '';
let discoveryOutput = Buffer.alloc(0);

beforeEach(() => {
  commonDirectory = '';
  discoveryOutput = Buffer.alloc(0);
  execGitMock.mockReset();
  execGitBufferMock.mockReset();
  execGitMock.mockImplementation((args: readonly string[]) => {
    if (args[0] === 'config') {
      return Promise.resolve({ stderr: '', stdout: 'false\n' });
    }
    if (args[0] === 'rev-parse') {
      if (!commonDirectory) {
        return Promise.reject(new Error('The benchmark common directory is not configured'));
      }
      return Promise.resolve({ stderr: '', stdout: `${commonDirectory}\n` });
    }
    return Promise.reject(new Error(`Unexpected text Git command: ${args.join(' ')}`));
  });
  execGitBufferMock.mockImplementation(
    (args: readonly string[], options?: { input?: Buffer | string }) => {
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stderr: Buffer.alloc(0), stdout: discoveryOutput });
      }
      if (args[0] === 'check-ignore') {
        const input = options?.input;
        return Promise.resolve({
          stderr: Buffer.alloc(0),
          stdout: Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input ?? '', 'utf8'),
        });
      }
      return Promise.reject(new Error(`Unexpected buffer Git command: ${args.join(' ')}`));
    },
  );
});

afterEach(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  temporaryRoots.clear();
});

function fixedLengthName(index: number, byteLength: number): string {
  const prefix = `${index.toString(16).padStart(2, '0')}-`;
  return `${prefix}${'x'.repeat(byteLength - prefix.length)}`;
}

function exactMaximumNames(): string[] {
  return [
    ...Array.from({ length: 63 }, (_, index) => fixedLengthName(index, 255)),
    fixedLengthName(63, 189),
  ];
}

function discoveryNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `cache-${index.toString().padStart(5, '0')}`);
}

function setDiscoveryNames(names: readonly string[]): void {
  discoveryOutput = Buffer.from(names.map((name) => `${name}/\0`).join(''), 'utf8');
}

function clearGitProcessCalls(): void {
  execGitMock.mockClear();
  execGitBufferMock.mockClear();
}

function gitProcessCount(): number {
  return execGitMock.mock.calls.length + execGitBufferMock.mock.calls.length;
}

function gitCommandCount(command: string): number {
  return [...execGitMock.mock.calls, ...execGitBufferMock.mock.calls].filter((call) => {
    const args = call[0] as readonly string[];
    return args[0] === command;
  }).length;
}

function summarizeDurations(durations: readonly number[]): { p50Ms: number; p95Ms: number } {
  const ordered = [...durations].sort((left, right) => left - right);
  const percentile = (value: number): number =>
    ordered[Math.ceil(ordered.length * value) - 1] ?? Number.POSITIVE_INFINITY;
  return { p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

async function measureDiscovery(
  names: readonly string[],
  iterations: number,
): Promise<{ p50Ms: number; p95Ms: number }> {
  setDiscoveryNames(names);
  for (let index = 0; index < 5; index += 1) {
    await getWorktreeSymlinkCandidates('/benchmark/project');
  }
  clearGitProcessCalls();

  const durations: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = await getWorktreeSymlinkCandidates('/benchmark/project');
    durations.push(performance.now() - startedAt);
    expect(result.candidates).toHaveLength(Math.min(names.length, 128));
    expect(result.truncated).toBe(names.length > 128);
  }
  expect(gitProcessCount()).toBe(iterations * DISCOVERY_GIT_PROCESS_CEILING);
  expect(gitCommandCount('config')).toBe(iterations);
  expect(gitCommandCount('ls-files')).toBe(iterations);
  return summarizeDurations(durations);
}

function createApplyFixture(names: readonly string[]): {
  projectRoot: string;
  worktreePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-worktree-link-bench-'));
  temporaryRoots.add(root);
  const projectRoot = path.join(root, 'project');
  const worktreePath = path.join(root, 'worktree');
  commonDirectory = path.join(root, 'common.git');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(worktreePath);
  fs.mkdirSync(commonDirectory);
  for (const name of names) {
    fs.mkdirSync(path.join(projectRoot, name));
  }
  setDiscoveryNames(names);
  return { projectRoot, worktreePath };
}

async function applyFixture(names: readonly string[]): Promise<void> {
  const fixture = createApplyFixture(names);
  const result = await applyRequestedWorktreeSymlinks(
    fixture.projectRoot,
    fixture.worktreePath,
    encodeTaskWorktreeLinkRequestV1(names),
  );
  expect(result).toEqual({ warnings: [] });
}

function getFingerprintInput(encodedBytes: Readonly<Uint8Array>): string {
  return Buffer.from(
    encodedBytes.buffer,
    encodedBytes.byteOffset,
    encodedBytes.byteLength,
  ).toString('base64');
}

describe('task worktree link request benchmark', () => {
  it('encodes, fingerprints, and reserves an exact-maximum V1 request below 1 ms p99', () => {
    const rawNames = exactMaximumNames();
    const iterations = 100_000;
    const durationsMs = new Float64Array(iterations);
    let observedLength = 0;

    for (let index = 0; index < 5_000; index += 1) {
      const request = encodeTaskWorktreeLinkRequestV1(rawNames);
      observedLength ^= getFingerprintInput(request.encodedBytes).length;
    }

    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      const request = encodeTaskWorktreeLinkRequestV1(rawNames);
      const fingerprintInput = getFingerprintInput(request.encodedBytes);
      const warningReservation = request.encodedLength + request.names.length;
      durationsMs[index] = performance.now() - startedAt;
      observedLength ^= fingerprintInput.length + warningReservation;
    }

    const orderedDurations = Array.from(durationsMs).sort((left, right) => left - right);
    const p99Ms =
      orderedDurations[Math.ceil(orderedDurations.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY;
    const sample = encodeTaskWorktreeLinkRequestV1(rawNames);
    const fingerprintInput = getFingerprintInput(sample.encodedBytes);
    // Conservative retained-payload accounting: canonical bytes, worst-case two-byte string,
    // name references, and 2 KiB of object/array overhead. Transient maps and buffers are not
    // reachable from the returned request or committed fingerprint.
    const retainedPayloadUpperBound =
      sample.encodedBytes.byteLength +
      fingerprintInput.length * 2 +
      sample.names.length * 8 +
      2 * 1024;

    process.stderr.write(
      `[benchmark][worktree-link-v1] iterations=${iterations} p99=${p99Ms.toFixed(4)}ms retainedUpperBound=${retainedPayloadUpperBound}B\n`,
    );

    expect(observedLength).toBeGreaterThanOrEqual(0);
    expect(sample.encodedLength).toBe(MAX_CANONICAL_BYTES);
    expect(sample.encodedLength).toBe(MAX_WORKTREE_SYMLINK_REQUEST_BYTES);
    expect(retainedPayloadUpperBound).toBeLessThan(64 * 1024);
    expect(p99Ms).toBeLessThan(1);
  }, 60_000);

  it('keeps the exact V1 boundary ahead of every Git process', () => {
    const exact = encodeTaskWorktreeLinkRequestV1(exactMaximumNames());
    expect(exact.encodedLength).toBe(MAX_WORKTREE_SYMLINK_REQUEST_BYTES);
    expect(() =>
      encodeTaskWorktreeLinkRequestV1([
        ...Array.from({ length: 63 }, (_, index) => fixedLengthName(index, 255)),
        fixedLengthName(63, 190),
      ]),
    ).toThrow(/canonical V1 encoding must be at most 16384 bytes/u);
    expect(gitProcessCount()).toBe(0);
  });

  it('meets normal and large discovery latency with exactly two Git processes', async () => {
    const iterations = 100;
    const normal = await measureDiscovery(discoveryNames(9), iterations);
    const large = await measureDiscovery(discoveryNames(10_000), iterations);

    process.stderr.write(
      `[benchmark][worktree-link-discovery] ${JSON.stringify({
        gitProcessesPerCall: DISCOVERY_GIT_PROCESS_CEILING,
        iterations,
        large: {
          candidateFixtureCount: 10_000,
          p50Ms: Number(large.p50Ms.toFixed(4)),
          p95Ms: Number(large.p95Ms.toFixed(4)),
        },
        normal: {
          candidateFixtureCount: 9,
          p50Ms: Number(normal.p50Ms.toFixed(4)),
          p95Ms: Number(normal.p95Ms.toFixed(4)),
        },
      })}\n`,
    );

    expect(normal.p95Ms).toBeLessThanOrEqual(NORMAL_DISCOVERY_P95_BUDGET_MS);
    expect(large.p95Ms).toBeLessThanOrEqual(LARGE_DISCOVERY_P95_BUDGET_MS);
  });

  it('applies nine entries below budget and keeps Git processes independent of selection count', async () => {
    const nineNames = discoveryNames(9);
    const iterations = 30;
    for (let index = 0; index < 3; index += 1) {
      await applyFixture(nineNames);
    }
    clearGitProcessCalls();

    const durations: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const fixture = createApplyFixture(nineNames);
      const startedAt = performance.now();
      const result = await applyRequestedWorktreeSymlinks(
        fixture.projectRoot,
        fixture.worktreePath,
        encodeTaskWorktreeLinkRequestV1(nineNames),
      );
      durations.push(performance.now() - startedAt);
      expect(result).toEqual({ warnings: [] });
    }
    const nineEntry = summarizeDurations(durations);
    expect(gitProcessCount()).toBe(iterations * APPLY_GIT_PROCESS_CEILING);
    expect(gitCommandCount('config')).toBe(iterations);
    expect(gitCommandCount('ls-files')).toBe(iterations);
    expect(gitCommandCount('rev-parse')).toBe(iterations);
    expect(gitCommandCount('check-ignore')).toBe(iterations);

    clearGitProcessCalls();
    await applyFixture(discoveryNames(128));
    const maxSelectionProcessCount = gitProcessCount();

    process.stderr.write(
      `[benchmark][worktree-link-apply] ${JSON.stringify({
        gitProcessCeiling: APPLY_GIT_PROCESS_CEILING,
        iterations,
        maxSelectionProcessCount,
        nineEntries: {
          p50Ms: Number(nineEntry.p50Ms.toFixed(4)),
          p95Ms: Number(nineEntry.p95Ms.toFixed(4)),
        },
      })}\n`,
    );

    expect(maxSelectionProcessCount).toBe(APPLY_GIT_PROCESS_CEILING);
    expect(nineEntry.p95Ms).toBeLessThanOrEqual(NINE_ENTRY_APPLY_P95_BUDGET_MS);
  }, 30_000);
});
