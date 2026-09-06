import { detectMainBranch, getCurrentBranchName } from './git-branch.js';
import { resolveBranchRef } from './git-branch-ref.js';
import { execGit, GitSpawnTimeoutError, spawnGitWithDeadline } from './git-exec.js';
import { getMergeBaseOrFallback } from './git-merge-base.js';
import { invalidateGitQueryCacheForPath } from './git-cache.js';
import { withRepositoryWorktreeLock } from './git-worktree-lock.js';
import { parseConflictPath } from './git-status-parser.js';
import { removeWorktree } from './git-worktree.js';
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
  const { exists, refName: mainBranch } = await resolveBranchRef(
    worktreePath,
    await detectMainBranch(worktreePath, baseBranch),
  );
  if (!exists) throw new Error(`Base branch "${baseBranch ?? mainBranch}" is unavailable.`);
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
  isProjectRootShared?: (projectRoot: string) => boolean,
): Promise<MergeResult> {
  return withRepositoryWorktreeLock(projectRoot, async () => {
    if (isProjectRootShared?.(projectRoot)) {
      throw new Error(
        'Close project-root tasks before merging. Running agents and shells share this checkout and its index; automatic merges require an unoccupied project root.',
      );
    }
    const currentBranch = await getCurrentBranchOrNull(worktreePath);
    if (currentBranch !== branchName) {
      throw createMergeBranchMismatchError(branchName, currentBranch);
    }

    const requestedBaseBranch = await detectMainBranch(projectRoot, baseBranch);
    const target = await resolveBranchRef(projectRoot, requestedBaseBranch);
    const targetRef =
      target.refName === 'HEAD'
        ? await execGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: projectRoot })
            .then(({ stdout }) => stdout.trim())
            .catch(() => '')
        : target.refName;
    if (!target.exists || !targetRef.startsWith('refs/heads/') || targetRef.includes('\n')) {
      throw new Error(
        `Merge target "${requestedBaseBranch}" is not a local branch. Create or select a local tracking branch before merging.`,
      );
    }
    const mainBranch = targetRef.slice('refs/heads/'.length);
    const { stdout: sourceTip } = await execGit(
      ['rev-parse', '--verify', `refs/heads/${branchName}`],
      { cwd: projectRoot },
    );
    const sourceCommit = sourceTip.trim();
    const { linesAdded, linesRemoved } = await computeBranchDiffStats(
      projectRoot,
      targetRef,
      sourceCommit,
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
    if (originalBranch !== mainBranch) {
      await execGit(['switch', '--', mainBranch], { cwd: projectRoot });
    }

    const restoreBranch = async (): Promise<void> => {
      if (!originalBranch || originalBranch === mainBranch) return;
      try {
        await execGit(['switch', '--', originalBranch], { cwd: projectRoot });
      } catch (error) {
        console.warn(`Failed to restore branch '${originalBranch}':`, error);
      }
    };

    const recoveryMessage = `The checkout and index were preserved on "${mainBranch}". Inspect the project root and resolve or abort the operation manually before retrying.`;

    if (squash) {
      try {
        await execGit(['merge', '--squash', '--', sourceCommit], { cwd: projectRoot });
      } catch (error) {
        invalidateGitQueryCacheForPath(projectRoot);
        throw new Error(`Squash merge failed: ${error}. ${recoveryMessage}`);
      }

      const commitMessage = message ?? 'Squash merge';
      try {
        await execGit(['commit', '-m', commitMessage], { cwd: projectRoot });
      } catch (error) {
        invalidateGitQueryCacheForPath(projectRoot);
        throw new Error(`Commit failed: ${error}. ${recoveryMessage}`);
      }
    } else {
      try {
        const { stdout: mergeMessage } = await execGit(['fmt-merge-msg'], {
          cwd: projectRoot,
          input: `${sourceCommit}\t\tbranch '${branchName}' of .\n`,
        });
        await execGit(['merge', '-m', mergeMessage.trim(), '--', sourceCommit], {
          cwd: projectRoot,
        });
      } catch (error) {
        invalidateGitQueryCacheForPath(projectRoot);
        const alreadyContained = await execGit(
          ['merge-base', '--is-ancestor', sourceCommit, targetRef],
          { cwd: projectRoot },
        )
          .then(() => true)
          .catch(() => false);
        const outcome = alreadyContained
          ? 'The target branch already contains the task commit, but the merge command failed'
          : 'Merge failed';
        throw new Error(`${outcome}: ${error}. ${recoveryMessage}`);
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
  const {
    child: proc,
    completion,
    terminate,
  } = spawnGitWithDeadline(['push', '--progress', '-u', 'origin', '--', branchName], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuffer = '';
  let lastRelevantStderrLine: string | undefined;

  function handleStdout(chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    onOutput?.(text);
  }

  function handleStderr(chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    stderrBuffer = appendStderrTail(stderrBuffer, text);
    lastRelevantStderrLine = getLastRelevantStderrLine(text) ?? lastRelevantStderrLine;
    onOutput?.(text);
  }

  function handleStreamError(error: Error): void {
    terminate(error);
  }

  proc.stdout?.on('data', handleStdout);
  proc.stdout?.on('error', handleStreamError);
  proc.stderr?.on('data', handleStderr);
  proc.stderr?.on('error', handleStreamError);

  try {
    let code: number | null;
    let signal: NodeJS.Signals | null;
    try {
      ({ code, signal } = await completion);
    } catch (error) {
      if (error instanceof GitSpawnTimeoutError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`git push failed: ${message}`);
    }

    if (code === 0) {
      return;
    }

    const lastStderrLine = lastRelevantStderrLine ?? getLastNonEmptyLine(stderrBuffer);
    if (lastStderrLine) {
      throw new Error(lastStderrLine);
    }

    if (signal) {
      throw new Error(`git push killed by signal ${signal}`);
    }

    throw new Error(`git push exited with code ${code ?? 'unknown'}`);
  } finally {
    proc.stdout?.off('data', handleStdout);
    proc.stdout?.off('error', handleStreamError);
    proc.stderr?.off('data', handleStderr);
    proc.stderr?.off('error', handleStreamError);
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  }
}

export async function rebaseTask(worktreePath: string, baseBranch?: string): Promise<void> {
  return withRepositoryWorktreeLock(worktreePath, async () => {
    const { exists, refName: mainBranch } = await resolveBranchRef(
      worktreePath,
      await detectMainBranch(worktreePath, baseBranch),
    );
    if (!exists) throw new Error(`Base branch "${baseBranch ?? mainBranch}" is unavailable.`);
    try {
      await execGit(['rebase', mainBranch], { cwd: worktreePath });
    } catch (error) {
      invalidateGitQueryCacheForPath(worktreePath);
      throw new Error(
        `Rebase failed: ${error}. The checkout and index were preserved. Inspect the task checkout and continue or abort the rebase manually before retrying.`,
      );
    }

    invalidateGitQueryCacheForPath(worktreePath);
  });
}
