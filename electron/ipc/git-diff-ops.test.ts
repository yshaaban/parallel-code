import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getAllFileDiffs,
  getChangedFiles,
  getChangedFilesFromBranch,
  getFileDiff,
  getFileDiffFromBranch,
} from './git-diff-ops.js';

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function createRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-git-diff-'));
  runGit(repoPath, 'init');
  runGit(repoPath, 'config', 'user.name', 'Parallel Code');
  runGit(repoPath, 'config', 'user.email', 'parallel-code@example.com');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# repo\n');
  runGit(repoPath, 'add', 'README.md');
  runGit(repoPath, 'commit', '-m', 'initial');
  return repoPath;
}

describe('git diff ops', () => {
  const repoPaths: string[] = [];

  afterEach(() => {
    for (const repoPath of repoPaths.splice(0)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('keeps untracked binary files in the changed file list and returns a binary diff marker', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const binaryPath = path.join(repoPath, 'assets', 'logo.png');
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));

    const changedFiles = await getChangedFiles(repoPath);
    expect(changedFiles).toContainEqual({
      committed: false,
      lines_added: 0,
      lines_removed: 0,
      path: 'assets/logo.png',
      status: '?',
    });

    const fileDiff = await getFileDiff(repoPath, 'assets/logo.png');
    expect(fileDiff.diff).toBe('Binary files /dev/null and b/assets/logo.png differ');
    expect(fileDiff.oldContent).toBe('');
    expect(fileDiff.newContent).toBe('');
  });

  it('includes pseudo-diffs for untracked files in the full project diff', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const filePath = path.join(repoPath, 'src', 'feature.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const answer = 42;\n');

    const allDiffs = await getAllFileDiffs(repoPath);

    expect(allDiffs).toContain('diff --git');
    expect(allDiffs).toContain('+++ b/src/feature.ts');
    expect(allDiffs).toContain('+export const answer = 42;');
  }, 15_000);

  it('preserves significant leading and trailing spaces in untracked diff lines', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const filePath = path.join(repoPath, 'src', 'spacing.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '  keep surrounding spaces  \n');

    const allDiffs = await getAllFileDiffs(repoPath);

    expect(allDiffs).toContain('+  keep surrounding spaces  ');
  }, 15_000);

  it('skips untracked nested-repository directories in the changed file list', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const nestedRepoPath = path.join(repoPath, '.worktrees', 'task', 'port');
    fs.mkdirSync(nestedRepoPath, { recursive: true });
    runGit(nestedRepoPath, 'init');

    const changedFiles = await getChangedFiles(repoPath);

    expect(changedFiles.some((file) => file.path === '.worktrees/task/port/')).toBe(false);
  });

  it('returns the working tree unified diff for tracked modified files', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const filePath = path.join(repoPath, 'README.md');
    fs.writeFileSync(filePath, '# repo\nupdated\n');

    const fileDiff = await getFileDiff(repoPath, 'README.md', {
      status: 'M',
    });

    expect(fileDiff.diff).toContain('diff --git a/README.md b/README.md');
    expect(fileDiff.diff).toContain('+updated');
    expect(fileDiff.oldContent).toBe('# repo\n');
    expect(fileDiff.newContent).toBe('# repo\nupdated\n');
  });

  it('marks merge-conflict paths as U in the changed file list', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const filePath = path.join(repoPath, 'README.md');
    runGit(repoPath, 'checkout', '-b', 'feature/conflict');
    fs.writeFileSync(filePath, '# repo\nfeature change\n');
    runGit(repoPath, 'add', 'README.md');
    runGit(repoPath, 'commit', '-m', 'feature change');

    runGit(repoPath, 'checkout', 'master');
    fs.writeFileSync(filePath, '# repo\nmain change\n');
    runGit(repoPath, 'add', 'README.md');
    runGit(repoPath, 'commit', '-m', 'main change');

    try {
      runGit(repoPath, 'merge', 'feature/conflict');
    } catch {
      // expected merge conflict
    }

    const changedFiles = await getChangedFiles(repoPath);

    expect(changedFiles).toContainEqual(
      expect.objectContaining({
        committed: false,
        path: 'README.md',
        status: 'U',
      }),
    );
  });

  it('returns added branch file diffs from the branch comparison path', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    runGit(repoPath, 'checkout', '-b', 'feature/review');
    const branchFilePath = path.join(repoPath, 'src', 'feature.ts');
    fs.mkdirSync(path.dirname(branchFilePath), { recursive: true });
    fs.writeFileSync(branchFilePath, 'export const feature = true;\n');
    runGit(repoPath, 'add', 'src/feature.ts');
    runGit(repoPath, 'commit', '-m', 'add feature');

    const fileDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts');

    expect(fileDiff.diff).toContain('+export const feature = true;');
    expect(fileDiff.oldContent).toBe('');
    expect(fileDiff.newContent).toBe('export const feature = true;\n');
  });

  it('refreshes cached branch file diffs when the branch head changes', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    runGit(repoPath, 'checkout', '-b', 'feature/review');
    const branchFilePath = path.join(repoPath, 'src', 'feature.ts');
    fs.mkdirSync(path.dirname(branchFilePath), { recursive: true });
    fs.writeFileSync(branchFilePath, 'export const feature = true;\n');
    runGit(repoPath, 'add', 'src/feature.ts');
    runGit(repoPath, 'commit', '-m', 'add feature');

    const firstDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts');
    expect(firstDiff.newContent).toBe('export const feature = true;\n');

    fs.writeFileSync(branchFilePath, 'export const feature = false;\n');
    runGit(repoPath, 'add', 'src/feature.ts');
    runGit(repoPath, 'commit', '-m', 'change feature');

    const secondDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts');
    expect(secondDiff.newContent).toBe('export const feature = false;\n');
    expect(secondDiff.diff).toContain('+export const feature = false;');
  });

  it('refreshes cached branch changed files when the branch head changes', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    runGit(repoPath, 'branch', '-m', 'main');
    runGit(repoPath, 'checkout', '-b', 'feature/review');
    const branchFilePath = path.join(repoPath, 'src', 'feature.ts');
    fs.mkdirSync(path.dirname(branchFilePath), { recursive: true });
    fs.writeFileSync(branchFilePath, 'export const first = true;\n');
    runGit(repoPath, 'add', 'src/feature.ts');
    runGit(repoPath, 'commit', '-m', 'add feature');

    const firstFiles = await getChangedFilesFromBranch(repoPath, 'feature/review');
    expect(firstFiles).toContainEqual(
      expect.objectContaining({
        lines_added: 1,
        path: 'src/feature.ts',
      }),
    );

    fs.writeFileSync(branchFilePath, 'export const first = true;\nexport const second = true;\n');
    runGit(repoPath, 'add', 'src/feature.ts');
    runGit(repoPath, 'commit', '-m', 'expand feature');

    const secondFiles = await getChangedFilesFromBranch(repoPath, 'feature/review');
    expect(secondFiles).toContainEqual(
      expect.objectContaining({
        lines_added: 2,
        path: 'src/feature.ts',
      }),
    );
  });
});
