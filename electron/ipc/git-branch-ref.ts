import { execGit } from './git-exec.js';
import { cacheKey, withGitQueryCache } from './git-cache.js';

export function getBranchUpstreamRef(repoRoot: string, branch: string): Promise<string | null> {
  return withGitQueryCache(`branch-upstream:${cacheKey(repoRoot)}:${branch}`, async () => {
    const resolved = await resolveBranchRef(repoRoot, branch);
    if (!resolved.exists) return null;
    if (resolved.refName.startsWith('refs/remotes/')) return resolved.refName;
    let localRef = resolved.refName;
    try {
      if (localRef === 'HEAD')
        localRef = (
          await execGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoRoot })
        ).stdout.trim();
      if (!localRef.startsWith('refs/heads/')) return null;
      const { stdout } = await execGit(['for-each-ref', '--format=%(upstream)', localRef], {
        cwd: repoRoot,
      });
      const upstream = stdout.trim();
      if (
        upstream.startsWith('refs/remotes/') &&
        (await resolveBranchRef(repoRoot, upstream)).exists
      )
        return upstream;
    } catch {
      // Untracked local branches retain the conventional origin comparison fallback.
    }
    if (!localRef.startsWith('refs/heads/')) return null;
    const fallback = await resolveBranchRef(
      repoRoot,
      `refs/remotes/origin/${localRef.slice('refs/heads/'.length)}`,
    );
    return fallback.exists ? fallback.refName : null;
  });
}

/** Resolve the branch labels shared by the picker, task creation, and Git queries. */
export async function resolveBranchRef(
  repoRoot: string,
  branch = 'HEAD',
): Promise<{ exists: boolean; refName: string }> {
  const refs =
    branch === 'HEAD'
      ? ['HEAD']
      : branch.startsWith('refs/')
        ? branch.startsWith('refs/heads/') || branch.startsWith('refs/remotes/')
          ? [branch]
          : []
        : [`refs/heads/${branch}`, `refs/remotes/${branch}`, `refs/remotes/origin/${branch}`];
  for (const refName of refs) {
    try {
      // show-ref verifies exact ref names, never tag precedence or revision expressions such as ~1.
      await execGit(
        refName === 'HEAD'
          ? ['rev-parse', '--verify', 'HEAD']
          : ['show-ref', '--verify', '--hash', refName],
        { cwd: repoRoot },
      );
      return { exists: true, refName };
    } catch {
      // A bare origin branch label may only have a remote-tracking ref in this checkout.
    }
  }
  return { exists: false, refName: branch };
}
