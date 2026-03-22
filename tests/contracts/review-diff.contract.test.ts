import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IPC } from '../../electron/ipc/channels.js';
import type { FileDiffResult, ProjectDiffResult } from '../../src/ipc/types.js';
import {
  createInteractiveNodeScenario,
  type BrowserLabScenario,
} from '../browser/harness/scenarios.js';
import {
  startStandaloneBrowserServer,
  type BrowserLabServer,
} from '../browser/harness/standalone-server.js';

interface BrowserLabIpcServer {
  authToken: string;
  baseUrl: string;
}

function git(repoDir: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readGit(repoDir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
  });
}

function writeRepoFile(repoDir: string, relativePath: string, content: string | Buffer): void {
  const filePath = path.join(repoDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function deleteRepoFile(repoDir: string, relativePath: string): void {
  rmSync(path.join(repoDir, relativePath), { force: true });
}

function commitRepoFiles(repoDir: string, message: string, ...paths: string[]): void {
  git(repoDir, 'add', ...paths);
  git(repoDir, 'commit', '-m', message);
}

async function invokeStandaloneIpc<TResult>(
  server: BrowserLabIpcServer,
  channel: IPC,
  body?: unknown,
): Promise<TResult> {
  const response = await fetch(`${server.baseUrl}/api/ipc/${channel}`, {
    body: JSON.stringify(body ?? {}),
    headers: {
      Authorization: `Bearer ${server.authToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  expect(response.ok).toBe(true);
  const payload = (await response.json()) as { result: TResult };
  return payload.result;
}

function listPaths(result: ProjectDiffResult): string[] {
  return result.files.map((file) => file.path).sort();
}

const reviewDiffLifecycleScenario: BrowserLabScenario = {
  ...createInteractiveNodeScenario(),
  name: 'review-diff-contract',
  async seedRepo(repoDir: string): Promise<void> {
    writeRepoFile(repoDir, 'src/flip.ts', 'export const version = "main";\n');
    writeRepoFile(repoDir, 'src/deleted.ts', 'export const deleted = true;\n');
    writeRepoFile(repoDir, 'assets/blob.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
    commitRepoFiles(
      repoDir,
      'seed review diff contract files',
      'src/flip.ts',
      'src/deleted.ts',
      'assets/blob.bin',
    );
    git(repoDir, 'checkout', '-B', 'browser-lab/e2e');
  },
  taskName: 'Review Diff Contract',
};

describe('review diff contract', () => {
  let server: BrowserLabServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('tracks worktree, committed branch, and base-branch catch-up without a browser session', async () => {
    server = await startStandaloneBrowserServer({
      scenario: reviewDiffLifecycleScenario,
      testSlug: 'review-diff-contract-lifecycle',
      validateBrowserBuildArtifacts: false,
    });

    const repoDir = server.repoDir;
    writeRepoFile(repoDir, 'src/flip.ts', 'export const version = "worktree";\n');
    writeRepoFile(repoDir, 'src/added.ts', 'export const added = true;\n');
    deleteRepoFile(repoDir, 'src/deleted.ts');
    writeRepoFile(repoDir, 'assets/blob.bin', Buffer.from([0x10, 0x11, 0x12, 0xff, 0x20]));

    const unstagedDiff = await invokeStandaloneIpc<ProjectDiffResult>(server, IPC.GetProjectDiff, {
      mode: 'unstaged',
      worktreePath: repoDir,
    });
    expect(listPaths(unstagedDiff)).toEqual([
      'assets/blob.bin',
      'src/added.ts',
      'src/deleted.ts',
      'src/flip.ts',
    ]);

    const worktreeFlipDiff = await invokeStandaloneIpc<FileDiffResult>(server, IPC.GetFileDiff, {
      filePath: 'src/flip.ts',
      status: 'M',
      worktreePath: repoDir,
    });
    expect(worktreeFlipDiff.diff).toContain('export const version = "worktree";');

    const worktreeAddedDiff = await invokeStandaloneIpc<FileDiffResult>(server, IPC.GetFileDiff, {
      filePath: 'src/added.ts',
      status: '?',
      worktreePath: repoDir,
    });
    expect(worktreeAddedDiff.diff).toContain('diff --git a/src/added.ts b/src/added.ts');
    expect(worktreeAddedDiff.diff).toContain('export const added = true;');

    const worktreeBinaryDiff = await invokeStandaloneIpc<FileDiffResult>(server, IPC.GetFileDiff, {
      filePath: 'assets/blob.bin',
      status: 'M',
      worktreePath: repoDir,
    });
    expect(worktreeBinaryDiff.diff).toContain('Binary files');

    await invokeStandaloneIpc<null>(server, IPC.CommitAll, {
      message: 'review diff contract refresh',
      worktreePath: repoDir,
    });

    expect(
      readGit(repoDir, 'diff', '--name-status', 'main..HEAD').trim().split('\n').sort(),
    ).toEqual(['A\tsrc/added.ts', 'D\tsrc/deleted.ts', 'M\tassets/blob.bin', 'M\tsrc/flip.ts']);

    const branchDiff = await invokeStandaloneIpc<ProjectDiffResult>(server, IPC.GetProjectDiff, {
      mode: 'branch',
      worktreePath: repoDir,
    });
    expect(listPaths(branchDiff)).toEqual([
      'assets/blob.bin',
      'src/added.ts',
      'src/deleted.ts',
      'src/flip.ts',
    ]);

    const committedFlipDiff = await invokeStandaloneIpc<FileDiffResult>(
      server,
      IPC.GetFileDiffFromBranch,
      {
        branchName: 'browser-lab/e2e',
        filePath: 'src/flip.ts',
        projectRoot: repoDir,
        status: 'M',
      },
    );
    expect(committedFlipDiff.diff).toContain('export const version = "worktree";');

    const committedDeletedDiff = await invokeStandaloneIpc<FileDiffResult>(
      server,
      IPC.GetFileDiffFromBranch,
      {
        branchName: 'browser-lab/e2e',
        filePath: 'src/deleted.ts',
        projectRoot: repoDir,
        status: 'D',
      },
    );
    expect(committedDeletedDiff.diff).toContain('deleted file mode');
    expect(committedDeletedDiff.diff).toContain('export const deleted = true;');

    const committedBinaryDiff = await invokeStandaloneIpc<FileDiffResult>(
      server,
      IPC.GetFileDiffFromBranch,
      {
        branchName: 'browser-lab/e2e',
        filePath: 'assets/blob.bin',
        projectRoot: repoDir,
        status: 'M',
      },
    );
    expect(committedBinaryDiff.diff).toContain('Binary files');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'merge', '--ff-only', 'browser-lab/e2e');
    git(repoDir, 'checkout', 'browser-lab/e2e');

    const clearedBranchDiff = await invokeStandaloneIpc<ProjectDiffResult>(
      server,
      IPC.GetProjectDiff,
      {
        mode: 'branch',
        worktreePath: repoDir,
      },
    );
    const clearedAllDiff = await invokeStandaloneIpc<ProjectDiffResult>(
      server,
      IPC.GetProjectDiff,
      {
        mode: 'all',
        worktreePath: repoDir,
      },
    );

    expect(clearedBranchDiff.files).toEqual([]);
    expect(clearedAllDiff.files).toEqual([]);
  }, 30_000);
});
