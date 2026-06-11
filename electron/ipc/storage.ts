import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { isFiniteNumber, isRecord } from '../../src/lib/type-guards.js';
import { parsePersistedTaskLookupStateFromRoot } from './persisted-task-lookup-state.js';
import type { SavedStateDocument } from './saved-state-document.js';

export interface StorageEnv {
  userDataPath: string;
  isPackaged: boolean;
}

const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

export function getStateDirForEnv(env: StorageEnv): string {
  let dir = env.userDataPath;
  if (!env.isPackaged) {
    const base = path.basename(dir);
    dir = path.join(path.dirname(dir), `${base}-dev`);
  }
  return dir;
}

function getStatePath(env: StorageEnv): string {
  return path.join(getStateDirForEnv(env), 'state.json');
}

function getWorkspaceStatePath(env: StorageEnv): string {
  return path.join(getStateDirForEnv(env), 'workspace-state.json');
}

/**
 * Contract: callers pass `JSON.stringify` output for a JSON object. The string
 * is written as-is; it is NOT re-parsed for validation, because re-parsing a
 * multi-megabyte string it just produced was a measured hot-path cost.
 */
export function writeJsonFileAtomically(filePath: string, contents: string): void {
  writeFileAtomically(filePath, contents);
}

/**
 * Async sibling of `writeFileAtomically` for debounced persistence schedulers:
 * the only synchronous caller cost left is building the contents string.
 */
export async function writeFileAtomicallyAsync(filePath: string, contents: string): Promise<void> {
  await ensureStateDirAsync(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.promises.writeFile(tmpPath, contents, { encoding: 'utf8', mode: STATE_FILE_MODE });
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function chmodStateDirOwnerOnlySync(directoryPath: string): void {
  try {
    fs.chmodSync(directoryPath, STATE_DIR_MODE);
  } catch {
    /* ignore */
  }
}

async function chmodStateDirOwnerOnlyAsync(directoryPath: string): Promise<void> {
  await fs.promises.chmod(directoryPath, STATE_DIR_MODE).catch(() => {});
}

function ensureStateDirSync(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: STATE_DIR_MODE });
  chmodStateDirOwnerOnlySync(directoryPath);
}

async function ensureStateDirAsync(directoryPath: string): Promise<void> {
  await fs.promises.mkdir(directoryPath, { recursive: true, mode: STATE_DIR_MODE });
  await chmodStateDirOwnerOnlyAsync(directoryPath);
}

function writeFileAtomically(filePath: string, contents: string): void {
  ensureStateDirSync(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(tmpPath, contents, { encoding: 'utf8', mode: STATE_FILE_MODE });
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
    fs.chmodSync(destinationPath, STATE_FILE_MODE);
  } catch {
    /* ignore */
  }
}

export async function copyFileIfExistsAsync(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  try {
    await fs.promises.access(sourcePath, fs.constants.F_OK);
  } catch {
    return;
  }

  try {
    await fs.promises.copyFile(sourcePath, destinationPath);
    await fs.promises.chmod(destinationPath, STATE_FILE_MODE).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function saveStateFileWithBackup(statePath: string, contents: string): void {
  ensureStateDirSync(path.dirname(statePath));

  const bakPath = `${statePath}.bak`;
  copyFileIfExists(statePath, bakPath);
  writeFileAtomically(statePath, contents);
}

export function readContentWithBackup<T>(
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

function createSavedStateDocumentFromRoot(
  json: string,
  root: Record<string, unknown> | null,
): SavedStateDocument {
  return {
    json,
    root,
    taskLookup: parsePersistedTaskLookupStateFromRoot(root),
  };
}

export function loadAppStateDocumentForEnv(env: StorageEnv): SavedStateDocument | null {
  const statePath = getStatePath(env);
  const bakPath = `${statePath}.bak`;

  return readContentWithBackup(statePath, bakPath, (content) => {
    const root = parseStateJsonObject(content);
    return createSavedStateDocumentFromRoot(content, root);
  });
}

export function loadWorkspaceStateDocumentForEnv(env: StorageEnv): {
  document: SavedStateDocument;
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
      document: createSavedStateDocumentFromRoot(JSON.stringify(parsed.state), parsed.state),
      revision: Math.max(0, Math.floor(parsed.revision)),
    };
  });
}

export function loadTaskRegistryStateDocumentForEnv(env: StorageEnv): SavedStateDocument | null {
  return loadWorkspaceStateDocumentForEnv(env)?.document ?? loadAppStateDocumentForEnv(env);
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
