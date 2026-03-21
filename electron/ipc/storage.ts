import fs from 'fs';
import path from 'path';

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
  const tmpPath = `${filePath}.tmp`;

  fs.writeFileSync(tmpPath, contents, 'utf8');

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    removeFileIfExists(tmpPath);
    throw error;
  }
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
  const statePath = getStatePath(env);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  JSON.parse(json);

  const bakPath = `${statePath}.bak`;
  copyFileIfExists(statePath, bakPath);
  writeFileAtomically(statePath, json);
}

export function loadAppStateForEnv(env: StorageEnv): string | null {
  const statePath = getStatePath(env);
  const bakPath = `${statePath}.bak`;

  return readContentWithBackup(statePath, bakPath, (content) => {
    JSON.parse(content);
    return content;
  });
}

export function saveWorkspaceStateForEnv(env: StorageEnv, json: string, revision: number): void {
  const statePath = getWorkspaceStatePath(env);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  const state = JSON.parse(json);
  const payload = JSON.stringify({ revision, state });
  const bakPath = `${statePath}.bak`;

  copyFileIfExists(statePath, bakPath);
  writeFileAtomically(statePath, payload);
}

export function loadWorkspaceStateForEnv(env: StorageEnv): {
  json: string;
  revision: number;
} | null {
  const statePath = getWorkspaceStatePath(env);
  const bakPath = `${statePath}.bak`;

  return readContentWithBackup(statePath, bakPath, (content) => {
    const parsed = JSON.parse(content) as {
      revision?: unknown;
      state?: unknown;
    };
    if (typeof parsed.revision !== 'number' || !Number.isFinite(parsed.revision)) {
      return null;
    }

    return {
      json: JSON.stringify(parsed.state ?? null),
      revision: Math.max(0, Math.floor(parsed.revision)),
    };
  });
}

export function loadTaskRegistryStateForEnv(env: StorageEnv): string | null {
  const workspaceState = loadWorkspaceStateForEnv(env);
  if (workspaceState) {
    return workspaceState.json;
  }

  return loadAppStateForEnv(env);
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
