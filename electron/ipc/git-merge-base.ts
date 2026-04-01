import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export async function getMergeBaseOrFallback(
  repoPath: string,
  leftRef: string,
  rightRef: string,
  fallbackRef: string,
): Promise<string> {
  try {
    const { stdout } = await exec('git', ['merge-base', leftRef, rightRef], {
      cwd: repoPath,
    });
    const mergeBase = stdout.trim();
    return mergeBase || fallbackRef;
  } catch {
    return fallbackRef;
  }
}
