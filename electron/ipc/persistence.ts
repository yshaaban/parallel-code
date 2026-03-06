import { app } from 'electron';
import { loadAppStateForEnv, saveAppStateForEnv } from './storage.js';

function getStorageEnv() {
  return {
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
  };
}

export function saveAppState(json: string): void {
  saveAppStateForEnv(getStorageEnv(), json);
}

export function loadAppState(): string | null {
  return loadAppStateForEnv(getStorageEnv());
}
