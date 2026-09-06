export const MAX_PENDING_WORKSPACE_EDIT_INTENTS = 128;

export type WorkspaceProjectEditableField =
  | 'agentRunnerConfig'
  | 'baseBranch'
  | 'branchPrefix'
  | 'color'
  | 'containerConfig'
  | 'deleteBranchOnClose'
  | 'defaultTaskGitIsolation'
  | 'name'
  | 'path'
  | 'projectMode'
  | 'terminalBookmarks';

export type WorkspaceTaskEditableField =
  | 'name'
  | 'planFileName'
  | 'planRelativePath'
  | 'savedAgentDef'
  | 'savedAgentDefs'
  | 'savedSelectedAgentIndex'
  | 'skipPermissions'
  | 'stepsTracking';

export type WorkspaceScalarEditableField =
  | 'completedTaskCount'
  | 'completedTaskDate'
  | 'customAgents'
  | 'hydraCommand'
  | 'hydraForceDispatchFromPromptPanel'
  | 'hydraStartupMode'
  | 'mergedLinesAdded'
  | 'mergedLinesRemoved';

interface WorkspaceEditIntentBase {
  acknowledgedBaseRevision: number;
  operationId: string;
}

export interface RenameTaskWorkspaceIntent extends WorkspaceEditIntentBase {
  baseName: string;
  kind: 'rename-task';
  nextName: string;
  taskId: string;
}

export interface ReorderWorkspaceIntent extends WorkspaceEditIntentBase {
  baseOrder: string[];
  kind: 'reorder-tasks';
  list: 'active' | 'collapsed';
  nextOrder: string[];
}

export interface EditProjectFieldWorkspaceIntent extends WorkspaceEditIntentBase {
  baseValue: unknown;
  field: WorkspaceProjectEditableField;
  kind: 'edit-project-field';
  nextValue: unknown;
  projectId: string;
}

export interface EditTaskFieldWorkspaceIntent extends WorkspaceEditIntentBase {
  baseValue: unknown;
  field: WorkspaceTaskEditableField;
  kind: 'edit-task-field';
  nextValue: unknown;
  taskId: string;
}

export interface EditWorkspaceFieldIntent extends WorkspaceEditIntentBase {
  baseValue: unknown;
  field: WorkspaceScalarEditableField;
  kind: 'edit-workspace-field';
  nextValue: unknown;
}

export type WorkspaceEditIntent =
  | EditProjectFieldWorkspaceIntent
  | EditTaskFieldWorkspaceIntent
  | EditWorkspaceFieldIntent
  | RenameTaskWorkspaceIntent
  | ReorderWorkspaceIntent;

export type WorkspaceEditIntentInput = {
  [TKind in WorkspaceEditIntent['kind']]: Omit<
    Extract<WorkspaceEditIntent, { kind: TKind }>,
    'acknowledgedBaseRevision'
  >;
}[WorkspaceEditIntent['kind']];

export interface WorkspaceIntentConflict {
  canonicalValue: unknown;
  intent: WorkspaceEditIntent;
  reason: 'same-field-changed' | 'target-missing';
}

export interface WorkspaceIntentRebaseResult<TState> {
  acknowledgedOperationIds: string[];
  conflicts: WorkspaceIntentConflict[];
  pendingIntents: WorkspaceEditIntent[];
  state: TState;
}

export interface WorkspaceIntentQueueSnapshot<TState> {
  lastAcknowledgedRevision: number;
  lastAcknowledgedState: TState;
  pendingIntents: readonly WorkspaceEditIntent[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => valuesEqual(entry, right[index]));
  }

  const leftRecord = left as UnknownRecord;
  const rightRecord = right as UnknownRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function replaceField(
  target: UnknownRecord,
  field: string,
  baseValue: unknown,
  nextValue: unknown,
): 'acknowledged' | 'applied' | 'conflict' {
  const currentValue = target[field];
  if (valuesEqual(currentValue, nextValue)) return 'acknowledged';
  if (!valuesEqual(currentValue, baseValue)) return 'conflict';
  if (nextValue === undefined) Reflect.deleteProperty(target, field);
  else target[field] = cloneValue(nextValue);
  return 'applied';
}

function applyRenameTask(
  state: UnknownRecord,
  intent: RenameTaskWorkspaceIntent,
): 'acknowledged' | 'applied' | 'conflict' | 'target-missing' {
  const tasks = state.tasks;
  if (!isRecord(tasks)) return 'target-missing';
  const task = tasks[intent.taskId];
  if (!isRecord(task)) return 'target-missing';
  return replaceField(task, 'name', intent.baseName, intent.nextName);
}

function applyReorder(
  state: UnknownRecord,
  intent: ReorderWorkspaceIntent,
): 'acknowledged' | 'applied' | 'conflict' {
  const field = intent.list === 'active' ? 'taskOrder' : 'collapsedTaskOrder';
  return replaceField(state, field, intent.baseOrder, intent.nextOrder);
}

function applyProjectField(
  state: UnknownRecord,
  intent: EditProjectFieldWorkspaceIntent,
): 'acknowledged' | 'applied' | 'conflict' | 'target-missing' {
  if (!Array.isArray(state.projects)) return 'target-missing';
  const project = state.projects.find((entry) => isRecord(entry) && entry.id === intent.projectId);
  if (!isRecord(project)) return 'target-missing';
  return replaceField(project, intent.field, intent.baseValue, intent.nextValue);
}

function applyTaskField(
  state: UnknownRecord,
  intent: EditTaskFieldWorkspaceIntent,
): 'acknowledged' | 'applied' | 'conflict' | 'target-missing' {
  const tasks = state.tasks;
  if (!isRecord(tasks)) return 'target-missing';
  const task = tasks[intent.taskId];
  if (!isRecord(task)) return 'target-missing';
  return replaceField(task, intent.field, intent.baseValue, intent.nextValue);
}

function applyWorkspaceField(
  state: UnknownRecord,
  intent: EditWorkspaceFieldIntent,
): 'acknowledged' | 'applied' | 'conflict' {
  return replaceField(state, intent.field, intent.baseValue, intent.nextValue);
}

function applyIntent(
  state: UnknownRecord,
  intent: WorkspaceEditIntent,
): 'acknowledged' | 'applied' | 'conflict' | 'target-missing' {
  switch (intent.kind) {
    case 'rename-task':
      return applyRenameTask(state, intent);
    case 'reorder-tasks':
      return applyReorder(state, intent);
    case 'edit-project-field':
      return applyProjectField(state, intent);
    case 'edit-task-field':
      return applyTaskField(state, intent);
    case 'edit-workspace-field':
      return applyWorkspaceField(state, intent);
  }
}

function assertIntent(intent: WorkspaceEditIntent): void {
  if (!intent.operationId || !Number.isSafeInteger(intent.acknowledgedBaseRevision)) {
    throw new Error('Workspace edit intents require an operation ID and safe base revision');
  }
  if (intent.acknowledgedBaseRevision < 0) {
    throw new Error('Workspace edit intent base revision cannot be negative');
  }
}

function intentsTargetSameField(left: WorkspaceEditIntent, right: WorkspaceEditIntent): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'rename-task':
      return right.kind === left.kind && left.taskId === right.taskId;
    case 'reorder-tasks':
      return right.kind === left.kind && left.list === right.list;
    case 'edit-project-field':
      return (
        right.kind === left.kind && left.projectId === right.projectId && left.field === right.field
      );
    case 'edit-task-field':
      return right.kind === left.kind && left.taskId === right.taskId && left.field === right.field;
    case 'edit-workspace-field':
      return right.kind === left.kind && left.field === right.field;
  }
}

function coalesceIntent(
  existing: WorkspaceEditIntent,
  incoming: WorkspaceEditIntent,
): WorkspaceEditIntent {
  if (!intentsTargetSameField(existing, incoming)) return cloneValue(incoming);
  switch (existing.kind) {
    case 'rename-task':
      if (incoming.kind !== existing.kind) return cloneValue(incoming);
      return { ...incoming, baseName: existing.baseName, operationId: existing.operationId };
    case 'reorder-tasks':
      if (incoming.kind !== existing.kind) return cloneValue(incoming);
      return { ...incoming, baseOrder: existing.baseOrder, operationId: existing.operationId };
    case 'edit-project-field':
      if (incoming.kind !== existing.kind) return cloneValue(incoming);
      return { ...incoming, baseValue: existing.baseValue, operationId: existing.operationId };
    case 'edit-task-field':
      if (incoming.kind !== existing.kind) return cloneValue(incoming);
      return { ...incoming, baseValue: existing.baseValue, operationId: existing.operationId };
    case 'edit-workspace-field':
      if (incoming.kind !== existing.kind) return cloneValue(incoming);
      return { ...incoming, baseValue: existing.baseValue, operationId: existing.operationId };
  }
}

function intentReturnsToBase(intent: WorkspaceEditIntent): boolean {
  switch (intent.kind) {
    case 'rename-task':
      return valuesEqual(intent.baseName, intent.nextName);
    case 'reorder-tasks':
      return valuesEqual(intent.baseOrder, intent.nextOrder);
    case 'edit-project-field':
    case 'edit-task-field':
    case 'edit-workspace-field':
      return valuesEqual(intent.baseValue, intent.nextValue);
  }
}

export function rebaseWorkspaceEditIntents<TState extends object>(
  canonicalState: TState,
  intents: readonly WorkspaceEditIntent[],
  acknowledgedOperationIds: ReadonlySet<string> = new Set(),
): WorkspaceIntentRebaseResult<TState> {
  const state = cloneValue(canonicalState) as TState & UnknownRecord;
  const pendingIntents: WorkspaceEditIntent[] = [];
  const conflicts: WorkspaceIntentConflict[] = [];
  const acknowledged: string[] = [];

  for (const intent of intents) {
    assertIntent(intent);
    if (acknowledgedOperationIds.has(intent.operationId)) {
      acknowledged.push(intent.operationId);
      continue;
    }

    const outcome = applyIntent(state, intent);
    if (outcome === 'acknowledged') {
      acknowledged.push(intent.operationId);
      continue;
    }
    if (outcome === 'applied') {
      pendingIntents.push(cloneValue(intent));
      continue;
    }

    conflicts.push({
      canonicalValue: getIntentTargetValue(state, intent),
      intent: cloneValue(intent),
      reason: outcome === 'target-missing' ? 'target-missing' : 'same-field-changed',
    });
  }

  return {
    acknowledgedOperationIds: acknowledged,
    conflicts,
    pendingIntents,
    state,
  };
}

function getIntentTargetValue(state: UnknownRecord, intent: WorkspaceEditIntent): unknown {
  switch (intent.kind) {
    case 'rename-task': {
      const tasks = state.tasks;
      if (!isRecord(tasks)) return undefined;
      const task = tasks[intent.taskId];
      return isRecord(task) ? task.name : undefined;
    }
    case 'reorder-tasks':
      return state[intent.list === 'active' ? 'taskOrder' : 'collapsedTaskOrder'];
    case 'edit-project-field': {
      const project = Array.isArray(state.projects)
        ? state.projects.find((entry) => isRecord(entry) && entry.id === intent.projectId)
        : undefined;
      return isRecord(project) ? project[intent.field] : undefined;
    }
    case 'edit-task-field': {
      const tasks = state.tasks;
      if (!isRecord(tasks)) return undefined;
      const task = tasks[intent.taskId];
      return isRecord(task) ? task[intent.field] : undefined;
    }
    case 'edit-workspace-field':
      return state[intent.field];
  }
}

export class WorkspaceEditIntentQueue<TState extends object> {
  private lastAcknowledgedRevision: number;
  private lastAcknowledgedState: TState;
  private pendingIntents: WorkspaceEditIntent[] = [];

  constructor(
    initialState: TState,
    initialRevision: number,
    private readonly capacity = MAX_PENDING_WORKSPACE_EDIT_INTENTS,
  ) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw new Error('Workspace intent queue revision must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('Workspace intent queue capacity must be a positive safe integer');
    }
    this.lastAcknowledgedState = cloneValue(initialState);
    this.lastAcknowledgedRevision = initialRevision;
  }

  enqueue(intent: WorkspaceEditIntent): void {
    assertIntent(intent);
    if (intent.acknowledgedBaseRevision !== this.lastAcknowledgedRevision) {
      throw new Error('Workspace edit intent was built against a stale acknowledged base');
    }
    if (this.pendingIntents.some((pending) => pending.operationId === intent.operationId)) {
      throw new Error(`Duplicate workspace edit operation ID: ${intent.operationId}`);
    }
    const existingIndex = this.pendingIntents.findIndex((pending) =>
      intentsTargetSameField(pending, intent),
    );
    if (existingIndex >= 0) {
      const existing = this.pendingIntents[existingIndex];
      if (!existing) throw new Error('Workspace edit intent queue index is invalid');
      const coalesced = coalesceIntent(existing, intent);
      if (intentReturnsToBase(coalesced)) this.pendingIntents.splice(existingIndex, 1);
      else this.pendingIntents[existingIndex] = coalesced;
      return;
    }
    if (intentReturnsToBase(intent)) return;
    if (this.pendingIntents.length >= this.capacity) {
      throw new Error('Workspace edit intent queue is full');
    }
    this.pendingIntents.push(cloneValue(intent));
  }

  replaceCanonicalBase(
    state: TState,
    revision: number,
    acknowledgedOperationIds: ReadonlySet<string> = new Set(),
  ): WorkspaceIntentRebaseResult<TState> {
    if (!Number.isSafeInteger(revision) || revision < this.lastAcknowledgedRevision) {
      throw new Error('Workspace canonical revision cannot move backwards');
    }
    const result = rebaseWorkspaceEditIntents(state, this.pendingIntents, acknowledgedOperationIds);
    this.lastAcknowledgedRevision = revision;
    this.lastAcknowledgedState = cloneValue(state);
    this.pendingIntents = result.pendingIntents.map((intent) => ({
      ...intent,
      acknowledgedBaseRevision: revision,
    }));
    return {
      ...result,
      pendingIntents: this.pendingIntents.map(cloneValue),
    };
  }

  snapshot(): WorkspaceIntentQueueSnapshot<TState> {
    return {
      lastAcknowledgedRevision: this.lastAcknowledgedRevision,
      lastAcknowledgedState: cloneValue(this.lastAcknowledgedState),
      pendingIntents: this.pendingIntents.map(cloneValue),
    };
  }
}
