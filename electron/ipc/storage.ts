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
