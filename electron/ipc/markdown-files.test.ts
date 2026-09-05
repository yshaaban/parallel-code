import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTaskNameRegistry } from '../../server/task-names.js';
import { MARKDOWN_FILE_MAX_BYTES, readMarkdownFile } from './markdown-files.js';
import { createTerminalContentRootAuthority } from './terminal-root-authority.js';

const roots: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-markdown-'));
  roots.push(root);
  const registry = createTaskNameRegistry();
  registry.registerCreatedTask('task-1', { worktreePath: root });
  const admission =
    createTerminalContentRootAuthority(registry).beginCanonicalTaskAdmission('task-1');
  if (!admission) {
    throw new Error('Expected admission');
  }
  return { admission, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('readMarkdownFile', () => {
  it('returns normalized metadata and the authoritative admitted root', async () => {
    const { admission, root } = setup();
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'Guide.MD'), '# Guide\n');

    await expect(readMarkdownFile(admission, 'docs/Guide.MD')).resolves.toEqual({
      content: '# Guide\n',
      fileName: 'Guide.MD',
      relativePath: path.join('docs', 'Guide.MD'),
      worktreePath: root,
    });
  });

  it('rejects requested or canonical non-markdown targets and root equality', async () => {
    const first = setup();
    fs.writeFileSync(path.join(first.root, 'note.txt'), 'text');
    await expect(readMarkdownFile(first.admission, 'note.txt')).resolves.toBeNull();

    const second = setup();
    fs.writeFileSync(path.join(second.root, 'target.txt'), 'text');
    fs.symlinkSync(path.join(second.root, 'target.txt'), path.join(second.root, 'alias.md'));
    await expect(readMarkdownFile(second.admission, 'alias.md')).resolves.toBeNull();
  });

  it('rejects files above the Markdown byte cap', async () => {
    const { admission, root } = setup();
    fs.writeFileSync(path.join(root, 'large.md'), Buffer.alloc(MARKDOWN_FILE_MAX_BYTES + 1));
    await expect(readMarkdownFile(admission, 'large.md')).resolves.toBeNull();
  });
});
