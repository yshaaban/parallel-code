import { execGit } from './git-exec.js';

export async function getMergeBaseOrFallback(
  repoPath: string,
  leftRef: string,
  rightRef: string,
  fallbackRef: string,
): Promise<string> {
  try {
    const { stdout } = await execGit(['merge-base', leftRef, rightRef], {
      cwd: repoPath,
    });
    const mergeBase = stdout.trim();
    return mergeBase || fallbackRef;
  } catch {
    return fallbackRef;
  }
}
