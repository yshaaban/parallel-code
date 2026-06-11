import { produce } from 'solid-js/store';
import type {
  CoordinatorBootstrapSnapshot,
  CoordinatorEventEnvelope,
  CoordinatorLandingStateSnapshot,
  CoordinatorPromptRequestSnapshot,
  CoordinatorRunMetaSnapshot,
  CoordinatorRunSnapshot,
  CoordinatorSubtaskSnapshot,
  CoordinatorWorkflowSnapshot,
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
      const run = state.coordinator.runs[event.runId];
      // Adopt the category version only when the event was fully applicable.
      // Compacted replay can deliver sub-entity deltas for a run the client
      // never received (the create event was superseded in the replay ring);
      // marking those as current would let a connection drop between the
      // replay batch and the repairing bootstrap present an incomplete run as
      // current truth, and the next resync would then skip the coordinator
      // category. Leaving the presented version stale keeps the repair path
      // alive.
      let fullyApplied = true;

      // Granular events no longer ride alongside a full-run snapshot, so the
      // run header is projected from the envelope to stay fresh.
      function refreshRunHeader(): void {
        if (!run) {
          return;
        }

        run.updatedAt = event.createdAt;
        run.eventVersion = event.entityVersion;
      }

      switch (event.eventType) {
        case 'run-upserted':
          state.coordinator.runs[event.runId] = event.payload as CoordinatorRunSnapshot;
          break;
        case 'run-meta-upserted': {
          // Seeding a missing run from meta is a degraded repair (collections
          // are unknown), so it must not mark the category current.
          if (!run) {
            fullyApplied = false;
          }
          const meta = event.payload as CoordinatorRunMetaSnapshot;
          state.coordinator.runs[event.runId] = {
            ...meta,
            landing: run?.landing ?? [],
            promptQueue: run?.promptQueue ?? [],
            subtasks: run?.subtasks ?? [],
            workflows: run?.workflows ?? [],
          };
          break;
        }
        case 'run-removed':
          delete state.coordinator.runs[event.runId];
          break;
        case 'subtask-upserted':
          if (!run) {
            fullyApplied = false;
            break;
          }
          run.subtasks = upsertByKey(
            run.subtasks,
            event.payload as CoordinatorSubtaskSnapshot,
            (subtask) => subtask.taskId,
          );
          refreshRunHeader();
          break;
        case 'subtask-removed':
          if (!run) {
            fullyApplied = false;
            break;
          }
          run.subtasks = removeByKey(run.subtasks, getEntityId(event), (subtask) => subtask.taskId);
          refreshRunHeader();
          break;
        case 'prompt-upserted':
          if (!run) {
            fullyApplied = false;
            break;
          }
          run.promptQueue = upsertByKey(
            run.promptQueue,
            event.payload as CoordinatorPromptRequestSnapshot,
            (prompt) => prompt.requestId,
          );
          refreshRunHeader();
          break;
        case 'prompt-removed':
          if (!run) {
            fullyApplied = false;
            break;
          }
          run.promptQueue = removeByKey(
            run.promptQueue,
            getEntityId(event),
            (prompt) => prompt.requestId,
          );
          refreshRunHeader();
          break;
        case 'landing-upserted': {
          if (!run) {
            fullyApplied = false;
            break;
          }
          run.landing = upsertByKey(
            run.landing,
            event.payload as CoordinatorLandingStateSnapshot,
            (landing) => landing.taskId,
          );
          refreshRunHeader();
          break;
        }
        case 'workflow-upserted': {
          if (!run) {
            fullyApplied = false;
            break;
          }
          run.workflows = upsertByKey(
            run.workflows,
            event.payload as CoordinatorWorkflowSnapshot,
            (workflow) => workflow.id,
          );
          refreshRunHeader();
          break;
        }
        case 'snapshot-required':
          break;
      }

      if (fullyApplied) {
        state.coordinator.stateVersion = event.categorySeq;
        state.coordinator.updatedAt = event.createdAt;
      }
    }),
  );
}

// Coordinator category versions are per-boot; a new server instance restarts
// them, so the resync applier resets the presented version before hydrating
// the new instance's full bootstrap (which then passes the replace gate).
export function resetCoordinatorVersionTracking(): void {
  setStore('coordinator', 'stateVersion', 0);
}

export function getCoordinatorRunForTask(taskId: string): CoordinatorRunSnapshot | null {
  return (
    Object.values(store.coordinator.runs).find((run) => run.coordinatorTaskId === taskId) ?? null
  );
}

export function getCoordinatorRun(runId: string): CoordinatorRunSnapshot | null {
  return store.coordinator.runs[runId] ?? null;
}
