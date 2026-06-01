import { produce } from 'solid-js/store';
import type {
  CoordinatorBootstrapSnapshot,
  CoordinatorEventEnvelope,
  CoordinatorLandingStateSnapshot,
  CoordinatorPromptRequestSnapshot,
  CoordinatorRunSnapshot,
  CoordinatorSubtaskSnapshot,
} from '../domain/coordinator';
import { setStore, store } from './core';

function toRunsById(
  runs: readonly CoordinatorRunSnapshot[],
): Record<string, CoordinatorRunSnapshot> {
  const nextRuns: Record<string, CoordinatorRunSnapshot> = {};
  for (const run of runs) {
    nextRuns[run.id] = run;
  }

  return nextRuns;
}

function shouldApplyCoordinatorEvent(event: CoordinatorEventEnvelope): boolean {
  return event.categorySeq >= store.coordinator.stateVersion;
}

function getEntityId(event: CoordinatorEventEnvelope): string {
  const separatorIndex = event.entityKey.indexOf(':');
  return separatorIndex === -1 ? event.entityKey : event.entityKey.slice(separatorIndex + 1);
}

function upsertByKey<TValue>(
  values: TValue[],
  nextValue: TValue,
  getKey: (value: TValue) => string,
): TValue[] {
  const nextKey = getKey(nextValue);
  const nextValues = [...values];
  const index = nextValues.findIndex((value) => getKey(value) === nextKey);
  if (index === -1) {
    nextValues.push(nextValue);
    return nextValues;
  }

  nextValues[index] = nextValue;
  return nextValues;
}

function removeByKey<TValue>(
  values: TValue[],
  key: string,
  getKey: (value: TValue) => string,
): TValue[] {
  return values.filter((value) => getKey(value) !== key);
}

export function replaceCoordinatorSnapshot(
  snapshot: CoordinatorBootstrapSnapshot,
  options: { replaceVersion?: number } = {},
): void {
  const replaceVersion = options.replaceVersion ?? snapshot.stateVersion;
  if (replaceVersion < store.coordinator.stateVersion) {
    return;
  }

  setStore('coordinator', {
    runs: toRunsById(snapshot.runs),
    stateVersion: replaceVersion,
    updatedAt: snapshot.generatedAt,
  });
}

export function applyCoordinatorEvent(event: CoordinatorEventEnvelope): void {
  if (!shouldApplyCoordinatorEvent(event)) {
    return;
  }

  setStore(
    produce((state) => {
      state.coordinator.stateVersion = event.categorySeq;
      state.coordinator.updatedAt = event.createdAt;
      const run = state.coordinator.runs[event.runId];

      switch (event.eventType) {
        case 'run-upserted':
          state.coordinator.runs[event.runId] = event.payload as CoordinatorRunSnapshot;
          return;
        case 'run-removed':
          delete state.coordinator.runs[event.runId];
          return;
        case 'subtask-upserted':
          if (!run) {
            return;
          }
          run.subtasks = upsertByKey(
            run.subtasks,
            event.payload as CoordinatorSubtaskSnapshot,
            (subtask) => subtask.taskId,
          );
          return;
        case 'subtask-removed':
          if (!run) {
            return;
          }
          run.subtasks = removeByKey(run.subtasks, getEntityId(event), (subtask) => subtask.taskId);
          return;
        case 'prompt-upserted':
          if (!run) {
            return;
          }
          run.promptQueue = upsertByKey(
            run.promptQueue,
            event.payload as CoordinatorPromptRequestSnapshot,
            (prompt) => prompt.requestId,
          );
          return;
        case 'prompt-removed':
          if (!run) {
            return;
          }
          run.promptQueue = removeByKey(
            run.promptQueue,
            getEntityId(event),
            (prompt) => prompt.requestId,
          );
          return;
        case 'landing-upserted': {
          if (!run) {
            return;
          }
          run.landing = upsertByKey(
            run.landing,
            event.payload as CoordinatorLandingStateSnapshot,
            (landing) => landing.taskId,
          );
          return;
        }
        case 'snapshot-required':
          return;
      }
    }),
  );
}

export function getCoordinatorRunForTask(taskId: string): CoordinatorRunSnapshot | null {
  return (
    Object.values(store.coordinator.runs).find((run) => run.coordinatorTaskId === taskId) ?? null
  );
}

export function getCoordinatorRun(runId: string): CoordinatorRunSnapshot | null {
  return store.coordinator.runs[runId] ?? null;
}
