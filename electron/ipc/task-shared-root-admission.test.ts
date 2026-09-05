import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  admitPreparedSharedRootTask,
  hasPreparedSharedRootTask,
  releasePreparedSharedRootTask,
  resetPreparedSharedRootTasksForTests,
} from './task-shared-root-admission.js';

afterEach(resetPreparedSharedRootTasksForTests);

describe('provisional shared-root admission', () => {
  it('binds an exact task identity without allowing it to move to another root', () => {
    admitPreparedSharedRootTask('task-1', '/repo');
    admitPreparedSharedRootTask('task-1', '/repo');
    expect(() => admitPreparedSharedRootTask('task-1', '/other')).toThrow('identity changed');
    expect(hasPreparedSharedRootTask('/repo')).toBe(true);
    expect(hasPreparedSharedRootTask('/other')).toBe(false);
  });

  it('retains another task admission after one task is released through a canonical alias', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-root-admission-'));
    try {
      const checkout = path.join(root, 'checkout');
      const alias = path.join(root, 'alias');
      fs.mkdirSync(checkout);
      fs.symlinkSync(checkout, alias, 'dir');
      admitPreparedSharedRootTask('task-1', checkout);
      admitPreparedSharedRootTask('task-2', alias);
      releasePreparedSharedRootTask('task-1');
      expect(hasPreparedSharedRootTask(checkout)).toBe(true);
      expect(hasPreparedSharedRootTask(alias)).toBe(true);
      releasePreparedSharedRootTask('task-2');
      expect(hasPreparedSharedRootTask(checkout)).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
