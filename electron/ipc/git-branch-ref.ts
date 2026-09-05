import { execGit } from './git-exec.js';
import { cacheKey, withGitQueryCache } from './git-cache.js';

export function getBranchUpstreamRef(repoRoot: string, branch: string): Promise<string> {
  return withGitQueryCache(`branch-upstream:${cacheKey(repoRoot)}:${branch}`, async () => {
    try {
      const { stdout } = await execGit(
        ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`],
        { cwd: repoRoot },
      );
      const upstream = stdout.trim();
      if (upstream.startsWith('refs/remotes/')) return upstream;
    } catch {
      // Untracked local branches retain the conventional origin comparison fallback.
    }
    return `origin/${branch}`;
  });
}

/** Resolve the branch labels shared by the picker, task creation, and Git queries. */
export async function resolveBranchRef(
  repoRoot: string,
  branch = 'HEAD',
): Promise<{ exists: boolean; refName: string }> {
  for (const refName of branch === 'HEAD' ? [branch] : [branch, `origin/${branch}`]) {
    try {
      await execGit(['rev-parse', '--verify', refName], { cwd: repoRoot });
      return { exists: true, refName };
    } catch {
      // A bare origin branch label may only have a remote-tracking ref in this checkout.
    }
  }
  return { exists: false, refName: branch };
}
