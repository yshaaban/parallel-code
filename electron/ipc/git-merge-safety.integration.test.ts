import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeTask, rebaseTask } from './git-mutation-ops.js';
import * as gitExec from './git-exec.js';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(): { root: string; task: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-merge-safety-'));
  roots.push(root);
  git(root, 'init', '-b', 'trunk');
  git(root, 'config', 'user.name', 'Parallel Code');
  git(root, 'config', 'user.email', 'parallel-code@example.com');
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.worktrees/\n');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'original shared bytes\n');
  fs.writeFileSync(path.join(root, 'feature.txt'), 'original feature\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  const task = path.join(root, '.worktrees/task');
  git(root, 'worktree', 'add', '-b', 'task/feature', task);
  fs.writeFileSync(path.join(task, 'feature.txt'), 'task feature\n');
  git(task, 'add', 'feature.txt');
  git(task, 'commit', '-m', 'task change');
  return { root, task };
}

function hook(root: string, name: string, code: string): void {
  fs.writeFileSync(path.join(root, '.git/hooks', name), `#!/usr/bin/env node\n${code}\n`, {
    mode: 0o755,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('merge checkout ownership', { timeout: 30_000 }, () => {
  it.each([false, true])(
    'rejects squash=%s before touching a checkout occupied by root tasks',
    async (squash) => {
      const { root, task } = repository();
      const refs = git(root, 'for-each-ref', '--format=%(refname) %(objectname)');
      await expect(
        mergeTask(root, task, 'task/feature', squash, 'merge', false, 'trunk', () => true),
      ).rejects.toThrow('Close project-root tasks');
      expect(git(root, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refs);
      expect(git(root, 'status', '--porcelain')).toBe('');
      expect(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8')).toBe('original feature\n');
    },
  );

  it('preserves concurrent tracked bytes and staged merge content when a commit hook fails', async () => {
    const { root, task } = repository();
    const head = git(root, 'rev-parse', 'HEAD');
    hook(
      root,
      'pre-commit',
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'shared.txt'))}, 'concurrent edit\\n'); process.exit(1);`,
    );
    await expect(
      mergeTask(root, task, 'task/feature', true, 'merge', false, 'trunk'),
    ).rejects.toThrow('Commit failed');
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('concurrent edit\n');
    expect(git(root, 'show', ':feature.txt')).toBe('task feature');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
  });

  it.each([false, true])(
    'preserves conflict stages and concurrent bytes on squash=%s merge failure',
    async (squash) => {
      const { root, task } = repository();
      fs.writeFileSync(path.join(root, '.gitattributes'), 'feature.txt merge=preserve-review\n');
      fs.writeFileSync(path.join(root, 'feature.txt'), 'base conflict\n');
      git(root, 'add', '.gitattributes', 'feature.txt');
      git(root, 'commit', '-m', 'base conflict');
      const driver = path.join(root, '.git', 'review-merge-driver.cjs');
      fs.writeFileSync(
        driver,
        `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'shared.txt'))}, 'concurrent conflict edit\\n'); process.exit(1);`,
      );
      git(root, 'config', 'merge.preserve-review.driver', `node "${driver}"`);
      const head = git(root, 'rev-parse', 'HEAD');
      await expect(
        mergeTask(root, task, 'task/feature', squash, 'merge', false, 'trunk'),
      ).rejects.toThrow(/merge failed/i);
      expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe(
        'concurrent conflict edit\n',
      );
      expect(git(root, 'ls-files', '-u')).toContain('feature.txt');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    },
  );

  it('keeps native hook staging and leaves unstaged editor changes outside successful squash commits', async () => {
    const { root, task } = repository();
    hook(
      root,
      'pre-commit',
      `const fs = require('node:fs'); fs.writeFileSync('feature.txt', 'formatted task feature\\n'); require('node:child_process').execFileSync('git', ['add', 'feature.txt']); fs.writeFileSync('shared.txt', 'unstaged editor change\\n');`,
    );
    await mergeTask(root, task, 'task/feature', true, 'merge', false, 'trunk');
    expect(git(root, 'show', 'HEAD:feature.txt')).toBe('formatted task feature');
    expect(git(root, 'show', 'HEAD:shared.txt')).toBe('original shared bytes');
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('unstaged editor change\n');
  });

  it('preserves native Git success when a post-merge hook exits nonzero after the ref update', async () => {
    const { root, task } = repository();
    hook(
      root,
      'post-merge',
      `require('node:fs').writeFileSync('shared.txt', 'post-merge edit\\n'); process.exit(1);`,
    );
    await expect(
      mergeTask(root, task, 'task/feature', false, null, false, 'trunk'),
    ).resolves.toMatchObject({ main_branch: 'trunk' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(git(task, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('post-merge edit\n');
  });

  it('distinguishes an accepted target update when Git completion delivery fails afterwards', async () => {
    const { root, task } = repository();
    const actualExec = gitExec.execGit;
    vi.spyOn(gitExec, 'execGit').mockImplementation(async (args, options) => {
      const result = await actualExec(args, options);
      if (args[0] === 'merge') {
        fs.writeFileSync(path.join(root, 'shared.txt'), 'edit after accepted merge\n');
        throw new Error('Git completion unavailable');
      }
      return result;
    });
    await expect(
      mergeTask(root, task, 'task/feature', false, null, false, 'trunk'),
    ).rejects.toThrow('target branch already contains the task commit');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(git(task, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe(
      'edit after accepted merge\n',
    );
  });

  it('preserves concurrent bytes and conflict stages after a failed rebase rather than auto-aborting', async () => {
    const { root, task } = repository();
    fs.writeFileSync(path.join(root, '.gitattributes'), 'feature.txt merge=preserve-review\n');
    fs.writeFileSync(path.join(root, 'feature.txt'), 'base conflict\n');
    git(root, 'add', '.gitattributes', 'feature.txt');
    git(root, 'commit', '-m', 'base conflict');
    const driver = path.join(root, '.git', 'review-rebase-driver.cjs');
    fs.writeFileSync(
      driver,
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(task, 'shared.txt'))}, 'concurrent rebase edit\\n'); process.exit(1);`,
    );
    git(root, 'config', 'merge.preserve-review.driver', `node "${driver}"`);
    const branchTip = git(root, 'rev-parse', 'refs/heads/task/feature');
    await expect(rebaseTask(task, 'trunk')).rejects.toThrow('Rebase failed');
    expect(fs.readFileSync(path.join(task, 'shared.txt'), 'utf8')).toBe('concurrent rebase edit\n');
    expect(git(task, 'ls-files', '-u')).toContain('feature.txt');
    expect(git(root, 'rev-parse', 'refs/heads/task/feature')).toBe(branchTip);
  });
});
