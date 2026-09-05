import {
  isTaskCatalogCursor,
  isTaskCatalogDeltaBatch,
  isTaskCatalogFetchResult,
  isTaskCatalogIdentifier,
  isTaskCatalogPage,
  isTaskCatalogReplaceManifest,
  TASK_CATALOG_ENTITY_KINDS,
  type GetTaskCatalogDeltasSinceRequest,
  type GetTaskCatalogPageRequest,
} from '../../src/domain/task-catalog.js';
import { isRecord } from '../../src/lib/type-guards.js';
import type { RemoteCommandRegistrationTable } from './remote-command-gateway.js';
import type { TaskCatalogState } from './task-catalog-state.js';

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isEmptyRequest(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isGetPageRequest(value: unknown): value is GetTaskCatalogPageRequest {
  if (!isRecord(value)) return false;
  const keys =
    value.cursor === undefined
      ? ['catalogVersion', 'kind', 'serverInstanceId', 'snapshotId']
      : ['catalogVersion', 'cursor', 'kind', 'serverInstanceId', 'snapshotId'];
  return (
    hasExactKeys(value, keys) &&
    Number.isSafeInteger(value.catalogVersion) &&
    (value.catalogVersion as number) >= 0 &&
    TASK_CATALOG_ENTITY_KINDS.includes(value.kind as (typeof TASK_CATALOG_ENTITY_KINDS)[number]) &&
    isTaskCatalogIdentifier(value.serverInstanceId) &&
    isTaskCatalogIdentifier(value.snapshotId) &&
    (value.cursor === undefined || isTaskCatalogCursor(value.cursor))
  );
}

function isGetDeltasRequest(value: unknown): value is GetTaskCatalogDeltasSinceRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['catalogVersion', 'serverInstanceId']) &&
    Number.isSafeInteger(value.catalogVersion) &&
    (value.catalogVersion as number) >= 0 &&
    isTaskCatalogIdentifier(value.serverInstanceId)
  );
}

export function createTaskCatalogRemoteCommandRegistrations(
  catalog: TaskCatalogState,
): RemoteCommandRegistrationTable {
  return {
    'task-catalog.get-deltas': {
      execute: (_context, request) => {
        if (!isGetDeltasRequest(request)) throw new TypeError('Invalid catalog delta request');
        return catalog.getDeltasSince(request);
      },
      isRequest: isGetDeltasRequest,
      isResult: (value): value is ReturnType<TaskCatalogState['getDeltasSince']> =>
        isTaskCatalogFetchResult(value, isTaskCatalogDeltaBatch),
    },
    'task-catalog.get-manifest': {
      execute: () => catalog.createManifest(),
      isRequest: isEmptyRequest,
      isResult: (value): value is ReturnType<TaskCatalogState['createManifest']> =>
        isTaskCatalogFetchResult(value, isTaskCatalogReplaceManifest),
    },
    'task-catalog.get-page': {
      execute: (_context, request) => {
        if (!isGetPageRequest(request)) throw new TypeError('Invalid catalog page request');
        return catalog.getPage(request);
      },
      isRequest: isGetPageRequest,
      isResult: (value): value is ReturnType<TaskCatalogState['getPage']> =>
        isTaskCatalogFetchResult(value, isTaskCatalogPage),
    },
  };
}
