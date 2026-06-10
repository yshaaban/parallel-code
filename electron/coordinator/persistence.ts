import fs from 'node:fs';
import path from 'node:path';

import {
  isCoordinatorRunSnapshot,
  isCoordinatorSubtaskLaunchSnapshot,
  type CoordinatorRunSnapshot,
  type CoordinatorSubtaskLaunchSnapshot,
} from '../../src/domain/coordinator.js';
import { isArrayOf, isNonNegativeInteger, isRecord } from '../../src/lib/type-guards.js';
import type { StorageEnv } from '../ipc/storage.js';
import { getStateDirForEnv, writeJsonFileAtomically } from '../ipc/storage.js';
import type { CoordinatorRuntimeState } from './runtime.js';

interface PersistedCoordinatorToolCallResult {
  createdAt?: number;
  key: string;
  result: unknown;
}

interface PersistedCoordinatorRuntimeState {
  runs: CoordinatorRunSnapshot[];
  stateVersion: number;
  subtaskLaunches?: CoordinatorSubtaskLaunchSnapshot[];
  toolCallResults: PersistedCoordinatorToolCallResult[];
}

function getCoordinatorStatePath(env: StorageEnv): string {
  return path.join(getStateDirForEnv(env), 'coordinator-state.json');
}

function isPersistedCoordinatorToolCallResult(
  value: unknown,
): value is PersistedCoordinatorToolCallResult {
  return (
    isRecord(value) &&
    (value.createdAt === undefined || isNonNegativeInteger(value.createdAt)) &&
    typeof value.key === 'string' &&
    'result' in value
  );
}

function isPersistedCoordinatorRuntimeState(
  value: unknown,
): value is PersistedCoordinatorRuntimeState {
  return (
    isRecord(value) &&
    isArrayOf(value.runs, isCoordinatorRunSnapshot) &&
    isNonNegativeInteger(value.stateVersion) &&
    (value.subtaskLaunches === undefined ||
      isArrayOf(value.subtaskLaunches, isCoordinatorSubtaskLaunchSnapshot)) &&
    isArrayOf(value.toolCallResults, isPersistedCoordinatorToolCallResult)
  );
}

export function loadCoordinatorRuntimeStateForEnv(env: StorageEnv): CoordinatorRuntimeState | null {
  const statePath = getCoordinatorStatePath(env);
  try {
    const content = fs.readFileSync(statePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (!isPersistedCoordinatorRuntimeState(parsed)) {
      return null;
    }

    return {
      ...parsed,
      subtaskLaunches: parsed.subtaskLaunches ?? [],
      toolCallResults: parsed.toolCallResults.map((result) => ({
        createdAt: result.createdAt ?? 0,
        key: result.key,
        result: result.result,
      })),
    };
  } catch {
    return null;
  }
}

export function saveCoordinatorRuntimeStateForEnv(
  env: StorageEnv,
  state: CoordinatorRuntimeState,
): void {
  const statePath = getCoordinatorStatePath(env);
  writeJsonFileAtomically(statePath, JSON.stringify(state));
  try {
    // Durable subtask launch payloads can carry caller-supplied agent env, so the
    // state file gets the same owner-only protection as coordinator credential files.
    fs.chmodSync(statePath, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
}
