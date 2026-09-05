import { isTaskCatalogDeltaBatch } from '../../src/domain/task-catalog.js';
import { isRecord } from '../../src/lib/type-guards.js';
import {
  isCoreServerMessage,
  type ServerMessage,
  type TaskCatalogDeltaMessage,
} from './protocol.js';

export type RemoteBaseServerMessage = Exclude<
  ServerMessage,
  {
    type: 'task-creation-operation-snapshot' | 'task-creation-operation-subscription-state';
  }
>;

export function isTaskCatalogDeltaMessage(value: unknown): value is TaskCatalogDeltaMessage {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === 'task-catalog-delta' &&
    isTaskCatalogDeltaBatch(value.batch)
  );
}

export function isRemoteBaseServerMessage(value: unknown): value is RemoteBaseServerMessage {
  return isCoreServerMessage(value) || isTaskCatalogDeltaMessage(value);
}
