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
  /** Submitted values stay immutable until canonical acknowledgement or conflict. */
  submitted?: boolean;
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

export interface SetTaskShellMembershipIntent extends WorkspaceEditIntentBase {
  kind: 'set-task-shell-membership';
  present: boolean;
  shellId: string;
  taskId: string;
}

export type WorkspaceEditIntent =
  | EditProjectFieldWorkspaceIntent
  | EditTaskFieldWorkspaceIntent
  | EditWorkspaceFieldIntent
  | RenameTaskWorkspaceIntent
  | ReorderWorkspaceIntent
  | SetTaskShellMembershipIntent;

export type WorkspaceEditIntentInput = {
  [TKind in WorkspaceEditIntent['kind']]: Omit<
    Extract<WorkspaceEditIntent, { kind: TKind }>,
    'acknowledgedBaseRevision' | 'submitted'
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

type IntentField = [target: UnknownRecord, field: string, baseValue: unknown, nextValue: unknown];

function resolveIntentField(state: UnknownRecord, intent: WorkspaceEditIntent): IntentField | null {
  switch (intent.kind) {
    case 'rename-task':
    case 'edit-task-field': {
      const task = isRecord(state.tasks) ? state.tasks[intent.taskId] : undefined;
      if (!isRecord(task)) return null;
      return intent.kind === 'rename-task'
        ? [task, 'name', intent.baseName, intent.nextName]
        : [task, intent.field, intent.baseValue, intent.nextValue];
    }
    case 'reorder-tasks':
      return [
        state,
        intent.list === 'active' ? 'taskOrder' : 'collapsedTaskOrder',
        intent.baseOrder,
        intent.nextOrder,
      ];
    case 'edit-project-field': {
      const project = Array.isArray(state.projects)
        ? state.projects.find((entry) => isRecord(entry) && entry.id === intent.projectId)
        : undefined;
      return isRecord(project) ? [project, intent.field, intent.baseValue, intent.nextValue] : null;
    }
    case 'edit-workspace-field':
      return [state, intent.field, intent.baseValue, intent.nextValue];
    case 'set-task-shell-membership':
      return null;
  }
}

function matchesIntentResult(state: UnknownRecord, intent: WorkspaceEditIntent): boolean {
  const field = resolveIntentField(state, intent);
  return field !== null && valuesEqual(field[0][field[1]], field[3]);
}

function applyShellMembership(
  state: UnknownRecord,
  intent: SetTaskShellMembershipIntent,
  canonicalRevision?: number,
): 'acknowledged' | 'applied' | 'conflict' | 'target-missing' {
  const task = isRecord(state.tasks) ? state.tasks[intent.taskId] : undefined;
  if (!isRecord(task)) return 'target-missing';
  const shells = task.shellAgentIds;
  const ownership = task.taskInitialShellOwnership;
  if (
    task.id !== intent.taskId ||
    !Array.isArray(shells) ||
    (isRecord(ownership) &&
      ownership.kind === 'managed-terminal-v1' &&
      (!shells.includes(ownership.sessionId) ||
        (!intent.present && ownership.sessionId === intent.shellId)))
  )
    return 'conflict';

  const present = shells.includes(intent.shellId);
  // An equal-revision snapshot cannot acknowledge a close while an earlier add is in flight.
  // A newer matching canonical revision fences that older write through the server CAS.
  if (
    present === intent.present &&
    canonicalRevision !== undefined &&
    canonicalRevision > intent.acknowledgedBaseRevision
  )
    return 'acknowledged';
  if (intent.present && !present) shells.push(intent.shellId);
  else if (!intent.present) task.shellAgentIds = shells.filter((id) => id !== intent.shellId);
  task.shellCount = (task.shellAgentIds as unknown[]).length;
  return 'applied';
}

function applyIntent(
  state: UnknownRecord,
  intent: WorkspaceEditIntent,
  canonicalRevision?: number,
): 'acknowledged' | 'applied' | 'conflict' | 'target-missing' {
  if (intent.kind === 'set-task-shell-membership')
    return applyShellMembership(state, intent, canonicalRevision);
  const field = resolveIntentField(state, intent);
  return field ? replaceField(...field) : 'target-missing';
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
    case 'set-task-shell-membership':
      return (
        right.kind === left.kind && left.taskId === right.taskId && left.shellId === right.shellId
      );
  }
}

function coalesceIntent(
  existing: WorkspaceEditIntent,
  incoming: WorkspaceEditIntent,
): WorkspaceEditIntent {
  if (!intentsTargetSameField(existing, incoming)) return cloneValue(incoming);
  const base =
    existing.kind === 'rename-task'
      ? { baseName: existing.baseName }
      : existing.kind === 'reorder-tasks'
        ? { baseOrder: existing.baseOrder }
        : existing.kind === 'set-task-shell-membership'
          ? {}
          : { baseValue: existing.baseValue };
  return { ...incoming, ...base, operationId: existing.operationId };
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
    case 'set-task-shell-membership':
      return false;
  }
}

export function rebaseWorkspaceEditIntents<TState extends object>(
  canonicalState: TState,
  intents: readonly WorkspaceEditIntent[],
  acknowledgedOperationIds: ReadonlySet<string> = new Set(),
  canonicalRevision?: number,
): WorkspaceIntentRebaseResult<TState> {
  const state = cloneValue(canonicalState) as TState & UnknownRecord;
  const pendingIntents: WorkspaceEditIntent[] = [];
  const conflicts: WorkspaceIntentConflict[] = [];
  const acknowledged: string[] = [];

  for (const [index, intent] of intents.entries()) {
    assertIntent(intent);
    // A later exact result acknowledges its same-field prefix even when intermediate
    // save responses were skipped. Compare the canonical input, not earlier replayed edits.
    const canonicalAcknowledgement = intents.some(
      (candidate, candidateIndex) =>
        candidateIndex >= index &&
        intentsTargetSameField(intent, candidate) &&
        (canonicalRevision === undefined ||
          canonicalRevision > candidate.acknowledgedBaseRevision) &&
        matchesIntentResult(canonicalState as UnknownRecord, candidate),
    );
    if (acknowledgedOperationIds.has(intent.operationId) || canonicalAcknowledgement) {
      acknowledged.push(intent.operationId);
      continue;
    }

    const outcome = applyIntent(state, intent, canonicalRevision);
    if (outcome === 'acknowledged' && intent.kind === 'set-task-shell-membership') {
      acknowledged.push(intent.operationId);
      continue;
    }
    if (outcome === 'applied' || outcome === 'acknowledged') {
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
  if (intent.kind === 'set-task-shell-membership') {
    const task = isRecord(state.tasks) ? state.tasks[intent.taskId] : undefined;
    return isRecord(task) ? task.shellAgentIds : undefined;
  }
  const field = resolveIntentField(state, intent);
  return field?.[0][field[1]];
}

export class WorkspaceEditIntentQueue<TState extends object> {
  private lastAcknowledgedRevision: number;
  private lastAcknowledgedState: TState;
  private pendingIntents: WorkspaceEditIntent[] = [];
  private reservedCapacity = 0;

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
    const existingIndex = this.pendingIntents.findIndex(
      (pending) =>
        intentsTargetSameField(pending, intent) &&
        (!pending.submitted || intent.kind === 'set-task-shell-membership'),
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
    if (this.pendingIntents.length + this.reservedCapacity >= this.capacity) {
      throw new Error('Workspace edit intent queue is full');
    }
    this.pendingIntents.push(cloneValue(intent));
  }

  markSubmitted(state: TState): void {
    for (const intent of this.pendingIntents) {
      if (matchesIntentResult(state as UnknownRecord, intent)) intent.submitted = true;
    }
  }

  reserveCapacity(): () => void {
    if (this.pendingIntents.length + this.reservedCapacity >= this.capacity) {
      throw new Error('Workspace edit intent queue is full');
    }
    this.reservedCapacity += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedCapacity -= 1;
    };
  }

  replaceCanonicalBase(
    state: TState,
    revision: number,
    acknowledgedOperationIds: ReadonlySet<string> = new Set(),
  ): WorkspaceIntentRebaseResult<TState> {
    if (!Number.isSafeInteger(revision) || revision < this.lastAcknowledgedRevision) {
      throw new Error('Workspace canonical revision cannot move backwards');
    }
    const result = rebaseWorkspaceEditIntents(
      state,
      this.pendingIntents,
      acknowledgedOperationIds,
      revision,
    );
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
