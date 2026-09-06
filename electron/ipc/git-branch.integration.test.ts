import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectMainBranch, listBranches } from './git-branch.js';
import { getChangedFilesFromBranch } from './git-diff-ops.js';
import { createWorktree } from './git-worktree.js';
import { encodeTaskWorktreeLinkRequestV1 } from './git-worktree-symlinks.js';
import { getBranchLog, getWorktreeStatus } from './git.js';
import { checkMergeStatus, mergeTask, rebaseTask } from './git-mutation-ops.js';
import { withRepositoryWorktreeLock } from './git-worktree-lock.js';
import { resolveBranchRef } from './git-branch-ref.js';
import { getBranchCommitHistory } from './git-commit-history.js';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(branch: string, commit = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-branch-'));
  roots.push(root);
  git(root, 'init', '-b', branch);
  git(root, 'config', 'user.name', 'Parallel Code');
  git(root, 'config', 'user.email', 'parallel-code@example.com');
  git(root, 'config', 'init.defaultBranch', 'unrelated-global-default');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n.worktrees/\n');
  if (commit) git(root, 'commit', '--allow-empty', '-m', 'initial');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('repository default branches', { timeout: 30_000 }, () => {
  it.each(['local', 'origin', 'upstream'])(
    'does not resolve a selected %s branch through a same-named tag',
    async (kind) => {
      const root = repository('trunk');
      git(root, 'tag', 'trunk');
      fs.writeFileSync(path.join(root, 'latest.txt'), 'latest branch bytes\n');
      git(root, 'add', 'latest.txt');
      git(root, 'commit', '-m', 'latest');
      const tip = git(root, 'rev-parse', 'refs/heads/trunk');
      let label = 'trunk';
      if (kind !== 'local') {
        git(root, 'branch', '-m', 'feature/local');
        git(root, 'update-ref', `refs/remotes/${kind}/trunk`, tip);
        if (kind === 'upstream') {
          label = 'upstream/trunk';
          git(root, 'tag', label, 'trunk');
        }
      }
      const task = await createWorktree(
        root,
        `task/${kind}`,
        encodeTaskWorktreeLinkRequestV1([]),
        false,
        label,
      );
      expect(git(task.path, 'rev-parse', 'HEAD')).toBe(tip);
      expect(fs.readFileSync(path.join(task.path, 'latest.txt'), 'utf8')).toBe(
        'latest branch bytes\n',
      );
      expect((await resolveBranchRef(root, label)).refName).toBe(
        kind === 'local' ? 'refs/heads/trunk' : `refs/remotes/${kind}/trunk`,
      );
      fs.writeFileSync(path.join(task.path, 'task-only.txt'), 'task bytes\n');
      git(task.path, 'add', 'task-only.txt');
      git(task.path, 'commit', '-m', 'task commit');
      git(root, 'tag', task.branch, tip);
      expect(await getChangedFilesFromBranch(root, task.branch, label)).toEqual([
        expect.objectContaining({ path: 'task-only.txt' }),
      ]);
      const history = await getBranchCommitHistory({
        projectRoot: root,
        branchName: task.branch,
        baseBranch: label,
      });
      expect(history.commits.map((commit) => commit.subject)).toEqual(['task commit']);
      expect(await getBranchLog(task.path, label)).toContain('task commit');
      if (kind === 'local') {
        await expect(
          mergeTask(root, task.path, task.branch, false, null, false, label),
        ).resolves.toMatchObject({ main_branch: 'trunk', lines_added: 1 });
      }
    },
  );

  it('keeps explicit HEAD revision semantics but rejects tags and raw revisions as branch selections', async () => {
    const root = repository('trunk');
    git(root, 'tag', 'release');
    const sha = git(root, 'rev-parse', 'HEAD');
    expect(await resolveBranchRef(root, 'HEAD')).toMatchObject({ exists: true, refName: 'HEAD' });
    for (const value of ['release', 'refs/tags/release', sha, 'HEAD~0']) {
      expect(await resolveBranchRef(root, value)).toMatchObject({ exists: false });
    }
  });
  it.each(['main', 'master', 'trunk', 'develop', 'release/stable'])(
    'uses the actual %s branch instead of the global initialization preference',
    async (branch) => {
      const root = repository(branch);
      expect(await detectMainBranch(root)).toBe(branch);
      expect((await listBranches(root)).branches[0]).toMatchObject({
        current: true,
        local: true,
        name: branch,
      });
    },
  );

  it('recognizes an unborn custom branch without inventing a commit or another branch', async () => {
    const root = repository('release/next', false);
    expect(await detectMainBranch(root)).toBe('release/next');
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('release/next');
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('');
  });

  it('uses the primary checkout branch when queried from a managed worktree', async () => {
    const root = repository('trunk');
    const task = await createWorktree(
      root,
      'task/one',
      encodeTaskWorktreeLinkRequestV1([]),
      false,
      'trunk',
    );
    expect(await detectMainBranch(task.path)).toBe('trunk');
    expect(git(task.path, 'symbolic-ref', '--short', 'HEAD')).toBe('task/one');
  });

  it.each(['missing', 'stale'])(
    'repairs a %s origin HEAD and creates from the remote-only custom default',
    async (headState) => {
      const origin = repository('release/stable');
      const root = repository('feature/local');
      git(root, 'remote', 'add', 'origin', origin);
      git(root, 'fetch', 'origin');
      if (headState === 'stale') {
        git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/removed');
      }
      const branch = await detectMainBranch(root);
      expect(branch).toBe('release/stable');
      const task = await createWorktree(
        root,
        'task/custom',
        encodeTaskWorktreeLinkRequestV1([]),
        false,
        branch,
      );
      expect(git(task.path, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'HEAD'));
      expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/local');
    },
  );

  it('retains a renamed remote reference through branch selection and committed review', async () => {
    const upstream = repository('trunk');
    const root = repository('feature/local');
    git(root, 'remote', 'add', 'upstream', upstream);
    git(root, 'fetch', 'upstream');
    git(root, 'remote', 'set-head', 'upstream', '--auto');
    expect(await detectMainBranch(root)).toBe('upstream/trunk');
    expect((await listBranches(root)).branches[0]).toMatchObject({
      name: 'upstream/trunk',
      remote: true,
      remoteRef: 'upstream/trunk',
    });
    const task = await createWorktree(
      root,
      'task/review',
      encodeTaskWorktreeLinkRequestV1([]),
      false,
      'upstream/trunk',
    );
    fs.writeFileSync(path.join(task.path, 'feature.txt'), 'review this change\n');
    git(task.path, 'add', 'feature.txt');
    git(task.path, 'commit', '-m', 'feature');
    const files = await getChangedFilesFromBranch(root, task.branch, 'upstream/trunk');
    expect(files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'feature.txt' })]),
    );
    const originalHead = git(root, 'rev-parse', 'HEAD');
    await expect(
      mergeTask(root, task.path, task.branch, false, null, false, 'upstream/trunk'),
    ).rejects.toThrow('not a local branch');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/local');
  });

  it.each(['missing', 'commit-sha', 'revision', 'tag'])(
    'rejects a %s merge target without changing either checkout, staged bytes, or refs',
    async (targetKind) => {
      const root = repository('trunk');
      const task = await createWorktree(
        root,
        'task/invalid-merge',
        encodeTaskWorktreeLinkRequestV1([]),
        false,
        'trunk',
      );
      git(task.path, 'commit', '--allow-empty', '-m', 'task change');
      git(root, 'tag', 'release');
      fs.writeFileSync(path.join(task.path, 'pending.txt'), 'staged content\n');
      git(task.path, 'add', 'pending.txt');
      fs.writeFileSync(path.join(task.path, 'pending.txt'), 'unstaged content\n');
      const before = {
        index: git(task.path, 'diff', '--cached'),
        refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
        rootHead: git(root, 'rev-parse', 'HEAD'),
        status: git(task.path, 'status', '--porcelain'),
        taskHead: git(task.path, 'rev-parse', 'HEAD'),
      };
      const target =
        targetKind === 'missing'
          ? 'deleted/default'
          : targetKind === 'commit-sha'
            ? before.rootHead
            : targetKind === 'revision'
              ? `${task.branch}~1`
              : 'release';
      await expect(
        mergeTask(root, task.path, task.branch, false, null, false, target),
      ).rejects.toThrow('not a local branch');
      expect(git(task.path, 'diff', '--cached')).toBe(before.index);
      expect(git(root, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(before.refs);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(before.rootHead);
      expect(git(task.path, 'rev-parse', 'HEAD')).toBe(before.taskHead);
      expect(git(task.path, 'status', '--porcelain')).toBe(before.status);
      expect(fs.readFileSync(path.join(task.path, 'pending.txt'), 'utf8')).toBe(
        'unstaged content\n',
      );
      expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
    },
  );

  it('canonicalizes symbolic HEAD merge targets without detaching the project checkout', async () => {
    const root = repository('trunk');
    const task = await createWorktree(
      root,
      'task/symbolic',
      encodeTaskWorktreeLinkRequestV1([]),
      false,
      'trunk',
    );
    git(task.path, 'commit', '--allow-empty', '-m', 'task change');
    await expect(
      mergeTask(root, task.path, task.branch, false, null, false, 'HEAD'),
    ).resolves.toMatchObject({ main_branch: 'trunk' });
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
  });

  it('uses remote-only default refs consistently for status, history, and rebase', async () => {
    const origin = repository('trunk');
    const root = repository('feature/local');
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'fetch', 'origin');
    const task = await createWorktree(
      root,
      'task/feature',
      encodeTaskWorktreeLinkRequestV1([]),
      false,
      'trunk',
    );
    fs.writeFileSync(path.join(task.path, 'feature.txt'), 'feature\n');
    git(task.path, 'add', 'feature.txt');
    git(task.path, 'commit', '-m', 'task feature');
    fs.writeFileSync(path.join(origin, 'base.txt'), 'base\n');
    git(origin, 'add', 'base.txt');
    git(origin, 'commit', '-m', 'upstream change');
    git(root, 'fetch', 'origin');

    expect(await getWorktreeStatus(task.path, 'trunk')).toMatchObject({
      has_committed_changes: true,
    });
    expect(await getBranchLog(task.path, 'trunk')).toContain('task feature');
    expect(await checkMergeStatus(task.path, 'trunk')).toMatchObject({ main_ahead_count: 1 });
    await rebaseTask(task.path, 'trunk');
    expect(git(task.path, 'rev-parse', 'HEAD^')).toBe(git(origin, 'rev-parse', 'HEAD'));
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/local');
  });

  it('does not re-review changes already landed on a renamed upstream when the local base is stale', async () => {
    const upstream = repository('trunk');
    const root = repository('feature/local');
    git(root, 'remote', 'add', 'upstream', upstream);
    git(root, 'fetch', 'upstream');
    git(root, 'checkout', '-b', 'trunk', '--track', 'upstream/trunk');
    const task = await createWorktree(
      root,
      'task/landed',
      encodeTaskWorktreeLinkRequestV1([]),
      false,
      'trunk',
    );
    fs.writeFileSync(path.join(task.path, 'landed.txt'), 'already landed\n');
    git(task.path, 'add', 'landed.txt');
    git(task.path, 'commit', '-m', 'landed change');
    git(upstream, 'fetch', task.path, task.branch);
    git(upstream, 'merge', '--ff-only', 'FETCH_HEAD');
    git(root, 'fetch', 'upstream');
    expect(git(root, 'rev-parse', 'trunk')).not.toBe(git(root, 'rev-parse', 'upstream/trunk'));
    expect(await getChangedFilesFromBranch(root, task.branch, 'trunk')).toEqual([]);
  });

  it('does not silently replace an unavailable explicitly configured base', async () => {
    const root = repository('main');
    const branch = await detectMainBranch(root, 'deleted/default');
    expect(branch).toBe('deleted/default');
    await expect(
      createWorktree(root, 'task/invalid', encodeTaskWorktreeLinkRequestV1([]), false, branch),
    ).rejects.toThrow('Branch "deleted/default" does not exist');
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
  });

  it('requires closing shared-root tasks before merging even into the same branch', async () => {
    const root = repository('trunk');
    git(root, 'branch', 'other');
    const task = await createWorktree(
      root,
      'task/merge',
      encodeTaskWorktreeLinkRequestV1([]),
      false,
      'trunk',
    );
    git(task.path, 'commit', '--allow-empty', '-m', 'task change');
    const rootHead = git(root, 'rev-parse', 'HEAD');
    await expect(
      mergeTask(root, task.path, task.branch, false, null, false, 'other', () => true),
    ).rejects.toThrow('Close project-root tasks');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(rootHead);
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
    await expect(
      mergeTask(root, task.path, task.branch, false, null, false, 'trunk', () => false),
    ).resolves.toMatchObject({ main_branch: 'trunk' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(git(task.path, 'rev-parse', 'HEAD'));
  });

  it('waits for in-flight shared-root admission before deciding whether a merge can switch branches', async () => {
    const root = repository('trunk');
    git(root, 'branch', 'other');
    const task = await createWorktree(
      root,
      'task/race',
      encodeTaskWorktreeLinkRequestV1([]),
      false,
      'trunk',
    );
    let shared = false;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const admissionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Acquiring through the linked checkout must serialize a merge entered through the root.
    const admission = withRepositoryWorktreeLock(task.path, async () => {
      entered();
      await admissionGate;
      shared = true;
    });
    await enteredPromise;
    const merge = mergeTask(
      root,
      task.path,
      task.branch,
      false,
      null,
      false,
      'other',
      () => shared,
    );
    release();
    await admission;
    await expect(merge).rejects.toThrow('Close project-root tasks');
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
  });
});
