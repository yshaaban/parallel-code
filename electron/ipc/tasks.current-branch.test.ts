import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pty.js', () => ({ notifyAgentListChanged: vi.fn() }));

import { createCurrentBranchTask } from './tasks.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('project-root task Git safety', () => {
  it.each(['main', 'master', 'releases/stable'])(
    'starts parallel tasks on %s without changing dirty files, the index, or refs',
    async (branch) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-root-safety-'));
      roots.push(root);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      git('init', '--initial-branch', branch);
      git('config', 'user.name', 'Root task test');
      git('config', 'user.email', 'root-task@example.invalid');
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
      git('add', 'tracked.txt');
      git('commit', '-m', 'initial');
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged\n');
      git('add', 'tracked.txt');
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'unstaged\n');
      fs.writeFileSync(path.join(root, 'untracked.txt'), 'keep me\n');
      const before = {
        branch: git('symbolic-ref', '--short', 'HEAD'),
        staged: git('diff', '--cached'),
        unstaged: git('diff'),
        status: git('status', '--porcelain'),
        refs: git('show-ref'),
      };
      const tasks = await Promise.all([
        createCurrentBranchTask(root, 'missing-configured-default'),
        createCurrentBranchTask(root),
      ]);
      expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
      expect(tasks.map((task) => task.branch_name)).toEqual([branch, branch]);
      expect({
        branch: git('symbolic-ref', '--short', 'HEAD'),
        staged: git('diff', '--cached'),
        unstaged: git('diff'),
        status: git('status', '--porcelain'),
        refs: git('show-ref'),
      }).toEqual(before);
    },
  );
});
