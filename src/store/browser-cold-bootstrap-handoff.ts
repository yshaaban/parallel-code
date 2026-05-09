import type { BrowserColdBootstrapProjection } from '../domain/browser-cold-bootstrap.js';
import { buildBrowserColdBootstrapProjectionFromJson } from '../domain/browser-cold-bootstrap-projection-builder.js';
import { isElectronRuntime } from '../lib/ipc.js';
import {
  getSafeSessionStorage,
  getSafeStorageItem,
  removeSafeStorageItem,
  setSafeStorageItem,
} from '../lib/browser-storage.js';
import { isFiniteNumber, isRecord } from '../lib/type-guards.js';
import type { BrowserColdBootstrapProjectionBuildOptions } from './browser-cold-bootstrap-projection-types.js';

const BROWSER_COLD_BOOTSTRAP_HANDOFF_STORAGE_KEY = 'parallel-code-browser-cold-bootstrap-handoff';
const BROWSER_COLD_BOOTSTRAP_HANDOFF_MAX_AGE_MS = 10_000;

interface StoredBrowserColdBootstrapHandoff {
  capturedAtMs: number;
  workspaceStateJson: string;
}

function getSessionStorage(): Storage | null {
  if (isElectronRuntime()) {
    return null;
  }

  return getSafeSessionStorage();
}

function parseStoredBrowserColdBootstrapHandoff(
  raw: string,
): StoredBrowserColdBootstrapHandoff | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    if (typeof parsed.workspaceStateJson !== 'string') {
      return null;
    }

    return {
      capturedAtMs: isFiniteNumber(parsed.capturedAtMs) ? parsed.capturedAtMs : 0,
      workspaceStateJson: parsed.workspaceStateJson,
    };
  } catch {
    return null;
  }
}

function isFreshBrowserColdBootstrapHandoff(handoff: StoredBrowserColdBootstrapHandoff): boolean {
  if (handoff.capturedAtMs <= 0) {
    return false;
  }

  return Date.now() - handoff.capturedAtMs <= BROWSER_COLD_BOOTSTRAP_HANDOFF_MAX_AGE_MS;
}

export function hasMeaningfulBrowserColdBootstrapProjection(
  projection: BrowserColdBootstrapProjection | null | undefined,
): projection is BrowserColdBootstrapProjection {
  if (!projection) {
    return false;
  }

  const activeTaskIds = projection.taskOrder.filter(
    (taskId) => projection.tasks[taskId] !== undefined,
  );
  const collapsedTaskIds = projection.collapsedTaskOrder.filter(
    (taskId) => projection.tasks[taskId] !== undefined,
  );

  return (
    projection.projects.length > 0 ||
    activeTaskIds.length > 0 ||
    collapsedTaskIds.length > 0 ||
    Object.keys(projection.tasks).length > 0
  );
}

export function saveBrowserColdBootstrapHandoffSnapshot(workspaceStateJson: string): void {
  const payload = JSON.stringify({
    capturedAtMs: Date.now(),
    workspaceStateJson,
  } satisfies StoredBrowserColdBootstrapHandoff);

  const storage = getSessionStorage();
  if (storage) {
    setSafeStorageItem(storage, BROWSER_COLD_BOOTSTRAP_HANDOFF_STORAGE_KEY, payload);
  }
}

export function takeBrowserColdBootstrapHandoffProjection(
  options: BrowserColdBootstrapProjectionBuildOptions,
): BrowserColdBootstrapProjection | null {
  const storage = getSessionStorage();
  const rawHandoff = getSafeStorageItem(storage, BROWSER_COLD_BOOTSTRAP_HANDOFF_STORAGE_KEY);
  if (storage) {
    removeSafeStorageItem(storage, BROWSER_COLD_BOOTSTRAP_HANDOFF_STORAGE_KEY);
  }
  if (!rawHandoff) {
    return null;
  }

  const handoff = parseStoredBrowserColdBootstrapHandoff(rawHandoff);
  if (!handoff || !isFreshBrowserColdBootstrapHandoff(handoff)) {
    return null;
  }

  return buildBrowserColdBootstrapProjectionFromJson(handoff.workspaceStateJson, options);
}
