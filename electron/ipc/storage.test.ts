import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAppStateForEnv,
  loadTaskRegistryStateForEnv,
  loadWorkspaceStateForEnv,
  saveAppStateForEnv,
  saveArenaDataForEnv,
  saveWorkspaceStateForEnv,
  type StorageEnv,
} from './storage.js';

function createStorageEnv(): StorageEnv {
  return {
    isPackaged: false,
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-storage-test-')),
  };
}

function removeStorageEnv(env: StorageEnv): void {
  fs.rmSync(env.userDataPath, { force: true, recursive: true });
  fs.rmSync(`${env.userDataPath}-dev`, { force: true, recursive: true });
}

function getDevStoragePath(env: StorageEnv, filename: string): string {
  return path.join(`${env.userDataPath}-dev`, filename);
}

function expectAtomicWriteCleanup(save: () => void, tmpPath: string, finalPath: string): void {
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('rename failed');
  });

  try {
    expect(save).toThrow('rename failed');
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
  } finally {
    renameSpy.mockRestore();
  }
}

describe('loadTaskRegistryStateForEnv', () => {
  const envs: StorageEnv[] = [];

  afterEach(() => {
    for (const env of envs) {
      removeStorageEnv(env);
    }
    envs.length = 0;
  });

  it('prefers workspace state over legacy app state', () => {
    const env = createStorageEnv();
    envs.push(env);

    saveAppStateForEnv(env, JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Legacy' } } }));
    saveWorkspaceStateForEnv(
      env,
      JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Workspace' } } }),
      3,
    );

    expect(loadTaskRegistryStateForEnv(env)).toBe(
      JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Workspace' } } }),
    );
  });

  it('falls back to app state when workspace state is unavailable', () => {
    const env = createStorageEnv();
    envs.push(env);

    saveAppStateForEnv(env, JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Legacy' } } }));

    expect(loadTaskRegistryStateForEnv(env)).toBe(
      JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Legacy' } } }),
    );
  });

  it('returns null when no saved state is present', () => {
    const env = createStorageEnv();
    envs.push(env);

    expect(loadTaskRegistryStateForEnv(env)).toBeNull();
  });

  it('cleans up temporary app state files when the rename step fails', () => {
    const env = createStorageEnv();
    envs.push(env);

    const statePath = getDevStoragePath(env, 'state.json');
    expectAtomicWriteCleanup(
      () => saveAppStateForEnv(env, JSON.stringify({ tasks: {} })),
      `${statePath}.tmp`,
      statePath,
    );
  });

  it('cleans up temporary workspace state files when the rename step fails', () => {
    const env = createStorageEnv();
    envs.push(env);

    const statePath = getDevStoragePath(env, 'workspace-state.json');
    expectAtomicWriteCleanup(
      () => saveWorkspaceStateForEnv(env, JSON.stringify({ tasks: {} }), 1),
      `${statePath}.tmp`,
      statePath,
    );
  });

  it('cleans up temporary arena files when the rename step fails', () => {
    const env = createStorageEnv();
    envs.push(env);

    const filePath = path.join(`${env.userDataPath}`, 'arena-demo.json');
    expectAtomicWriteCleanup(
      () => saveArenaDataForEnv(env, 'arena-demo.json', JSON.stringify({ demo: true })),
      `${filePath}.tmp`,
      filePath,
    );
  });

  it('falls back to backup app state when the primary file contains invalid JSON', () => {
    const env = createStorageEnv();
    envs.push(env);

    const statePath = getDevStoragePath(env, 'state.json');
    const bakPath = `${statePath}.bak`;

    saveAppStateForEnv(env, JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Legacy' } } }));
    fs.writeFileSync(statePath, '{not-json', 'utf8');
    fs.writeFileSync(
      bakPath,
      JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Backup' } } }),
      'utf8',
    );

    expect(loadAppStateForEnv(env)).toBe(
      JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Backup' } } }),
    );
  });

  it('falls back to backup workspace state when the primary file contains invalid JSON', () => {
    const env = createStorageEnv();
    envs.push(env);

    const statePath = getDevStoragePath(env, 'workspace-state.json');
    const bakPath = `${statePath}.bak`;

    saveWorkspaceStateForEnv(
      env,
      JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Workspace' } } }),
      3,
    );
    fs.writeFileSync(statePath, '{not-json', 'utf8');
    fs.writeFileSync(
      bakPath,
      JSON.stringify({
        revision: 9,
        state: { tasks: { one: { id: 'task-1', name: 'Backup' } } },
      }),
      'utf8',
    );

    expect(loadWorkspaceStateForEnv(env)).toEqual({
      json: JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Backup' } } }),
      revision: 9,
    });
  });

  it('falls back to backup workspace state when the primary payload fails semantic validation', () => {
    const env = createStorageEnv();
    envs.push(env);

    const statePath = getDevStoragePath(env, 'workspace-state.json');
    const bakPath = `${statePath}.bak`;

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        revision: 'not-a-number',
        state: { tasks: { one: { id: 'task-1', name: 'Invalid' } } },
      }),
      'utf8',
    );
    fs.writeFileSync(
      bakPath,
      JSON.stringify({
        revision: 7,
        state: { tasks: { one: { id: 'task-1', name: 'Backup' } } },
      }),
      'utf8',
    );

    expect(loadWorkspaceStateForEnv(env)).toEqual({
      json: JSON.stringify({ tasks: { one: { id: 'task-1', name: 'Backup' } } }),
      revision: 7,
    });
  });
});
