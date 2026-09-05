import { isTaskCatalogIdentifier } from '../domain/task-catalog';
import {
  getSafeLocalStorage,
  getSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';

export const REMOTE_NEW_TASK_PREFERENCES_STORAGE_KEY =
  'parallel-code.remote-new-task-preferences.v1';

export interface RemoteNewTaskPreferences {
  agentDefId?: string;
  projectId?: string;
}

export const DEFAULT_REMOTE_NEW_TASK_PREFERENCES: Readonly<RemoteNewTaskPreferences> =
  Object.freeze({});

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isTaskCatalogIdentifier(value);
}

export function isRemoteNewTaskPreferences(value: unknown): value is RemoteNewTaskPreferences {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(['agentDefId', 'projectId']);
  return (
    Object.keys(record).every((key) => allowed.has(key)) &&
    isOptionalIdentifier(record.agentDefId) &&
    isOptionalIdentifier(record.projectId)
  );
}

/**
 * V1 briefly stored effect-bearing form options. Salvage only the harmless catalog selections;
 * every other legacy field is intentionally ignored so opening a new form starts conservatively.
 */
function decodeStoredPreferences(value: unknown): RemoteNewTaskPreferences {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(isTaskCatalogIdentifier(record.agentDefId) ? { agentDefId: record.agentDefId } : {}),
    ...(isTaskCatalogIdentifier(record.projectId) ? { projectId: record.projectId } : {}),
  };
}

export function loadRemoteNewTaskPreferences(): RemoteNewTaskPreferences {
  const encoded = getSafeStorageItem(
    getSafeLocalStorage(),
    REMOTE_NEW_TASK_PREFERENCES_STORAGE_KEY,
  );
  if (!encoded) return { ...DEFAULT_REMOTE_NEW_TASK_PREFERENCES };
  try {
    const decoded: unknown = JSON.parse(encoded);
    return decodeStoredPreferences(decoded);
  } catch {
    return { ...DEFAULT_REMOTE_NEW_TASK_PREFERENCES };
  }
}

export function saveRemoteNewTaskPreferences(preferences: RemoteNewTaskPreferences): boolean {
  if (!isRemoteNewTaskPreferences(preferences)) return false;
  return setSafeStorageItem(
    getSafeLocalStorage(),
    REMOTE_NEW_TASK_PREFERENCES_STORAGE_KEY,
    JSON.stringify(preferences),
  );
}
