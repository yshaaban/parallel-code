import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { detectMainBranch, getCurrentBranchName } from './git-branch.js';
import { execGit } from './git-exec.js';
import { getMergeBaseOrFallback } from './git-merge-base.js';
import { invalidateGitQueryCacheForPath, withWorktreeLock } from './git-cache.js';
import { parseConflictPath } from './git-status-parser.js';
import { removeWorktree } from './git-worktree.js';
import { recordGitSubprocessStarted } from './runtime-diagnostics.js';
import type { MergeResult, MergeStatus } from '../../src/ipc/types.js';
const PUSH_STDERR_BUFFER_LIMIT = 4096;
const STDERR_PRIORITY_LINE_PATTERN = /^(?:fatal|error):|^remote:\s*(?:fatal|error):/i;

function appendStderrTail(buffer: string, text: string): string {
  const nextBuffer = buffer + text;
  if (nextBuffer.length <= PUSH_STDERR_BUFFER_LIMIT) {
    return nextBuffer;
  }

  return nextBuffer.slice(-PUSH_STDERR_BUFFER_LIMIT);
}

function getLastRelevantStderrLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && STDERR_PRIORITY_LINE_PATTERN.test(line)) {
      return line;
    }
  }

  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

async function detectRepoLockKey(repoPath: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--git-common-dir'], { cwd: repoPath });
  const commonDir = stdout.trim();
  const commonPath = path.isAbsolute(commonDir) ? commonDir : path.join(repoPath, commonDir);
  try {
    return fs.realpathSync(commonPath);
  } catch {
    return commonPath;
  }
}

async function computeBranchDiffStats(
  projectRoot: string,
  mainBranch: string,
  branchName: string,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const mergeBase = await getMergeBaseOrFallback(projectRoot, mainBranch, branchName, mainBranch);
  const { stdout } = await execGit(['diff', '--numstat', mergeBase + '..' + branchName], {
    cwd: projectRoot,
  });

  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const rawAdded = parts[0];
    const rawRemoved = parts[1];
    if (!rawAdded || !rawRemoved) continue;

    linesAdded += parseInt(rawAdded, 10) || 0;
    linesRemoved += parseInt(rawRemoved, 10) || 0;
  }

  return { linesAdded, linesRemoved };
}

async function countBaseBranchCommitsAhead(
  worktreePath: string,
  mainBranch: string,
): Promise<number> {
  try {
    const { stdout } = await execGit(
      ['rev-list', '--count', '--cherry-pick', '--right-only', `HEAD...${mainBranch}`],
      {
        cwd: worktreePath,
      },
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function commitAll(worktreePath: string, message: string): Promise<void> {
  await execGit(['add', '-A'], { cwd: worktreePath });
  await execGit(['commit', '-m', message], { cwd: worktreePath });
  invalidateGitQueryCacheForPath(worktreePath);
}

export async function discardUncommitted(worktreePath: string): Promise<void> {
  await execGit(['checkout', '.'], { cwd: worktreePath });
  await execGit(['clean', '-fd'], { cwd: worktreePath });
  invalidateGitQueryCacheForPath(worktreePath);
}

async function getCurrentBranchOrNull(repoPath: string): Promise<string | null> {
  return getCurrentBranchName(repoPath).catch(() => null);
}

export async function checkMergeStatus(
  worktreePath: string,
  baseBranch?: string,
): Promise<MergeStatus> {
  const mainBranch = await detectMainBranch(worktreePath, baseBranch);
  const currentBranch = await getCurrentBranchOrNull(worktreePath);

  const mainAheadCount = await countBaseBranchCommitsAhead(worktreePath, mainBranch);

  if (mainAheadCount === 0) {
    return { current_branch: currentBranch, main_ahead_count: 0, conflicting_files: [] };
  }

  const conflictingFiles: string[] = [];
  try {
    await execGit(['merge-tree', '--write-tree', 'HEAD', mainBranch], { cwd: worktreePath });
  } catch (error: unknown) {
    for (const line of String(error).split('\n')) {
      const conflictPath = parseConflictPath(line);
      if (conflictPath) {
        conflictingFiles.push(conflictPath);
      }
    }
  }

  return {
    current_branch: currentBranch,
    main_ahead_count: mainAheadCount,
    conflicting_files: conflictingFiles,
  };
}

function createMergeBranchMismatchError(
  expectedBranch: string,
  currentBranch: string | null,
): Error {
  const currentLabel = currentBranch ?? 'detached HEAD';
  return new Error(
    "Task worktree is on '" +
      currentLabel +
      "', expected '" +
      expectedBranch +
      "'. Refresh the task branch before merging.",
  );
}

export async function mergeTask(
  projectRoot: string,
  worktreePath: string,
  branchName: string,
  squash: boolean,
  message: string | null,
  cleanup: boolean,
  baseBranch?: string,
): Promise<MergeResult> {
  const lockKey = await detectRepoLockKey(projectRoot).catch(() => projectRoot);

  return withWorktreeLock(lockKey, async () => {
    const currentBranch = await getCurrentBranchOrNull(worktreePath);
    if (currentBranch !== branchName) {
      throw createMergeBranchMismatchError(branchName, currentBranch);
    }

    const mainBranch = await detectMainBranch(projectRoot, baseBranch);
    const { linesAdded, linesRemoved } = await computeBranchDiffStats(
      projectRoot,
      mainBranch,
      branchName,
    );

    const { stdout: statusOut } = await execGit(['status', '--porcelain'], {
      cwd: projectRoot,
    });
    if (statusOut.trim()) {
      throw new Error(
        'Project root has uncommitted changes. Please commit or stash them before merging.',
      );
    }

    const originalBranch = await getCurrentBranchName(projectRoot).catch(() => null);

    await execGit(['checkout', mainBranch], { cwd: projectRoot });

    const restoreBranch = async (): Promise<void> => {
      if (!originalBranch) return;
      try {
        await execGit(['checkout', originalBranch], { cwd: projectRoot });
      } catch (error) {
        console.warn(`Failed to restore branch '${originalBranch}':`, error);
      }
    };

    if (squash) {
      try {
        await execGit(['merge', '--squash', '--', branchName], { cwd: projectRoot });
      } catch (error) {
        await execGit(['reset', '--hard', 'HEAD'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during squash recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Squash merge failed: ${error}`);
      }

      const commitMessage = message ?? 'Squash merge';
      try {
        await execGit(['commit', '-m', commitMessage], { cwd: projectRoot });
      } catch (error) {
        await execGit(['reset', '--hard', 'HEAD'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git reset --hard failed during commit recovery:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Commit failed: ${error}`);
      }
    } else {
      try {
        await execGit(['merge', '--', branchName], { cwd: projectRoot });
      } catch (error) {
        await execGit(['merge', '--abort'], { cwd: projectRoot }).catch((recoverErr) =>
          console.warn('git merge --abort failed:', recoverErr),
        );
        await restoreBranch();
        throw new Error(`Merge failed: ${error}`);
      }
    }

    invalidateGitQueryCacheForPath(projectRoot);

    if (cleanup) {
      await removeWorktree(projectRoot, branchName, true);
    }

    await restoreBranch();

    return {
      main_branch: mainBranch,
      lines_added: linesAdded,
      lines_removed: linesRemoved,
    };
  });
}

export async function pushTask(projectRoot: string, branchName: string): Promise<void> {
  await streamPushTask(projectRoot, branchName);
}

function getLastNonEmptyLine(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.split('\n').pop();
}

export async function streamPushTask(
  projectRoot: string,
  branchName: string,
  onOutput?: (text: string) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    recordGitSubprocessStarted();
    const proc = spawn('git', ['push', '--progress', '-u', 'origin', '--', branchName], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuffer = '';
    let lastRelevantStderrLine: string | undefined;
    let settled = false;

    function settleWithError(error: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    }

    function settleSuccess(): void {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    }

    function handleChunk(chunk: Buffer): void {
      const text = chunk.toString('utf8');
      onOutput?.(text);
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      handleChunk(chunk);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuffer = appendStderrTail(stderrBuffer, text);
      lastRelevantStderrLine = getLastRelevantStderrLine(text) ?? lastRelevantStderrLine;
      onOutput?.(text);
    });

    proc.on('error', (error) => {
      settleWithError(new Error(`git push failed: ${error.message}`));
    });

    proc.on('close', (code, signal) => {
      if (code === 0) {
        settleSuccess();
        return;
      }

      const lastStderrLine = lastRelevantStderrLine ?? getLastNonEmptyLine(stderrBuffer);
      if (lastStderrLine) {
        settleWithError(new Error(lastStderrLine));
        return;
      }

      if (signal) {
        settleWithError(new Error(`git push killed by signal ${signal}`));
        return;
      }

      settleWithError(new Error(`git push exited with code ${code ?? 'unknown'}`));
    });
  });
}

export async function rebaseTask(worktreePath: string, baseBranch?: string): Promise<void> {
  const lockKey = await detectRepoLockKey(worktreePath).catch(() => worktreePath);

  return withWorktreeLock(lockKey, async () => {
    const mainBranch = await detectMainBranch(worktreePath, baseBranch);
    try {
      await execGit(['rebase', mainBranch], { cwd: worktreePath });
    } catch (error) {
      await execGit(['rebase', '--abort'], { cwd: worktreePath }).catch((recoverErr) =>
        console.warn('git rebase --abort failed:', recoverErr),
      );
      throw new Error(`Rebase failed: ${error}`);
    }

    invalidateGitQueryCacheForPath(worktreePath);
  });
}
