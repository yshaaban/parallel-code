import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAllFileDiffs, getChangedFiles, getFileDiff } from './git-diff-ops.js';

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
  });

  it('preserves significant leading and trailing spaces in untracked diff lines', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const filePath = path.join(repoPath, 'src', 'spacing.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '  keep surrounding spaces  \n');

    const allDiffs = await getAllFileDiffs(repoPath);

    expect(allDiffs).toContain('+  keep surrounding spaces  ');
  }, 15_000);
});
