import { getPersistentClientId } from '../lib/client-id';
import {
  getSafeLocalStorage,
  getSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage';
import { isNonNegativeInteger, isRecord } from '../lib/type-guards';

const TASK_NOTIFICATION_CLAIM_STORAGE_KEY = 'parallel-code-task-notification-claims';
const TASK_NOTIFICATION_TAB_ID_KEY = 'parallel-code-task-notification-tab-id';
const TASK_NOTIFICATION_CLAIM_CHANNEL = 'parallel-code-task-notifications';
const TASK_NOTIFICATION_CLAIM_TTL_MS = 10_000;

interface TaskNotificationClaimRecord {
  expiresAt: number;
  ownerId: string;
}

interface TaskNotificationClaimMessage {
  expiresAt: number;
  key: string;
  ownerId: string;
}

function getTaskNotificationTabId(): string {
  return getPersistentClientId(TASK_NOTIFICATION_TAB_ID_KEY, 'task-notification-tab');
}

function getLocalStorage(): Storage | null {
  return getSafeLocalStorage();
}

function parseClaimStorage(
  value: string | null,
): Record<string, TaskNotificationClaimRecord> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return null;
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, TaskNotificationClaimRecord] =>
        isTaskNotificationClaimRecord(entry[1]),
      ),
    );
  } catch {
    return null;
  }
}

function isTaskNotificationClaimRecord(value: unknown): value is TaskNotificationClaimRecord {
  return (
    isRecord(value) && isNonNegativeInteger(value.expiresAt) && typeof value.ownerId === 'string'
  );
}

function isTaskNotificationClaimMessage(value: unknown): value is TaskNotificationClaimMessage {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    isNonNegativeInteger(value.expiresAt) &&
    typeof value.ownerId === 'string'
  );
}

function readClaimStorage(): Record<string, TaskNotificationClaimRecord> {
  const storage = getLocalStorage();
  if (!storage) {
    return {};
  }

  return parseClaimStorage(getSafeStorageItem(storage, TASK_NOTIFICATION_CLAIM_STORAGE_KEY)) ?? {};
}

function writeClaimStorage(nextClaims: Record<string, TaskNotificationClaimRecord>): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  setSafeStorageItem(storage, TASK_NOTIFICATION_CLAIM_STORAGE_KEY, JSON.stringify(nextClaims));
}

function pruneExpiredClaims(
  claims: Record<string, TaskNotificationClaimRecord>,
  now: number,
): Record<string, TaskNotificationClaimRecord> {
  const nextClaims: Record<string, TaskNotificationClaimRecord> = {};

  for (const [key, value] of Object.entries(claims)) {
    if (value.expiresAt > now) {
      nextClaims[key] = value;
    }
  }

  return nextClaims;
}

export function createTaskNotificationClaimCoordinator(): {
  claim: (key: string) => boolean;
  dispose: () => void;
} {
  const tabId = getTaskNotificationTabId();
  const localClaims = new Map<string, number>();
  const channel =
    typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(TASK_NOTIFICATION_CLAIM_CHANNEL);

  channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isTaskNotificationClaimMessage(message)) {
      return;
    }

    localClaims.set(message.key, message.expiresAt);
  });

  function cleanupExpiredClaims(now: number): void {
    for (const [key, expiresAt] of localClaims) {
      if (expiresAt <= now) {
        localClaims.delete(key);
      }
    }
  }

  function claim(key: string): boolean {
    const now = Date.now();
    cleanupExpiredClaims(now);

    const localExpiration = localClaims.get(key);
    if (localExpiration && localExpiration > now) {
      return false;
    }

    const nextExpiresAt = now + TASK_NOTIFICATION_CLAIM_TTL_MS;
    const storedClaims = pruneExpiredClaims(readClaimStorage(), now);
    const existingClaim = storedClaims[key];
    if (existingClaim && existingClaim.expiresAt > now && existingClaim.ownerId !== tabId) {
      localClaims.set(key, existingClaim.expiresAt);
      return false;
    }

    storedClaims[key] = {
      expiresAt: nextExpiresAt,
      ownerId: tabId,
    };
    writeClaimStorage(storedClaims);

    const verifiedClaim = readClaimStorage()[key];
    if (!verifiedClaim || verifiedClaim.ownerId !== tabId || verifiedClaim.expiresAt <= now) {
      if (verifiedClaim?.expiresAt) {
        localClaims.set(key, verifiedClaim.expiresAt);
      }
      return false;
    }

    localClaims.set(key, nextExpiresAt);
    channel?.postMessage({
      expiresAt: nextExpiresAt,
      key,
      ownerId: tabId,
    } satisfies TaskNotificationClaimMessage);
    return true;
  }

  return {
    claim,
    dispose: () => {
      channel?.close();
      localClaims.clear();
    },
  };
}
