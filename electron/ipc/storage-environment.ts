import path from 'node:path';

export interface StorageEnv {
  userDataPath: string;
  isPackaged: boolean;
}

export function getStateDirForEnv(env: StorageEnv): string {
  if (env.isPackaged) return env.userDataPath;
  const base = path.basename(env.userDataPath);
  return path.join(path.dirname(env.userDataPath), `${base}-dev`);
}
