import { createRandomId } from '../lib/random-id';
import {
  WorkspaceEditIntentQueue,
  rebaseWorkspaceEditIntents,
  type WorkspaceEditIntent,
  type WorkspaceEditIntentInput,
  type WorkspaceIntentConflict,
  type WorkspaceScalarEditableField,
  type WorkspaceTaskEditableField,
} from '../domain/workspace-edit-intents';
import { isRecord } from '../lib/type-guards';

function createStateSyncSourceId(): string {
  return createRandomId();
}

const STATE_SYNC_SOURCE_ID = createStateSyncSourceId();
let lastLoadedStateJson: string | null = null;
let lastLoadedWorkspaceStateJson: string | null = null;
let lastLoadedWorkspaceRevision = 0;
let workspaceEditIntentQueue: WorkspaceEditIntentQueue<Record<string, unknown>> | null = null;
let workspaceEditIntentConflicts: WorkspaceIntentConflict[] = [];

export function getStateSyncSourceId(): string {
  return STATE_SYNC_SOURCE_ID;
}

export function getLoadedStateJson(): string | null {
  return lastLoadedStateJson;
}

export function recordLoadedStateJson(json: string): void {
  lastLoadedStateJson = json;
}

export function getLoadedWorkspaceStateJson(): string | null {
  return lastLoadedWorkspaceStateJson;
}

export function getLoadedWorkspaceRevision(): number {
  return lastLoadedWorkspaceRevision;
}

export function recordLoadedWorkspaceState(
  json: string,
  revision: number,
): readonly WorkspaceIntentConflict[] {
  // Save acknowledgements can also arrive after a newer canonical push. They must not
  // rewind the revision used by the next save or discard edits against that newer base.
  if (revision < lastLoadedWorkspaceRevision) return [];
  lastLoadedWorkspaceStateJson = json;
  lastLoadedWorkspaceRevision = revision;
  const parsed = parseWorkspaceStateObject(json);
  if (!parsed) return [];
  if (!workspaceEditIntentQueue) {
    workspaceEditIntentQueue = new WorkspaceEditIntentQueue(parsed, revision);
    workspaceEditIntentConflicts = [];
    return [];
  }
  const result = workspaceEditIntentQueue.replaceCanonicalBase(parsed, revision);
  workspaceEditIntentConflicts = result.conflicts;
  return structuredClone(result.conflicts);
}

function parseWorkspaceStateObject(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function enqueueWorkspaceEditIntent(intent: WorkspaceEditIntentInput): void {
  const canonical = parseWorkspaceStateObject(lastLoadedWorkspaceStateJson ?? '{}') ?? {};
  workspaceEditIntentQueue ??= new WorkspaceEditIntentQueue(canonical, lastLoadedWorkspaceRevision);
  workspaceEditIntentQueue.enqueue({
    ...intent,
    acknowledgedBaseRevision: lastLoadedWorkspaceRevision,
  } as WorkspaceEditIntent);
}

function clonePersistedIntentValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function enqueueWorkspaceFieldEdit(
  field: WorkspaceScalarEditableField,
  baseValue: unknown,
  nextValue: unknown,
): void {
  enqueueWorkspaceEditIntent({
    baseValue: clonePersistedIntentValue(baseValue),
    field,
    kind: 'edit-workspace-field',
    nextValue: clonePersistedIntentValue(nextValue),
    operationId: createRandomId(),
  });
}

export function enqueueWorkspaceTaskFieldEdit(
  taskId: string,
  field: WorkspaceTaskEditableField,
  baseValue: unknown,
  nextValue: unknown,
): void {
  enqueueWorkspaceEditIntent({
    baseValue: clonePersistedIntentValue(baseValue),
    field,
    kind: 'edit-task-field',
    nextValue: clonePersistedIntentValue(nextValue),
    operationId: createRandomId(),
    taskId,
  });
}

export function enqueueWorkspaceOrderEdit(
  list: 'active' | 'collapsed',
  baseOrder: readonly string[],
  nextOrder: readonly string[],
): void {
  enqueueWorkspaceEditIntent({
    baseOrder: [...baseOrder],
    kind: 'reorder-tasks',
    list,
    nextOrder: [...nextOrder],
    operationId: createRandomId(),
  });
}

export function getRebasedWorkspaceStateJson(json: string): string {
  const canonical = parseWorkspaceStateObject(json);
  if (!canonical || !workspaceEditIntentQueue) return json;
  const pending = workspaceEditIntentQueue.snapshot().pendingIntents;
  if (pending.length === 0) return json;
  return JSON.stringify(rebaseWorkspaceEditIntents(canonical, pending).state);
}

export function getWorkspaceEditIntentConflicts(): readonly WorkspaceIntentConflict[] {
  return structuredClone(workspaceEditIntentConflicts);
}

export function getPendingWorkspaceEditIntents(): readonly WorkspaceEditIntent[] {
  return workspaceEditIntentQueue?.snapshot().pendingIntents ?? [];
}

export function resetPersistenceSessionStateForTests(): void {
  lastLoadedStateJson = null;
  lastLoadedWorkspaceStateJson = null;
  lastLoadedWorkspaceRevision = 0;
  workspaceEditIntentQueue = null;
  workspaceEditIntentConflicts = [];
}
