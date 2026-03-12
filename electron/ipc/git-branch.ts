import { execFile } from 'child_process';
import { promisify } from 'util';

import { getCachedMainBranch, setCachedMainBranch } from './git-cache.js';

const exec = promisify(execFile);

export async function detectMainBranch(repoRoot: string): Promise<string> {
  const cached = getCachedMainBranch(repoRoot);
  if (cached) return cached;
  const result = await detectMainBranchUncached(repoRoot);
  setCachedMainBranch(repoRoot, result);
  return result;
}

async function detectMainBranchUncached(repoRoot: string): Promise<string> {
  // Try remote HEAD reference first
  try {
    const { stdout } = await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoRoot,
    });
    const refname = stdout.trim();
    const prefix = 'refs/remotes/origin/';
    if (refname.startsWith(prefix)) return refname.slice(prefix.length);
  } catch {
    /* ignore */
  }

  // Check if 'main' exists
  try {
    await exec('git', ['rev-parse', '--verify', 'main'], { cwd: repoRoot });
    return 'main';
  } catch {
    /* ignore */
  }

  // Fallback to 'master'
  try {
    await exec('git', ['rev-parse', '--verify', 'master'], { cwd: repoRoot });
    return 'master';
  } catch {
    /* ignore */
  }

  // Empty repo (no commits yet) — use configured default branch or fall back to "main"
  try {
    const { stdout } = await exec('git', ['config', '--get', 'init.defaultBranch'], {
      cwd: repoRoot,
    });
    const configured = stdout.trim();
    if (configured) return configured;
  } catch {
    /* ignore */
  }

  return 'main';
}

export async function getCurrentBranchName(repoRoot: string): Promise<string> {
  const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}
