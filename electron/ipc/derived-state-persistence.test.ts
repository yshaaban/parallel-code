import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatusSyncSnapshotEvent } from '../../src/domain/server-state.js';
import {
  getDerivedStateFilePath,
  loadPersistedDerivedState,
  startDerivedStatePersistence,
} from './derived-state-persistence.js';
import {
  clearGitStatusSnapshots,
  recordGitStatusSnapshot,
  removeGitStatusSnapshot,
} from './git-status-state.js';
import type { StorageEnv } from './storage.js';

function createGitStatusSnapshot(worktreePath: string): GitStatusSyncSnapshotEvent {
  return {
    status: {
      has_committed_changes: true,
      has_uncommitted_changes: false,
    },
    worktreePath,
  };
}

describe('derived-state persistence', () => {
  let env: StorageEnv;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    env = {
      isPackaged: true,
      userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'derived-state-test-')),
    };
    clearGitStatusSnapshots();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.useRealTimers();
    clearGitStatusSnapshots();
    fs.rmSync(env.userDataPath, { force: true, recursive: true });
  });

  it('writes a debounced atomic snapshot file that round-trips through load', async () => {
    cleanup = startDerivedStatePersistence(env);

    recordGitStatusSnapshot(createGitStatusSnapshot('/tmp/worktree-a'));
    recordGitStatusSnapshot(createGitStatusSnapshot('/tmp/worktree-b'));
    expect(fs.existsSync(getDerivedStateFilePath(env))).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    const loaded = loadPersistedDerivedState(env);
    expect(loaded).not.toBeNull();
    expect(loaded?.formatVersion).toBe(1);
    expect(loaded?.gitStatus.map((snapshot) => snapshot.worktreePath)).toEqual([
      '/tmp/worktree-a',
      '/tmp/worktree-b',
    ]);
    expect(loaded?.taskConvergence).toEqual([]);
  });

  it('coalesces bursts of changes into one debounced write', async () => {
    cleanup = startDerivedStatePersistence(env);
    const writeSpy = vi.spyOn(fs, 'renameSync');

    recordGitStatusSnapshot(createGitStatusSnapshot('/tmp/worktree-a'));
    await vi.advanceTimersByTimeAsync(500);
    recordGitStatusSnapshot(createGitStatusSnapshot('/tmp/worktree-b'));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();
  });

  it('excludes removed entries from the next write', async () => {
    cleanup = startDerivedStatePersistence(env);

    recordGitStatusSnapshot(createGitStatusSnapshot('/tmp/worktree-a'));
    recordGitStatusSnapshot(createGitStatusSnapshot('/tmp/worktree-b'));
    await vi.advanceTimersByTimeAsync(2_000);

    removeGitStatusSnapshot('/tmp/worktree-a');
    await vi.advanceTimersByTimeAsync(2_000);

    const loaded = loadPersistedDerivedState(env);
    expect(loaded?.gitStatus.map((snapshot) => snapshot.worktreePath)).toEqual(['/tmp/worktree-b']);
  });

  it('returns null for a missing or corrupt file', () => {
    expect(loadPersistedDerivedState(env)).toBeNull();

    fs.writeFileSync(getDerivedStateFilePath(env), '{not json', 'utf8');
    expect(loadPersistedDerivedState(env)).toBeNull();

    fs.writeFileSync(getDerivedStateFilePath(env), JSON.stringify({ formatVersion: 99 }), 'utf8');
    expect(loadPersistedDerivedState(env)).toBeNull();
  });

  it('drops invalid entries individually while keeping valid ones', () => {
    fs.writeFileSync(
      getDerivedStateFilePath(env),
      JSON.stringify({
        formatVersion: 1,
        gitStatus: [
          createGitStatusSnapshot('/tmp/worktree-a'),
          { worktreePath: '/tmp/missing-status' },
          'not-a-record',
        ],
        savedAt: 123,
        taskConvergence: [{ taskId: 'task-1' }],
        taskReview: 'legacy-shape',
        taskReviewSignals: [],
        taskSteps: [],
      }),
      'utf8',
    );

    const loaded = loadPersistedDerivedState(env);
    expect(loaded?.gitStatus.map((snapshot) => snapshot.worktreePath)).toEqual(['/tmp/worktree-a']);
    expect(loaded?.taskConvergence).toEqual([]);
    expect(loaded?.taskReview).toEqual([]);
  });

  it('stops writing after cleanup unsubscribes', async () => {
    cleanup = startDerivedStatePersistence(env);
    cleanup();
    cleanup = null;

    recordGitStatusSnapshot(createGitStatusSnapshot('/tmp/worktree-a'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fs.existsSync(getDerivedStateFilePath(env))).toBe(false);
  });
});
