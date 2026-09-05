import fs from 'node:fs';
import path from 'node:path';
import { execGit } from './git-exec.js';
import { withWorktreeLock } from './git-cache.js';

async function repositoryLockKey(repoPath: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', '--git-common-dir'], { cwd: repoPath });
  const commonDir = stdout.trim();
  const commonPath = path.isAbsolute(commonDir) ? commonDir : path.join(repoPath, commonDir);
  try {
    return fs.realpathSync(commonPath);
  } catch {
    return commonPath;
  }
}

/** Serialize shared-checkout admission and Git branch-changing operations for one repository. */
export async function withRepositoryWorktreeLock<T>(
  repoPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = await repositoryLockKey(repoPath).catch(() => repoPath);
  return withWorktreeLock(lockKey, operation);
}
