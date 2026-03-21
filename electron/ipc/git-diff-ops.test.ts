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
  getProjectDiff,
} from './git-diff-ops.js';
import { commitAll } from './git-mutation-ops.js';
import { parseMultiFileUnifiedDiff } from '../../src/lib/unified-diff-parser.js';

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

function writeRepoFile(
  repoPath: string,
  relativePath: string,
  content: string | Uint8Array,
): string {
  const filePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function commitRepoFile(
  repoPath: string,
  relativePath: string,
  content: string | Uint8Array,
  message: string,
): string {
  const filePath = writeRepoFile(repoPath, relativePath, content);
  runGit(repoPath, 'add', relativePath);
  runGit(repoPath, 'commit', '-m', message);
  return filePath;
}

function renameDefaultBranchToMain(repoPath: string): void {
  runGit(repoPath, 'branch', '-m', 'main');
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

    writeRepoFile(
      repoPath,
      'assets/logo.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
    );

    const changedFiles = await getChangedFiles(repoPath);
    expect(changedFiles).toContainEqual({
      committed: false,
      lines_added: 0,
      lines_removed: 0,
      path: 'assets/logo.png',
      status: '?',
    });

    const fileDiff = await getFileDiff(repoPath, 'assets/logo.png');
    expect(fileDiff.diff).toContain('diff --git a/assets/logo.png b/assets/logo.png');
    expect(fileDiff.diff).toContain('new file mode 100644');
    expect(fileDiff.diff).toContain('Binary files /dev/null and b/assets/logo.png differ');
    expect(parseMultiFileUnifiedDiff(fileDiff.diff)).toEqual([
      {
        path: 'assets/logo.png',
        status: 'A',
        binary: true,
        hunks: [],
      },
    ]);
    expect(fileDiff.oldContent).toBe('');
    expect(fileDiff.newContent).toBe('');
  });

  it('includes pseudo-diffs for untracked files in the full project diff', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    writeRepoFile(repoPath, 'src/feature.ts', 'export const answer = 42;\n');

    const allDiffs = await getAllFileDiffs(repoPath);

    expect(allDiffs).toContain('diff --git');
    expect(allDiffs).toContain('+++ b/src/feature.ts');
    expect(allDiffs).toContain('+export const answer = 42;');
  }, 15_000);

  it('returns parseable single-file diffs for untracked added files', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    writeRepoFile(repoPath, '.claude/plans/zazzy-scribbling-starlight.md', 'hello\nworld\n');

    const fileDiff = await getFileDiff(repoPath, '.claude/plans/zazzy-scribbling-starlight.md', {
      status: '?',
    });
    const parsed = parseMultiFileUnifiedDiff(fileDiff.diff);

    expect(fileDiff.diff).toContain(
      'diff --git a/.claude/plans/zazzy-scribbling-starlight.md b/.claude/plans/zazzy-scribbling-starlight.md',
    );
    expect(fileDiff.diff).toContain('new file mode 100644');
    expect(fileDiff.diff).toContain('+hello');
    expect(parsed).toEqual([
      expect.objectContaining({
        path: '.claude/plans/zazzy-scribbling-starlight.md',
        status: 'A',
      }),
    ]);
  });

  it('preserves significant leading and trailing spaces in untracked diff lines', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    writeRepoFile(repoPath, 'src/spacing.ts', '  keep surrounding spaces  \n');

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

    writeRepoFile(repoPath, 'README.md', '# repo\nupdated\n');

    const fileDiff = await getFileDiff(repoPath, 'README.md', {
      status: 'M',
    });

    expect(fileDiff.diff).toContain('diff --git a/README.md b/README.md');
    expect(fileDiff.diff).toContain('+updated');
    expect(fileDiff.oldContent).toBe('# repo\n');
    expect(fileDiff.newContent).toBe('# repo\nupdated\n');
  });

  it('keeps staged and unstaged project diff modes aligned with real git status categories', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    writeRepoFile(repoPath, 'README.md', '# repo\nunstaged\n');
    writeRepoFile(repoPath, 'src/staged.ts', 'export const staged = true;\n');
    runGit(repoPath, 'add', 'src/staged.ts');
    writeRepoFile(repoPath, 'src/untracked.ts', 'export const untracked = true;\n');

    await expect(getProjectDiff(repoPath, 'staged')).resolves.toMatchObject({
      files: [
        {
          committed: false,
          lines_added: 1,
          lines_removed: 0,
          path: 'src/staged.ts',
          status: 'A',
        },
      ],
      totalAdded: 1,
      totalRemoved: 0,
    });

    await expect(getProjectDiff(repoPath, 'unstaged')).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({
          committed: false,
          path: 'README.md',
          status: 'M',
        }),
        expect.objectContaining({
          committed: false,
          path: 'src/untracked.ts',
          status: '?',
        }),
      ]),
    });
  });

  it('includes committed deleted files in branch project diff mode', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    commitRepoFile(repoPath, 'src/deleted.ts', 'export const deleted = true;\n', 'seed deleted');
    runGit(repoPath, 'checkout', '-B', 'feature/review');
    fs.rmSync(path.join(repoPath, 'src', 'deleted.ts'));
    runGit(repoPath, 'add', '-A');
    runGit(repoPath, 'commit', '-m', 'delete file on branch');

    await expect(getProjectDiff(repoPath, 'branch')).resolves.toMatchObject({
      files: [
        {
          committed: true,
          lines_added: 0,
          lines_removed: 1,
          path: 'src/deleted.ts',
          status: 'D',
        },
      ],
      totalAdded: 0,
      totalRemoved: 1,
    });
  });

  it('refreshes worktree branch comparisons when main catches up to the current head', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    commitRepoFile(repoPath, 'src/feature.ts', 'export const version = "main";\n', 'seed base');
    runGit(repoPath, 'checkout', '-b', 'feature/review');
    commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const version = "branch";\n',
      'change feature',
    );

    await expect(getChangedFiles(repoPath)).resolves.toContainEqual(
      expect.objectContaining({
        committed: true,
        path: 'src/feature.ts',
        status: 'M',
      }),
    );
    await expect(getProjectDiff(repoPath, 'branch')).resolves.toMatchObject({
      files: [
        expect.objectContaining({
          committed: true,
          path: 'src/feature.ts',
          status: 'M',
        }),
      ],
    });
    await expect(getAllFileDiffs(repoPath)).resolves.toContain('+export const version = "branch";');

    runGit(repoPath, 'checkout', 'main');
    runGit(repoPath, 'merge', '--ff-only', 'feature/review');
    runGit(repoPath, 'checkout', 'feature/review');

    await expect(getChangedFiles(repoPath)).resolves.toEqual([]);
    await expect(getProjectDiff(repoPath, 'branch')).resolves.toMatchObject({
      files: [],
      totalAdded: 0,
      totalRemoved: 0,
    });
    await expect(getAllFileDiffs(repoPath)).resolves.toBe('');
  });

  it('tracks diff lifecycle across a real git worktree', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-git-worktree-'));
    repoPaths.push(worktreePath);
    runGit(repoPath, 'worktree', 'add', worktreePath, '-b', 'feature/review');

    writeRepoFile(worktreePath, 'README.md', '# repo\nworktree change\n');
    writeRepoFile(worktreePath, 'src/feature.ts', 'export const feature = true;\n');

    const uncommittedFiles = await getChangedFiles(worktreePath);
    expect(uncommittedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          committed: false,
          path: 'README.md',
          status: 'M',
        }),
        expect.objectContaining({
          committed: false,
          path: 'src/feature.ts',
          status: '?',
        }),
      ]),
    );

    const worktreeReadmeDiff = await getFileDiff(worktreePath, 'README.md', { status: 'M' });
    expect(worktreeReadmeDiff.oldContent).toBe('# repo\n');
    expect(worktreeReadmeDiff.newContent).toBe('# repo\nworktree change\n');
    expect(worktreeReadmeDiff.diff).toContain('+worktree change');

    await commitAll(worktreePath, 'commit worktree changes');

    const committedWorktreeFiles = await getChangedFiles(worktreePath);
    expect(committedWorktreeFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          committed: true,
          path: 'README.md',
          status: 'M',
        }),
        expect.objectContaining({
          committed: true,
          path: 'src/feature.ts',
          status: 'A',
        }),
      ]),
    );

    const branchFiles = await getChangedFilesFromBranch(repoPath, 'feature/review');
    expect(branchFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          committed: true,
          path: 'README.md',
          status: 'M',
        }),
        expect.objectContaining({
          committed: true,
          path: 'src/feature.ts',
          status: 'A',
        }),
      ]),
    );

    const branchReadmeDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'README.md', {
      status: 'M',
    });
    expect(branchReadmeDiff.oldContent).toBe('# repo\n');
    expect(branchReadmeDiff.newContent).toBe('# repo\nworktree change\n');
    expect(branchReadmeDiff.diff).toContain('+worktree change');
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

    expect(fileDiff.diff).toContain('diff --git a/src/feature.ts b/src/feature.ts');
    expect(fileDiff.diff).toContain('new file mode 100644');
    expect(fileDiff.diff).toContain('+export const feature = true;');
    expect(fileDiff.oldContent).toBe('');
    expect(fileDiff.newContent).toBe('export const feature = true;\n');
  });

  it('returns modified branch file diffs from the branch comparison path', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const feature = false;\n',
      'add base feature',
    );
    renameDefaultBranchToMain(repoPath);

    runGit(repoPath, 'checkout', '-b', 'feature/review');
    commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const feature = true;\nexport const enabled = true;\n',
      'modify feature',
    );

    const fileDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts', {
      status: 'M',
    });

    expect(fileDiff.diff).toContain('diff --git a/src/feature.ts b/src/feature.ts');
    expect(fileDiff.diff).toContain('-export const feature = false;');
    expect(fileDiff.diff).toContain('+export const feature = true;');
    expect(fileDiff.diff).toContain('+export const enabled = true;');
    expect(fileDiff.oldContent).toBe('export const feature = false;\n');
    expect(fileDiff.newContent).toBe(
      'export const feature = true;\nexport const enabled = true;\n',
    );
  });

  it('returns deleted branch file diffs from the branch comparison path', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    const branchFilePath = commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const feature = false;\n',
      'add base feature',
    );
    renameDefaultBranchToMain(repoPath);

    runGit(repoPath, 'checkout', '-b', 'feature/review');
    fs.rmSync(branchFilePath);
    runGit(repoPath, 'add', '-A');
    runGit(repoPath, 'commit', '-m', 'delete feature');

    const fileDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts', {
      status: 'D',
    });

    expect(fileDiff.diff).toContain('diff --git a/src/feature.ts b/src/feature.ts');
    expect(fileDiff.diff).toContain('deleted file mode 100644');
    expect(fileDiff.diff).toContain('-export const feature = false;');
    expect(fileDiff.oldContent).toBe('export const feature = false;\n');
    expect(fileDiff.newContent).toBe('');
  });

  it('returns parseable binary modified branch file diffs from the branch comparison path', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    commitRepoFile(
      repoPath,
      'assets/logo.bin',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      'add base binary',
    );
    renameDefaultBranchToMain(repoPath);

    runGit(repoPath, 'checkout', '-b', 'feature/review');
    commitRepoFile(
      repoPath,
      'assets/logo.bin',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
      'modify binary',
    );

    const fileDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'assets/logo.bin', {
      status: 'M',
    });

    expect(fileDiff.oldContent).toBe('');
    expect(fileDiff.newContent).toBe('');
    expect(fileDiff.diff).toContain('diff --git a/assets/logo.bin b/assets/logo.bin');
    expect(fileDiff.diff).toContain('Binary files a/assets/logo.bin and b/assets/logo.bin differ');
    expect(parseMultiFileUnifiedDiff(fileDiff.diff)).toEqual([
      {
        path: 'assets/logo.bin',
        status: 'M',
        binary: true,
        hunks: [],
      },
    ]);
  });

  it('refreshes cached branch file diffs when the branch head changes', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    runGit(repoPath, 'checkout', '-b', 'feature/review');
    const branchFilePath = commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const feature = true;\n',
      'add feature',
    );

    const firstDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts');
    expect(firstDiff.newContent).toBe('export const feature = true;\n');

    fs.writeFileSync(branchFilePath, 'export const feature = false;\n');
    runGit(repoPath, 'add', 'src/feature.ts');
    runGit(repoPath, 'commit', '-m', 'change feature');

    const secondDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts');
    expect(secondDiff.newContent).toBe('export const feature = false;\n');
    expect(secondDiff.diff).toContain('+export const feature = false;');
  });

  it('refreshes cached branch file diffs when main catches up to the branch head', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const feature = false;\n',
      'add base feature',
    );
    runGit(repoPath, 'checkout', '-b', 'feature/review');
    commitRepoFile(repoPath, 'src/feature.ts', 'export const feature = true;\n', 'update feature');

    const firstDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts', {
      status: 'M',
    });
    expect(firstDiff.diff).toContain('+export const feature = true;');

    runGit(repoPath, 'checkout', 'main');
    runGit(repoPath, 'merge', '--ff-only', 'feature/review');

    const secondDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts', {
      status: 'M',
    });
    expect(secondDiff.diff).toBe('');
    expect(secondDiff.oldContent).toBe('export const feature = true;\n');
    expect(secondDiff.newContent).toBe('export const feature = true;\n');
  });

  it('falls back from a stale added branch status when main catches up', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    runGit(repoPath, 'checkout', '-b', 'feature/review');
    commitRepoFile(repoPath, 'src/new.ts', 'export const fresh = true;\n', 'add feature file');

    const firstDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/new.ts', {
      status: 'A',
    });
    expect(firstDiff.diff).toContain('new file mode 100644');

    runGit(repoPath, 'checkout', 'main');
    runGit(repoPath, 'merge', '--ff-only', 'feature/review');

    const secondDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/new.ts', {
      status: 'A',
    });
    expect(secondDiff.diff).toBe('');
    expect(secondDiff.oldContent).toBe('export const fresh = true;\n');
    expect(secondDiff.newContent).toBe('export const fresh = true;\n');
  });

  it('refreshes cached branch changed files when the branch head changes', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    runGit(repoPath, 'checkout', '-b', 'feature/review');
    const branchFilePath = commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const first = true;\n',
      'add feature',
    );

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

  it('refreshes cached branch changed files when main catches up to the branch head', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const feature = false;\n',
      'add base feature',
    );
    runGit(repoPath, 'checkout', '-b', 'feature/review');
    commitRepoFile(repoPath, 'src/feature.ts', 'export const feature = true;\n', 'update feature');

    const firstFiles = await getChangedFilesFromBranch(repoPath, 'feature/review');
    expect(firstFiles).toContainEqual(
      expect.objectContaining({
        path: 'src/feature.ts',
        status: 'M',
      }),
    );

    runGit(repoPath, 'checkout', 'main');
    runGit(repoPath, 'merge', '--ff-only', 'feature/review');

    const secondFiles = await getChangedFilesFromBranch(repoPath, 'feature/review');
    expect(secondFiles).toEqual([]);
  });

  it('falls back from a stale deleted branch status when main catches up', async () => {
    const repoPath = createRepo();
    repoPaths.push(repoPath);

    renameDefaultBranchToMain(repoPath);
    const branchFilePath = commitRepoFile(
      repoPath,
      'src/feature.ts',
      'export const removed = true;\n',
      'add removable file',
    );
    runGit(repoPath, 'checkout', '-b', 'feature/review');
    fs.rmSync(branchFilePath);
    runGit(repoPath, 'add', '-A');
    runGit(repoPath, 'commit', '-m', 'delete removable file');

    const firstDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts', {
      status: 'D',
    });
    expect(firstDiff.diff).toContain('deleted file mode 100644');

    runGit(repoPath, 'checkout', 'main');
    runGit(repoPath, 'merge', '--ff-only', 'feature/review');

    const secondDiff = await getFileDiffFromBranch(repoPath, 'feature/review', 'src/feature.ts', {
      status: 'D',
    });
    expect(secondDiff.diff).toBe('');
    expect(secondDiff.oldContent).toBe('');
    expect(secondDiff.newContent).toBe('');
  });
});
