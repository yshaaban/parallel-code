import {
  isTaskCreationOperationCapability,
  isTaskCreationOperationId,
  type TaskCreationOperationCapability,
  type TaskCreationOperationId,
} from '../domain/task-creation-ticket';
import {
  getSafeSessionStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';

export const REMOTE_TASK_CREATION_CREDENTIAL_STORAGE_KEY = 'parallel-code.remote-task-creation.v1';

export interface RemoteTaskCreationCredential {
  operationCapability: TaskCreationOperationCapability;
  operationId: TaskCreationOperationId;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function createTaskCreationOperationCapability(): TaskCreationOperationCapability {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure random capability generation is unavailable');
  }
  const encoded = encodeBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  if (!isTaskCreationOperationCapability(encoded)) {
    throw new Error('Secure random capability generation returned a noncanonical value');
  }
  return encoded;
}

/** Loads only operation access. Requests, tickets, prompts, and client-clock deadlines stay out. */
export function loadRemoteTaskCreationCredential(): RemoteTaskCreationCredential | null {
  const encoded = getSafeStorageItem(
    getSafeSessionStorage(),
    REMOTE_TASK_CREATION_CREDENTIAL_STORAGE_KEY,
  );
  if (!encoded) return null;
  try {
    const decoded: unknown = JSON.parse(encoded);
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const record = decoded as Record<string, unknown>;
    return Object.keys(record).length === 2 &&
      isTaskCreationOperationId(record.operationId) &&
      isTaskCreationOperationCapability(record.operationCapability)
      ? {
          operationCapability: record.operationCapability,
          operationId: record.operationId,
        }
      : null;
  } catch {
    return null;
  }
}

export function saveRemoteTaskCreationCredential(
  credential: RemoteTaskCreationCredential,
): boolean {
  return setSafeStorageItem(
    getSafeSessionStorage(),
    REMOTE_TASK_CREATION_CREDENTIAL_STORAGE_KEY,
    JSON.stringify(credential),
  );
}

export function clearRemoteTaskCreationCredential(): void {
  removeSafeStorageItem(getSafeSessionStorage(), REMOTE_TASK_CREATION_CREDENTIAL_STORAGE_KEY);
}
