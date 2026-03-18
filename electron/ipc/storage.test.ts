import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadTaskRegistryStateForEnv,
  saveAppStateForEnv,
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
});
