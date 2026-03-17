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

export function saveAppStateForEnv(env: StorageEnv, json: string): void {
  const statePath = getStatePath(env);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  JSON.parse(json);

  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, json, 'utf8');

  if (fs.existsSync(statePath)) {
    const bakPath = statePath + '.bak';
    try {
      fs.copyFileSync(statePath, bakPath);
    } catch {
      /* ignore */
    }
  }

  fs.renameSync(tmpPath, statePath);
}

export function loadAppStateForEnv(env: StorageEnv): string | null {
  const statePath = getStatePath(env);
  const bakPath = statePath + '.bak';

  try {
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf8');
      if (content.trim()) return content;
    }
  } catch {
    // Primary state file unreadable — try backup
  }

  try {
    if (fs.existsSync(bakPath)) {
      const content = fs.readFileSync(bakPath, 'utf8');
      if (content.trim()) return content;
    }
  } catch {
    // Backup also unreadable
  }

  return null;
}

export function saveWorkspaceStateForEnv(env: StorageEnv, json: string, revision: number): void {
  const statePath = getWorkspaceStatePath(env);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });

  const state = JSON.parse(json);
  const payload = JSON.stringify({ revision, state });
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, payload, 'utf8');

  if (fs.existsSync(statePath)) {
    const bakPath = statePath + '.bak';
    try {
      fs.copyFileSync(statePath, bakPath);
    } catch {
      /* ignore */
    }
  }

  fs.renameSync(tmpPath, statePath);
}

export function loadWorkspaceStateForEnv(env: StorageEnv): {
  json: string;
  revision: number;
} | null {
  const statePath = getWorkspaceStatePath(env);
  const bakPath = statePath + '.bak';

  function readPayload(filePath: string): { json: string; revision: number } | null {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      return null;
    }

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
  }

  try {
    if (fs.existsSync(statePath)) {
      const payload = readPayload(statePath);
      if (payload) {
        return payload;
      }
    }
  } catch {
    // Primary state file unreadable — try backup
  }

  try {
    if (fs.existsSync(bakPath)) {
      const payload = readPayload(bakPath);
      if (payload) {
        return payload;
      }
    }
  } catch {
    // Backup also unreadable
  }

  return null;
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
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, json, 'utf-8');
  fs.renameSync(tmpPath, filePath);
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
