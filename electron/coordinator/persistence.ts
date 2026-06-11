import fs from 'node:fs';
import path from 'node:path';

import {
  COORDINATOR_PERSISTENCE_LIMITS,
  isCoordinatorPendingPromptStatus,
  isCoordinatorRunSnapshot,
  isCoordinatorSubtaskLaunchSnapshot,
  type CoordinatorPromptRequestSnapshot,
  type CoordinatorRunSnapshot,
  type CoordinatorRunStatus,
  type CoordinatorSubtaskLaunchSnapshot,
} from '../../src/domain/coordinator.js';
import { isNonNegativeInteger, isRecord } from '../../src/lib/type-guards.js';
import type { StorageEnv } from '../ipc/storage.js';
import {
  copyFileIfExistsAsync,
  getStateDirForEnv,
  saveStateFileWithBackup,
  writeFileAtomicallyAsync,
} from '../ipc/storage.js';
import type { CoordinatorRuntimeState } from './runtime.js';

// coordinator-state.json durability rules:
// - every save keeps a .bak sibling; loads fall back to it when the primary is
//   unreadable or structurally broken
// - an unparseable primary is quarantined to coordinator-state.json.corrupt-<ts>
//   before the backup is tried, never silently discarded
// - runs are validated individually: one corrupt run loses only that run
// - the load outcome is explicit so callers can distinguish "loaded empty"
//   from "load FAILED" (credential pruning must never run on a failed load)
// - saves are compacted: terminal runs drop delivery journals and launch
//   payloads, and completed-run/prompt/resume/tool-result retention is capped

interface PersistedCoordinatorToolCallResult {
  createdAt?: number;
  key: string;
  result: unknown;
}

export type CoordinatorRuntimeLoadOutcome = 'ok' | 'salvaged' | 'failed' | 'missing';

export interface CoordinatorRuntimeLoadResult {
  droppedRunCount: number;
  outcome: CoordinatorRuntimeLoadOutcome;
  state: CoordinatorRuntimeState | null;
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

interface SalvagedCoordinatorRuntimeState {
  droppedEntryCount: number;
  droppedRunCount: number;
  state: CoordinatorRuntimeState;
}

function getCoordinatorRuntimeLoadOutcome(
  droppedRunCount: number,
  droppedEntryCount: number,
): CoordinatorRuntimeLoadOutcome {
  if (droppedRunCount > 0 || droppedEntryCount > 0) {
    return 'salvaged';
  }

  return 'ok';
}

// Per-entity salvage: a structurally valid top-level state keeps every valid
// run/launch/tool-result and drops only the invalid entries.
function salvageCoordinatorRuntimeState(value: unknown): SalvagedCoordinatorRuntimeState | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.runs) ||
    !isNonNegativeInteger(value.stateVersion) ||
    !Array.isArray(value.toolCallResults) ||
    (value.subtaskLaunches !== undefined && !Array.isArray(value.subtaskLaunches))
  ) {
    return null;
  }

  let droppedEntryCount = 0;
  const runs: CoordinatorRunSnapshot[] = [];
  let droppedRunCount = 0;
  for (const run of value.runs) {
    if (isCoordinatorRunSnapshot(run)) {
      runs.push(run);
    } else {
      droppedRunCount += 1;
    }
  }

  const subtaskLaunches: CoordinatorSubtaskLaunchSnapshot[] = [];
  for (const launch of value.subtaskLaunches ?? []) {
    if (isCoordinatorSubtaskLaunchSnapshot(launch)) {
      subtaskLaunches.push(launch);
    } else {
      droppedEntryCount += 1;
    }
  }

  const toolCallResults: CoordinatorRuntimeState['toolCallResults'] = [];
  for (const result of value.toolCallResults) {
    if (isPersistedCoordinatorToolCallResult(result)) {
      toolCallResults.push({
        createdAt: result.createdAt ?? 0,
        key: result.key,
        result: result.result,
      });
    } else {
      droppedEntryCount += 1;
    }
  }

  return {
    droppedEntryCount,
    droppedRunCount,
    state: {
      runs,
      stateVersion: value.stateVersion,
      subtaskLaunches,
      toolCallResults,
    },
  };
}

function quarantineCorruptCoordinatorState(statePath: string): void {
  const quarantinePath = `${statePath}.corrupt-${Date.now()}`;
  try {
    fs.copyFileSync(statePath, quarantinePath);
    console.warn(`Quarantined corrupt coordinator state to ${quarantinePath}`);
  } catch {
    // Best effort: a quarantine copy failure must not block the backup read.
  }
}

type CoordinatorStateReadAttempt =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'invalid' }
  | { kind: 'parsed'; salvaged: SalvagedCoordinatorRuntimeState };

function readCoordinatorStateFile(filePath: string): CoordinatorStateReadAttempt {
  let content: string;
  try {
    if (!fs.existsSync(filePath)) {
      return { kind: 'missing' };
    }

    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { kind: 'unreadable' };
  }

  if (!content.trim()) {
    return { kind: 'invalid' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: 'invalid' };
  }

  const salvaged = salvageCoordinatorRuntimeState(parsed);
  if (salvaged === null) {
    return { kind: 'invalid' };
  }

  return { kind: 'parsed', salvaged };
}

export function loadCoordinatorRuntimeStateForEnv(env: StorageEnv): CoordinatorRuntimeLoadResult {
  const statePath = getCoordinatorStatePath(env);
  const bakPath = `${statePath}.bak`;

  const primary = readCoordinatorStateFile(statePath);
  if (primary.kind === 'parsed') {
    const { droppedEntryCount, droppedRunCount, state } = primary.salvaged;
    if (droppedRunCount > 0 || droppedEntryCount > 0) {
      console.warn(
        `Coordinator state salvage dropped ${droppedRunCount} run(s) and ${droppedEntryCount} other entr(ies) from ${statePath}`,
      );
    }
    return {
      droppedRunCount,
      outcome: getCoordinatorRuntimeLoadOutcome(droppedRunCount, droppedEntryCount),
      state,
    };
  }

  if (primary.kind === 'invalid') {
    quarantineCorruptCoordinatorState(statePath);
  }

  const backup = readCoordinatorStateFile(bakPath);
  if (backup.kind === 'parsed') {
    console.warn(`Coordinator state restored from backup ${bakPath}`);
    return {
      droppedRunCount: backup.salvaged.droppedRunCount,
      outcome: 'salvaged',
      state: backup.salvaged.state,
    };
  }

  if (primary.kind === 'missing' && backup.kind === 'missing') {
    return { droppedRunCount: 0, outcome: 'missing', state: null };
  }

  return { droppedRunCount: 0, outcome: 'failed', state: null };
}

function isTerminalCoordinatorRunStatus(status: CoordinatorRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function compactPromptForTerminalRun(
  prompt: CoordinatorPromptRequestSnapshot,
): CoordinatorPromptRequestSnapshot {
  if (prompt.deliveryJournal.length === 0) {
    return prompt;
  }

  return {
    ...prompt,
    deliveryJournal: [],
  };
}

function compactRunPrompts(
  run: CoordinatorRunSnapshot,
  terminalRun: boolean,
): CoordinatorPromptRequestSnapshot[] {
  const prompts = terminalRun ? run.promptQueue.map(compactPromptForTerminalRun) : run.promptQueue;
  const pending = prompts.filter((prompt) => isCoordinatorPendingPromptStatus(prompt.status));
  const settled = prompts.filter((prompt) => !isCoordinatorPendingPromptStatus(prompt.status));
  if (settled.length <= COORDINATOR_PERSISTENCE_LIMITS.maxRetainedSettledPromptsPerRun) {
    return prompts;
  }

  const pendingSet = new Set(pending);
  const retainedSettled = new Set(
    [...settled]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, COORDINATOR_PERSISTENCE_LIMITS.maxRetainedSettledPromptsPerRun),
  );
  return prompts.filter((prompt) => pendingSet.has(prompt) || retainedSettled.has(prompt));
}

function compactRunForPersistence(run: CoordinatorRunSnapshot): CoordinatorRunSnapshot {
  const terminalRun = isTerminalCoordinatorRunStatus(run.status);
  const nextRun: CoordinatorRunSnapshot = {
    ...run,
    promptQueue: compactRunPrompts(run, terminalRun),
  };

  const resumes = run.resumes;
  if (
    resumes !== undefined &&
    resumes.length > COORDINATOR_PERSISTENCE_LIMITS.maxRetainedResumesPerRun
  ) {
    nextRun.resumes = resumes.slice(-COORDINATOR_PERSISTENCE_LIMITS.maxRetainedResumesPerRun);
  }

  return nextRun;
}

function capRetainedTerminalRuns(runs: CoordinatorRunSnapshot[]): CoordinatorRunSnapshot[] {
  const terminalRuns = runs.filter((run) => isTerminalCoordinatorRunStatus(run.status));
  if (terminalRuns.length <= COORDINATOR_PERSISTENCE_LIMITS.maxRetainedCompletedRuns) {
    return runs;
  }

  const retainedTerminalRuns = new Set(
    [...terminalRuns]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, COORDINATOR_PERSISTENCE_LIMITS.maxRetainedCompletedRuns),
  );
  return runs.filter(
    (run) => !isTerminalCoordinatorRunStatus(run.status) || retainedTerminalRuns.has(run),
  );
}

function capToolCallResultBytes(
  toolCallResults: CoordinatorRuntimeState['toolCallResults'],
): CoordinatorRuntimeState['toolCallResults'] {
  const newestFirst = [...toolCallResults].sort((left, right) => right.createdAt - left.createdAt);
  const retained: CoordinatorRuntimeState['toolCallResults'] = [];
  let totalBytes = 0;
  for (const entry of newestFirst) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (totalBytes + entryBytes > COORDINATOR_PERSISTENCE_LIMITS.maxRetainedToolCallResultBytes) {
      break;
    }

    totalBytes += entryBytes;
    retained.push(entry);
  }

  if (retained.length === toolCallResults.length) {
    return toolCallResults;
  }

  const retainedSet = new Set(retained);
  return toolCallResults.filter((entry) => retainedSet.has(entry));
}

export function compactCoordinatorRuntimeStateForPersistence(
  state: CoordinatorRuntimeState,
): CoordinatorRuntimeState {
  const runs = capRetainedTerminalRuns(state.runs).map(compactRunForPersistence);
  const retainedRunIds = new Set(runs.map((run) => run.id));
  const liveRunIds = new Set(
    runs.filter((run) => !isTerminalCoordinatorRunStatus(run.status)).map((run) => run.id),
  );
  return {
    runs,
    stateVersion: state.stateVersion,
    // Launch payloads exist to respawn unfinished work; terminal runs never
    // respawn, so their (possibly secret-bearing) payloads are dropped.
    subtaskLaunches: state.subtaskLaunches.filter(
      (launch) => retainedRunIds.has(launch.runId) && liveRunIds.has(launch.runId),
    ),
    toolCallResults: capToolCallResultBytes(state.toolCallResults),
  };
}

function chmodOwnerOnlySync(filePath: string): void {
  try {
    // Durable subtask launch payloads can carry caller-supplied agent env, so the
    // state file gets the same owner-only protection as coordinator credential files.
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
}

export function saveCoordinatorRuntimeStateForEnv(
  env: StorageEnv,
  state: CoordinatorRuntimeState,
): void {
  const statePath = getCoordinatorStatePath(env);
  saveStateFileWithBackup(
    statePath,
    JSON.stringify(compactCoordinatorRuntimeStateForPersistence(state)),
  );
  chmodOwnerOnlySync(statePath);
  chmodOwnerOnlySync(`${statePath}.bak`);
}

export async function saveCoordinatorRuntimeStateForEnvAsync(
  env: StorageEnv,
  state: CoordinatorRuntimeState,
): Promise<void> {
  const statePath = getCoordinatorStatePath(env);
  const bakPath = `${statePath}.bak`;
  const contents = JSON.stringify(compactCoordinatorRuntimeStateForPersistence(state));
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await copyFileIfExistsAsync(statePath, bakPath);
  await writeFileAtomicallyAsync(statePath, contents);
  await fs.promises.chmod(statePath, 0o600).catch(() => {});
}
