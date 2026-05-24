import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { isFiniteNumber, isRecord } from '../../src/lib/type-guards.js';

export interface StorageEnv {
  userDataPath: string;
  isPackaged: boolean;
}

function getStateDir(env: StorageEnv): string {
  let dir = env.userDataPath;
  if (!env.isPackaged) {
    const base = path.basename(dir);
    dir = path.join(path.dirname(dir), `${base}-dev`);
  }
  return dir;
}

function getStatePath(env: StorageEnv): string {
  return path.join(getStateDir(env), 'state.json');
}

function getWorkspaceStatePath(env: StorageEnv): string {
  return path.join(getStateDir(env), 'workspace-state.json');
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function writeFileAtomically(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(tmpPath, contents, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    removeFileIfExists(tmpPath);
    throw error;
  }
}

function parseStateJsonObject(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error('Persisted state must be a JSON object');
  }

  return parsed;
}

function copyFileIfExists(sourcePath: string, destinationPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch {
    /* ignore */
  }
}

function saveStateFileWithBackup(statePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const bakPath = `${statePath}.bak`;
  copyFileIfExists(statePath, bakPath);
  writeFileAtomically(statePath, contents);
}

function readContentWithBackup<T>(
  primaryPath: string,
  backupPath: string,
  reader: (content: string) => T | null,
): T | null {
  try {
    if (fs.existsSync(primaryPath)) {
      const content = fs.readFileSync(primaryPath, 'utf8');
      if (content.trim()) {
        const parsed = reader(content);
        if (parsed !== null) {
          return parsed;
        }
      }
    }
  } catch {
    // Primary state file unreadable or invalid — try backup
  }

  try {
    if (fs.existsSync(backupPath)) {
      const content = fs.readFileSync(backupPath, 'utf8');
      if (content.trim()) {
        return reader(content);
      }
    }
  } catch {
    // Backup also unreadable or invalid
  }

  return null;
}

export function saveAppStateForEnv(env: StorageEnv, json: string): void {
  parseStateJsonObject(json);
  saveStateFileWithBackup(getStatePath(env), json);
}

export function loadAppStateForEnv(env: StorageEnv): string | null {
  const statePath = getStatePath(env);
  const bakPath = `${statePath}.bak`;

  return readContentWithBackup(statePath, bakPath, (content) => {
    parseStateJsonObject(content);
    return content;
  });
}

export function saveWorkspaceStateForEnv(env: StorageEnv, json: string, revision: number): void {
  const state = parseStateJsonObject(json);
  const payload = JSON.stringify({ revision, state });
  saveStateFileWithBackup(getWorkspaceStatePath(env), payload);
}

export function loadWorkspaceStateForEnv(env: StorageEnv): {
  json: string;
  revision: number;
} | null {
  const statePath = getWorkspaceStatePath(env);
  const bakPath = `${statePath}.bak`;

  return readContentWithBackup(statePath, bakPath, (content) => {
    const parsed = parseStateJsonObject(content);
    if (!isFiniteNumber(parsed.revision)) {
      return null;
    }
    if (!isRecord(parsed.state)) {
      return null;
    }

    return {
      json: JSON.stringify(parsed.state),
      revision: Math.max(0, Math.floor(parsed.revision)),
    };
  });
}

export function loadTaskRegistryStateForEnv(env: StorageEnv): string | null {
  return loadWorkspaceStateForEnv(env)?.json ?? loadAppStateForEnv(env);
}

function validateArenaFilename(filename: string): void {
  const basename = path.basename(filename);
  if (basename !== filename) throw new Error('Invalid filename');
  if (!basename.startsWith('arena-') || !basename.endsWith('.json')) {
    throw new Error('Arena files must be arena-*.json');
  }
}

export function saveArenaDataForEnv(env: StorageEnv, filename: string, json: string): void {
  validateArenaFilename(filename);
  const filePath = path.join(env.userDataPath, filename);
  writeFileAtomically(filePath, json);
}

export function loadArenaDataForEnv(env: StorageEnv, filename: string): string | null {
  validateArenaFilename(filename);
  const filePath = path.join(env.userDataPath, filename);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
