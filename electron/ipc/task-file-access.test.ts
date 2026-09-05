import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaskNameRegistry } from '../../server/task-names.js';
import { createTerminalContentRootAuthority } from './terminal-root-authority.js';
import { readBoundedTaskTextFile, readBoundedTaskTextFileSync } from './task-file-access.js';

const temporaryDirectories: string[] = [];

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-task-file-'));
  temporaryDirectories.push(root);
  return root;
}

function createAdmission(root: string) {
  const registry = createTaskNameRegistry();
  registry.registerCreatedTask('task-1', { worktreePath: root });
  const admission =
    createTerminalContentRootAuthority(registry).beginCanonicalTaskAdmission('task-1');
  if (!admission) {
    throw new Error('Expected a test admission');
  }
  return admission;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('bounded task text file access', () => {
  it('reads exact-limit content through both descriptor implementations', async () => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '12345');

    expect(
      readBoundedTaskTextFileSync({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 5,
        relativePath: 'docs/guide.md',
      }),
    ).toMatchObject({ content: '12345', relativePath: path.join('docs', 'guide.md') });
    await expect(
      readBoundedTaskTextFile({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 5,
        relativePath: 'docs/guide.md',
      }),
    ).resolves.toMatchObject({ content: '12345' });
  });

  it('rejects max-plus-one bytes without returning partial content', async () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, 'large.md'), '123456');

    expect(
      readBoundedTaskTextFileSync({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 5,
        relativePath: 'large.md',
      }),
    ).toBeNull();
    await expect(
      readBoundedTaskTextFile({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 5,
        relativePath: 'large.md',
      }),
    ).resolves.toBeNull();
  });

  it('rejects lexical traversal, absolute paths, root equality, and non-files', () => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, 'directory'));
    for (const relativePath of [
      '../outside.md',
      path.resolve(root, 'absolute.md'),
      '.',
      'directory',
    ]) {
      expect(
        readBoundedTaskTextFileSync({
          admission: createAdmission(root),
          allowedRoots: [root],
          maxBytes: 100,
          relativePath,
        }),
      ).toBeNull();
    }
  });

  it('rejects symlink escapes while allowing an in-root symlink bound to its canonical target', () => {
    const root = createRoot();
    const outside = createRoot();
    fs.writeFileSync(path.join(outside, 'outside.md'), 'secret');
    fs.writeFileSync(path.join(root, 'inside.md'), 'inside');
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'escape.md'));
    fs.symlinkSync(path.join(root, 'inside.md'), path.join(root, 'alias.md'));

    expect(
      readBoundedTaskTextFileSync({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 100,
        relativePath: 'escape.md',
      }),
    ).toBeNull();
    expect(
      readBoundedTaskTextFileSync({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 100,
        relativePath: 'alias.md',
      }),
    ).toMatchObject({ content: 'inside', relativePath: 'alias.md' });
  });

  it('requires canonical containment in a caller-owned allowed root', () => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'other'));
    fs.writeFileSync(path.join(root, 'other', 'note.md'), 'note');

    expect(
      readBoundedTaskTextFileSync({
        admission: createAdmission(root),
        allowedRoots: [path.join(root, 'docs')],
        maxBytes: 100,
        relativePath: 'other/note.md',
      }),
    ).toBeNull();
  });

  it('does not read bytes when post-bind admission commit loses its race', () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, 'guide.md'), 'content');
    const admission = createAdmission(root);
    expect(admission.commitAfterDescriptorBind()).toBe(true);

    expect(
      readBoundedTaskTextFileSync({
        admission,
        allowedRoots: [root],
        maxBytes: 100,
        relativePath: 'guide.md',
      }),
    ).toBeNull();
  });

  it('applies canonical-path policy before committing authority', () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, 'guide.txt'), 'content');
    const admission = createAdmission(root);

    expect(
      readBoundedTaskTextFileSync({
        admission,
        allowedRoots: [root],
        maxBytes: 100,
        relativePath: 'guide.txt',
        acceptCanonicalPath: (canonicalPath) => canonicalPath.endsWith('.md'),
      }),
    ).toBeNull();
    expect(admission.commitAfterDescriptorBind()).toBe(true);
  });

  it('rejects target replacement between identity capture and descriptor binding', () => {
    const root = createRoot();
    const filePath = path.join(root, 'guide.md');
    fs.writeFileSync(filePath, 'original');
    const originalOpenSync = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementationOnce(((
      requestedPath: fs.PathLike,
      flags: string | number,
      mode?: fs.Mode,
    ) => {
      fs.renameSync(filePath, `${filePath}.old`);
      fs.writeFileSync(filePath, 'replacement');
      return originalOpenSync(requestedPath, flags, mode);
    }) as typeof fs.openSync);

    expect(
      readBoundedTaskTextFileSync({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 100,
        relativePath: 'guide.md',
      }),
    ).toBeNull();
    openSpy.mockRestore();
  });

  it('closes the bound descriptor after a successful synchronous read', () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, 'guide.md'), 'content');
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(
      readBoundedTaskTextFileSync({
        admission: createAdmission(root),
        allowedRoots: [root],
        maxBytes: 100,
        relativePath: 'guide.md',
      }),
    ).toMatchObject({ content: 'content' });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });
});
