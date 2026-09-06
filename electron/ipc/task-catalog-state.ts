import crypto from 'node:crypto';

import {
  TASK_CATALOG_ENTITY_KINDS,
  TASK_CATALOG_LIMITS,
  getTaskCatalogEntityId,
  isRemoteAgentChoice,
  isRemoteProjectSummary,
  isRemoteTaskSessionRef,
  isRemoteTaskSummary,
  isTaskCatalogCursor,
  isTaskCatalogIdentifier,
  isTaskCatalogPage,
  isTaskCatalogReplaceManifest,
  type RemoteAgentChoice,
  type RemoteProjectSummary,
  type RemoteTaskLocationKind,
  type RemoteTaskSessionRef,
  type RemoteTaskSummary,
  type GetTaskCatalogDeltasSinceRequest,
  type GetTaskCatalogPageRequest,
  type TaskCatalogDeltaBatch,
  type TaskCatalogEntityKind,
  type TaskCatalogEntityMap,
  type TaskCatalogEvent,
  type TaskCatalogFetchResult,
  type TaskCatalogPage,
  type TaskCatalogReplaceManifest,
  type TaskRemovalCurrentProjection,
} from '../../src/domain/task-catalog.js';
import { resolvePersistedTaskMode } from '../../src/domain/task-mode.js';
import { canonicalJsonStringify, type JsonObject } from './workspace-state-storage.js';

const MAX_REMOVED_TASK_TOMBSTONES = 4_096;
const SNAPSHOT_TTL_MS = 30_000;
const DISPLAY_CONTROL_PATTERN = /\p{Cc}/gu;
const UNPAIRED_SURROGATE_PATTERN = /[\uD800-\uDFFF]/gu;

type CatalogRows = { [Kind in TaskCatalogEntityKind]: TaskCatalogEntityMap[Kind][] };
type CatalogRowIndexes = Record<TaskCatalogEntityKind, Map<string, number>>;

export interface TaskCatalogSessionRuntime {
  generation: number;
  sessionId: string;
  state: RemoteTaskSessionRef['state'];
}

export interface TaskCatalogProjectionInput {
  closingTaskIds?: readonly string[];
  sessionRuntime?: readonly TaskCatalogSessionRuntime[];
  sharedState: Readonly<JsonObject>;
  staticAgents?: readonly RemoteAgentChoice[];
}

export interface TaskCatalogStateOptions {
  createSnapshotId?: () => string;
  now?: () => number;
  serverInstanceId: string;
}

interface CatalogSnapshotLease {
  catalogVersion: number;
  expiresAt: number;
  rows: CatalogRows;
  snapshotId: string;
}

interface ProjectedCatalog {
  rows: CatalogRows;
  signature: string;
}

class TaskCatalogProjectionError extends Error {
  constructor(
    message: string,
    readonly reason: 'capacity' | 'invalid' = 'invalid',
  ) {
    super(message);
  }
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return [];
  return [...value];
}

function truncateDisplay(
  value: unknown,
  fallback: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const source = (typeof value === 'string' ? value : fallback)
    .replace(DISPLAY_CONTROL_PATTERN, ' ')
    .replace(UNPAIRED_SURROGATE_PATTERN, '\uFFFD')
    .trim();
  const normalized = source || fallback;
  if (encodedBytes(normalized) <= maxBytes) {
    return { text: normalized, truncated: false };
  }

  const suffix = '…';
  const suffixBytes = encodedBytes(suffix) - 2;
  let result = '';
  let resultBytes = 2;
  for (const character of normalized) {
    const characterBytes = encodedBytes(character) - 2;
    if (resultBytes + characterBytes + suffixBytes > maxBytes) break;
    result += character;
    resultBytes += characterBytes;
  }
  return { text: `${result}${suffix}`, truncated: true };
}

function fitStaticAgentRow(row: RemoteAgentChoice): RemoteAgentChoice {
  const result = { ...row };
  const fields = [
    ['displayName', 'displayNameTruncated'],
    ['providerLabel', 'providerLabelTruncated'],
    ['glyph', 'glyphTruncated'],
  ] as const;

  while (encodedBytes(result) > TASK_CATALOG_LIMITS.rowBytes['static-agent']) {
    const candidate = fields
      .map(([valueKey, truncatedKey]) => {
        const value = result[valueKey];
        return {
          bytes: value === null ? 0 : encodedBytes(value),
          truncatedKey,
          value,
          valueKey,
        };
      })
      .filter((candidate) => candidate.value !== null && candidate.bytes > encodedBytes('…'))
      .sort((left, right) => right.bytes - left.bytes)[0];
    if (!candidate || candidate.value === null) break;
    const overflow = encodedBytes(result) - TASK_CATALOG_LIMITS.rowBytes['static-agent'];
    const targetBytes = Math.max(encodedBytes('…'), candidate.bytes - overflow);
    const source = candidate.value.endsWith('…') ? candidate.value.slice(0, -1) : candidate.value;
    const fitted = truncateDisplay(source, '', targetBytes);
    result[candidate.valueKey] = fitted.text;
    result[candidate.truncatedKey] = true;
  }
  return result;
}

function taskLocation(
  task: Record<string, unknown>,
  projectMode: 'git' | 'non-git',
): RemoteTaskLocationKind {
  if (projectMode === 'non-git' || task.gitIsolation === 'current-branch') {
    return 'project-root';
  }
  return task.gitIsolation === 'existing-worktree' ? 'existing-worktree' : 'managed-worktree';
}

function taskOwnership(
  task: Record<string, unknown>,
  location: RemoteTaskLocationKind,
): RemoteTaskSummary['ownership'] {
  if (task.worktreeOwnership === 'external' || location === 'existing-worktree') return 'external';
  return location === 'project-root' ? 'shared' : 'managed';
}

function taskCreationStatus(task: Record<string, unknown>): RemoteTaskSummary['creationStatus'] {
  const value = task.creationStatus;
  return value === 'starting' || value === 'needs-attention' || value === 'failed'
    ? value
    : 'ready';
}

function projectMode(project: Record<string, unknown> | undefined): 'git' | 'non-git' {
  return project?.projectMode === 'non-git' ? 'non-git' : 'git';
}

function projectCapabilities(mode: 'git' | 'non-git'): RemoteProjectSummary['locations'] {
  const enabled = { enabled: true } as const;
  const unavailable = { enabled: false, reason: 'project-mode-unavailable' } as const;
  return mode === 'non-git'
    ? {
        'existing-worktree': unavailable,
        'managed-worktree': unavailable,
        'project-root': enabled,
      }
    : {
        'existing-worktree': enabled,
        'managed-worktree': enabled,
        'project-root': enabled,
      };
}

function assertUniqueIdentifiers(values: readonly string[], label: string): void {
  if (values.some((value) => !isTaskCatalogIdentifier(value))) {
    throw new TaskCatalogProjectionError(`${label} contains an invalid identifier`);
  }
  if (new Set(values).size !== values.length) {
    throw new TaskCatalogProjectionError(`${label} contains duplicate identifiers`);
  }
}

function assertSessionRuntimeFact(fact: TaskCatalogSessionRuntime): void {
  if (
    !isTaskCatalogIdentifier(fact.sessionId) ||
    !Number.isSafeInteger(fact.generation) ||
    fact.generation < 0 ||
    (fact.state !== 'running' &&
      fact.state !== 'stopped' &&
      fact.state !== 'failed' &&
      fact.state !== 'not-started')
  ) {
    throw new TaskCatalogProjectionError('Session runtime fact is invalid');
  }
}

function sessionStateById(
  facts: readonly TaskCatalogSessionRuntime[] | undefined,
): Map<string, TaskCatalogSessionRuntime> {
  const result = new Map<string, TaskCatalogSessionRuntime>();
  for (const fact of facts ?? []) {
    assertSessionRuntimeFact(fact);
    if (result.has(fact.sessionId)) {
      throw new TaskCatalogProjectionError('Session runtime facts contain a duplicate');
    }
    result.set(fact.sessionId, { ...fact });
  }
  return result;
}

function buildProjectRows(sharedState: Readonly<JsonObject>): {
  projectsById: Map<string, Record<string, unknown>>;
  rows: RemoteProjectSummary[];
} {
  if (!Array.isArray(sharedState.projects)) {
    throw new TaskCatalogProjectionError('Canonical projects are unavailable');
  }
  if (sharedState.projects.length > TASK_CATALOG_LIMITS.projectCount) {
    throw new TaskCatalogProjectionError('Project catalog capacity exceeded', 'capacity');
  }

  const rows: RemoteProjectSummary[] = [];
  const projectsById = new Map<string, Record<string, unknown>>();
  for (const value of sharedState.projects) {
    const project = readRecord(value);
    if (!project || !isTaskCatalogIdentifier(project.id) || projectsById.has(project.id)) {
      throw new TaskCatalogProjectionError('Canonical project identity is invalid');
    }
    projectsById.set(project.id, project);
    const label = truncateDisplay(project.name, 'Untitled project', 256);
    const mode = projectMode(project);
    const row: RemoteProjectSummary = {
      baseBranchChoiceCount:
        typeof project.baseBranch === 'string' && project.baseBranch.trim().length > 0 ? 1 : 0,
      baseBranchChoicesTruncated: false,
      id: project.id,
      label: label.text,
      labelTruncated: label.truncated,
      locations: projectCapabilities(mode),
      projectMode: mode,
      worktreeChoiceCount: 0,
      worktreeChoicesTruncated: false,
    };
    if (!isRemoteProjectSummary(row)) {
      throw new TaskCatalogProjectionError('Projected project row exceeds its public contract');
    }
    rows.push(row);
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  return { projectsById, rows };
}

function buildTaskAndSessionRows(
  sharedState: Readonly<JsonObject>,
  projectsById: ReadonlyMap<string, Record<string, unknown>>,
  runtimeBySessionId: ReadonlyMap<string, TaskCatalogSessionRuntime>,
  closingTaskIds: ReadonlySet<string>,
): { sessions: RemoteTaskSessionRef[]; tasks: RemoteTaskSummary[] } {
  const tasksRecord = readRecord(sharedState.tasks);
  if (!tasksRecord) throw new TaskCatalogProjectionError('Canonical tasks are unavailable');
  const taskIds = Object.keys(tasksRecord);
  if (taskIds.length > TASK_CATALOG_LIMITS.taskCount) {
    throw new TaskCatalogProjectionError('Task catalog capacity exceeded', 'capacity');
  }
  assertUniqueIdentifiers(taskIds, 'Canonical task map');

  const activeOrder = readStringArray(sharedState.taskOrder);
  const collapsedOrder = readStringArray(sharedState.collapsedTaskOrder);
  assertUniqueIdentifiers(activeOrder, 'Canonical active task order');
  assertUniqueIdentifiers(collapsedOrder, 'Canonical collapsed task order');
  const activeTaskIds = new Set(activeOrder);
  const collapsedTaskIds = new Set(collapsedOrder);
  if (activeOrder.some((taskId) => collapsedTaskIds.has(taskId))) {
    throw new TaskCatalogProjectionError('Canonical task orders overlap');
  }
  const orderedTaskIds = [
    ...activeOrder,
    ...collapsedOrder,
    ...taskIds
      .filter((taskId) => !activeTaskIds.has(taskId) && !collapsedTaskIds.has(taskId))
      .sort(),
  ];

  const sessions: RemoteTaskSessionRef[] = [];
  const tasks: RemoteTaskSummary[] = [];
  const seenSessionIds = new Set<string>();
  for (const taskId of orderedTaskIds) {
    const task = readRecord(tasksRecord[taskId]);
    const projectId = task?.projectId;
    if (!task || task.id !== taskId || !isTaskCatalogIdentifier(projectId)) {
      throw new TaskCatalogProjectionError('Canonical task record is invalid');
    }
    const project = projectsById.get(projectId);
    if (!project) throw new TaskCatalogProjectionError('Canonical task project is missing');
    const mode = resolvePersistedTaskMode(task.taskMode);
    if (!mode) {
      throw new TaskCatalogProjectionError(`Canonical task ${taskId} has an invalid task mode`);
    }
    const agentIds = readStringArray(task.agentIds);
    const shellIds = readStringArray(task.shellAgentIds);
    assertUniqueIdentifiers(agentIds, `Task ${taskId} agent sessions`);
    assertUniqueIdentifiers(shellIds, `Task ${taskId} shell sessions`);
    const shellIdSet = new Set(shellIds);
    if (agentIds.some((sessionId) => shellIdSet.has(sessionId))) {
      throw new TaskCatalogProjectionError(`Task ${taskId} session classes overlap`);
    }
    const sessionIds = [...agentIds, ...shellIds];
    const sessionIdSet = new Set(sessionIds);
    if (sessionIds.length > TASK_CATALOG_LIMITS.sessionsPerTask) {
      throw new TaskCatalogProjectionError(`Task ${taskId} session capacity exceeded`, 'capacity');
    }
    for (const sessionId of sessionIds) {
      if (seenSessionIds.has(sessionId)) {
        throw new TaskCatalogProjectionError('A session is attached to more than one task');
      }
      seenSessionIds.add(sessionId);
    }

    const addSessions = (ids: readonly string[], kind: RemoteTaskSessionRef['kind']) => {
      for (const [index, sessionId] of ids.entries()) {
        const runtime = runtimeBySessionId.get(sessionId);
        const row: RemoteTaskSessionRef = {
          ...(kind === 'agent' ? { agentId: sessionId } : {}),
          generation: runtime?.generation ?? 0,
          kind,
          orderKey: `${kind}-${String(index).padStart(4, '0')}`,
          sessionId,
          state: runtime?.state ?? 'stopped',
          taskId,
        };
        if (!isRemoteTaskSessionRef(row)) {
          throw new TaskCatalogProjectionError('Projected session row exceeds its public contract');
        }
        sessions.push(row);
      }
    };
    addSessions(agentIds, 'agent');
    addSessions(shellIds, 'shell');

    const location = taskLocation(task, projectMode(project));
    const name = truncateDisplay(task.name, 'Untitled task', 256);
    // Root tasks retain their creation identity, not a live observation of the shared checkout.
    const branch =
      location !== 'project-root' &&
      typeof task.branchName === 'string' &&
      task.branchName.trim().length > 0
        ? truncateDisplay(task.branchName, '', 96)
        : null;
    const selectedSessionId =
      typeof task.selectedAgentId === 'string' && sessionIdSet.has(task.selectedAgentId)
        ? task.selectedAgentId
        : mode === 'terminal'
          ? shellIds[0]
          : (agentIds[0] ?? shellIds[0]);
    const row: RemoteTaskSummary = {
      branchLabel: branch?.text ?? null,
      branchLabelTruncated: branch?.truncated ?? false,
      creationStatus: taskCreationStatus(task),
      lifecycle: closingTaskIds.has(taskId) ? 'closing' : 'active',
      location,
      name: name.text,
      nameTruncated: name.truncated,
      ownership: taskOwnership(task, location),
      ...(selectedSessionId ? { primarySessionId: selectedSessionId } : {}),
      projectId,
      sessionCount: sessionIds.length,
      taskId,
      taskMode: mode,
    };
    if (!isRemoteTaskSummary(row)) {
      throw new TaskCatalogProjectionError('Projected task row exceeds its public contract');
    }
    tasks.push(row);
  }
  if (sessions.length > TASK_CATALOG_LIMITS.sessionCount) {
    throw new TaskCatalogProjectionError('Session catalog capacity exceeded', 'capacity');
  }
  sessions.sort((left, right) =>
    left.taskId === right.taskId
      ? left.orderKey.localeCompare(right.orderKey) || left.sessionId.localeCompare(right.sessionId)
      : left.taskId.localeCompare(right.taskId),
  );
  tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return { sessions, tasks };
}

function buildStaticAgentRows(
  input: readonly RemoteAgentChoice[] | undefined,
): RemoteAgentChoice[] {
  if ((input?.length ?? 0) > TASK_CATALOG_LIMITS.agentCount) {
    throw new TaskCatalogProjectionError('Static agent catalog capacity exceeded', 'capacity');
  }
  const rows = (input ?? []).map((source) => {
    if (!isTaskCatalogIdentifier(source.agentDefId)) {
      throw new TaskCatalogProjectionError('Static agent catalog identity is invalid');
    }
    const displayName = truncateDisplay(source.displayName, 'Unknown agent', 160);
    const glyph = source.glyph === null ? null : truncateDisplay(source.glyph, '', 32);
    const providerLabel =
      source.providerLabel === null ? null : truncateDisplay(source.providerLabel, '', 96);
    const row = fitStaticAgentRow({
      agentDefId: source.agentDefId,
      displayName: displayName.text,
      displayNameTruncated: displayName.truncated,
      glyph: glyph?.text ?? null,
      glyphTruncated: glyph?.truncated ?? false,
      providerLabel: providerLabel?.text ?? null,
      providerLabelTruncated: providerLabel?.truncated ?? false,
      supportsInitialPrompt: source.supportsInitialPrompt === true,
      supportsPermissionBypass: source.supportsPermissionBypass === true,
    });
    if (!isRemoteAgentChoice(row)) {
      throw new TaskCatalogProjectionError(
        'Projected static agent row exceeds its public contract',
      );
    }
    return row;
  });
  assertUniqueIdentifiers(
    rows.map((row) => row.agentDefId),
    'Static agent catalog',
  );
  rows.sort((left, right) => left.agentDefId.localeCompare(right.agentDefId));
  return rows;
}

function projectCatalog(input: TaskCatalogProjectionInput): ProjectedCatalog {
  const closingTaskIds = new Set(input.closingTaskIds ?? []);
  assertUniqueIdentifiers([...closingTaskIds], 'Closing task projection');
  const runtime = sessionStateById(input.sessionRuntime);
  const projects = buildProjectRows(input.sharedState);
  const taskRows = buildTaskAndSessionRows(
    input.sharedState,
    projects.projectsById,
    runtime,
    closingTaskIds,
  );
  const rows: CatalogRows = {
    project: projects.rows,
    'static-agent': buildStaticAgentRows(input.staticAgents),
    task: taskRows.tasks,
    session: taskRows.sessions,
  };
  return { rows, signature: canonicalJsonStringify(rows as unknown as JsonObject) };
}

function cloneRows(rows: CatalogRows): CatalogRows {
  return structuredClone(rows);
}

function buildRowIndexes(rows: CatalogRows): CatalogRowIndexes {
  const indexes: CatalogRowIndexes = {
    project: new Map(),
    'static-agent': new Map(),
    task: new Map(),
    session: new Map(),
  };
  for (const kind of TASK_CATALOG_ENTITY_KINDS) {
    rows[kind].forEach((row, index) => {
      indexes[kind].set(getTaskCatalogEntityId(kind, row), index);
    });
  }
  return indexes;
}

function createDefaultSnapshotId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function nextVersion(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new TaskCatalogProjectionError('Task catalog version is exhausted');
  }
  return current + 1;
}

function rowMap<Kind extends TaskCatalogEntityKind>(
  kind: Kind,
  rows: readonly TaskCatalogEntityMap[Kind][],
): Map<string, TaskCatalogEntityMap[Kind]> {
  return new Map(rows.map((row) => [getTaskCatalogEntityId(kind, row), row]));
}

function diffRows(
  prior: CatalogRows,
  next: CatalogRows,
  serverInstanceId: string,
  catalogVersion: number,
): TaskCatalogEvent[] {
  const events: TaskCatalogEvent[] = [];
  for (const kind of TASK_CATALOG_ENTITY_KINDS) {
    const priorById = rowMap(kind, prior[kind]);
    const nextById = rowMap(kind, next[kind]);
    for (const [entityId, entity] of nextById) {
      const previous = priorById.get(entityId);
      if (
        previous &&
        canonicalJsonStringify(previous as unknown as JsonObject) ===
          canonicalJsonStringify(entity as unknown as JsonObject)
      ) {
        continue;
      }
      events.push({
        catalogVersion,
        entity,
        entityKind: kind,
        kind: 'replace',
        serverInstanceId,
      } as TaskCatalogEvent);
    }
    for (const entityId of priorById.keys()) {
      if (!nextById.has(entityId)) {
        events.push({
          catalogVersion,
          entityId,
          entityKind: kind,
          kind: 'remove',
          serverInstanceId,
        });
      }
    }
  }
  return events;
}

function parseCursor(
  cursor: string,
): { kind: TaskCatalogEntityKind; offset: number; snapshotId: string } | null {
  if (!isTaskCatalogCursor(cursor)) return null;
  const parts = cursor.split('~');
  if (parts.length !== 3) return null;
  const [snapshotId, kindValue, offsetValue] = parts;
  if (
    !snapshotId ||
    !isTaskCatalogIdentifier(snapshotId) ||
    !TASK_CATALOG_ENTITY_KINDS.includes(kindValue as TaskCatalogEntityKind) ||
    !offsetValue ||
    !/^[0-9a-z]+$/u.test(offsetValue)
  ) {
    return null;
  }
  const offset = Number.parseInt(offsetValue, 36);
  return Number.isSafeInteger(offset) && offset >= 0
    ? { kind: kindValue as TaskCatalogEntityKind, offset, snapshotId }
    : null;
}

function createCursor(snapshotId: string, kind: TaskCatalogEntityKind, offset: number): string {
  const cursor = `${snapshotId}~${kind}~${offset.toString(36)}`;
  if (!isTaskCatalogCursor(cursor)) throw new TaskCatalogProjectionError('Catalog cursor overflow');
  return cursor;
}

export class TaskCatalogState {
  private catalogVersion = 0;
  private closingTaskIds = new Set<string>();
  private deltaBytes = 0;
  private deltaEvents: TaskCatalogEvent[] = [];
  private lastError: unknown = null;
  private listeners = new Set<(batch: TaskCatalogDeltaBatch) => void>();
  private removedTaskIds = new Map<string, true>();
  private rows: CatalogRows = { project: [], 'static-agent': [], task: [], session: [] };
  private rowIndexes = buildRowIndexes(this.rows);
  private sessionRuntimeById = new Map<string, TaskCatalogSessionRuntime>();
  private signature: string | null = canonicalJsonStringify(this.rows as unknown as JsonObject);
  private snapshot: CatalogSnapshotLease | null = null;

  constructor(private readonly options: TaskCatalogStateOptions) {
    if (!isTaskCatalogIdentifier(options.serverInstanceId)) {
      throw new TypeError('Task catalog server instance ID is invalid');
    }
  }

  replace(input: TaskCatalogProjectionInput): TaskCatalogDeltaBatch {
    const nextClosingTaskIds =
      input.closingTaskIds === undefined
        ? new Set(this.closingTaskIds)
        : new Set(input.closingTaskIds);
    const nextSessionRuntime =
      input.sessionRuntime === undefined
        ? new Map(this.sessionRuntimeById)
        : sessionStateById(input.sessionRuntime);
    let projected: ProjectedCatalog;
    try {
      projected = projectCatalog({
        ...input,
        closingTaskIds: [...nextClosingTaskIds],
        sessionRuntime: [...nextSessionRuntime.values()],
      });
    } catch (error) {
      this.lastError = error;
      throw error;
    }
    this.lastError = null;
    this.retainProjectionOverlays(projected.rows, nextClosingTaskIds, nextSessionRuntime);
    this.expireSnapshot();
    if (projected.signature === this.signature) {
      return this.noChangeBatch();
    }

    const fromCatalogVersion = this.catalogVersion;
    const catalogVersion = nextVersion(this.catalogVersion);
    const events = diffRows(
      this.rows,
      projected.rows,
      this.options.serverInstanceId,
      catalogVersion,
    );
    if (events.length === 0) {
      this.rows = projected.rows;
      this.rowIndexes = buildRowIndexes(projected.rows);
      this.signature = projected.signature;
      return {
        events: [],
        fromCatalogVersion,
        serverInstanceId: this.options.serverInstanceId,
        toCatalogVersion: fromCatalogVersion,
      };
    }

    const nextTaskIds = new Set(projected.rows.task.map((task) => task.taskId));
    for (const task of this.rows.task) {
      if (!nextTaskIds.has(task.taskId)) this.rememberRemovedTask(task.taskId);
    }
    for (const taskId of nextTaskIds) this.removedTaskIds.delete(taskId);

    this.rows = projected.rows;
    this.rowIndexes = buildRowIndexes(projected.rows);
    this.signature = projected.signature;
    this.catalogVersion = catalogVersion;
    this.appendDeltas(events);
    this.publishBatch({
      events,
      fromCatalogVersion,
      serverInstanceId: this.options.serverInstanceId,
      toCatalogVersion: catalogVersion,
    });
    return {
      events: structuredClone(events),
      fromCatalogVersion,
      serverInstanceId: this.options.serverInstanceId,
      toCatalogVersion: catalogVersion,
    };
  }

  updateSessionRuntime(fact: TaskCatalogSessionRuntime): TaskCatalogDeltaBatch {
    assertSessionRuntimeFact(fact);
    const index = this.rowIndexes.session.get(fact.sessionId);
    if (index === undefined) return this.noChangeBatch();
    const current = this.rows.session[index];
    if (!current) throw new TaskCatalogProjectionError('Session catalog index is inconsistent');
    this.sessionRuntimeById.set(fact.sessionId, structuredClone(fact));
    if (current.generation === fact.generation && current.state === fact.state) {
      return this.noChangeBatch();
    }
    const next: RemoteTaskSessionRef = {
      ...current,
      generation: fact.generation,
      state: fact.state,
    };
    if (!isRemoteTaskSessionRef(next)) {
      throw new TaskCatalogProjectionError('Projected session runtime exceeds its public contract');
    }
    return this.publishPointReplacement('session', index, next);
  }

  setTaskClosing(taskId: string, closing: boolean): TaskCatalogDeltaBatch {
    if (!isTaskCatalogIdentifier(taskId)) {
      throw new TaskCatalogProjectionError('Closing task identity is invalid');
    }
    const index = this.rowIndexes.task.get(taskId);
    if (index === undefined) return this.noChangeBatch();
    const current = this.rows.task[index];
    if (!current) throw new TaskCatalogProjectionError('Task catalog index is inconsistent');
    const lifecycle = closing ? 'closing' : 'active';
    if (closing) this.closingTaskIds.add(taskId);
    else this.closingTaskIds.delete(taskId);
    if (current.lifecycle === lifecycle) return this.noChangeBatch();
    const next: RemoteTaskSummary = { ...current, lifecycle };
    if (!isRemoteTaskSummary(next)) {
      throw new TaskCatalogProjectionError('Projected task lifecycle exceeds its public contract');
    }
    return this.publishPointReplacement('task', index, next);
  }

  createManifest(): TaskCatalogFetchResult<TaskCatalogReplaceManifest> {
    if (this.lastError) {
      return {
        kind:
          this.lastError instanceof TaskCatalogProjectionError &&
          this.lastError.reason === 'capacity'
            ? 'catalog-capacity-exceeded'
            : 'unavailable',
      };
    }
    this.expireSnapshot();
    if (!this.snapshot) {
      const snapshotId = (this.options.createSnapshotId ?? createDefaultSnapshotId)();
      if (!isTaskCatalogIdentifier(snapshotId)) return { kind: 'unavailable' };
      this.snapshot = {
        catalogVersion: this.catalogVersion,
        expiresAt: this.readNow() + SNAPSHOT_TTL_MS,
        rows: cloneRows(this.rows),
        snapshotId,
      };
      this.deltaBytes = 0;
      this.deltaEvents = [];
    }
    const snapshot = this.snapshot;
    const manifest: TaskCatalogReplaceManifest = {
      catalogVersion: snapshot.catalogVersion,
      counts: {
        project: snapshot.rows.project.length,
        'static-agent': snapshot.rows['static-agent'].length,
        task: snapshot.rows.task.length,
        session: snapshot.rows.session.length,
      },
      mode: 'replace-paged',
      pageByteLimit: TASK_CATALOG_LIMITS.pageBytes,
      pageItemLimit: TASK_CATALOG_LIMITS.pageItems,
      serverInstanceId: this.options.serverInstanceId,
      snapshotId: snapshot.snapshotId,
    };
    return isTaskCatalogReplaceManifest(manifest)
      ? { kind: 'found', value: manifest }
      : { kind: 'unavailable' };
  }

  getPage(args: GetTaskCatalogPageRequest): TaskCatalogFetchResult<TaskCatalogPage> {
    this.expireSnapshot();
    const snapshot = this.snapshot;
    if (
      !snapshot ||
      args.serverInstanceId !== this.options.serverInstanceId ||
      args.catalogVersion !== snapshot.catalogVersion ||
      snapshot.snapshotId !== args.snapshotId ||
      !TASK_CATALOG_ENTITY_KINDS.includes(args.kind)
    ) {
      return { kind: 'catalog-snapshot-stale' };
    }
    let offset = 0;
    if (args.cursor) {
      const parsed = parseCursor(args.cursor);
      if (!parsed || parsed.snapshotId !== args.snapshotId || parsed.kind !== args.kind) {
        return { kind: 'catalog-snapshot-stale' };
      }
      offset = parsed.offset;
    }
    const rows = snapshot.rows[args.kind];
    if (offset > rows.length) return { kind: 'catalog-snapshot-stale' };
    let items = rows.slice(offset, offset + TASK_CATALOG_LIMITS.pageItems);
    let nextOffset = offset + items.length;
    let nextCursor =
      nextOffset < rows.length ? createCursor(snapshot.snapshotId, args.kind, nextOffset) : null;
    let page = {
      catalogVersion: snapshot.catalogVersion,
      items,
      kind: args.kind,
      nextCursor,
      serverInstanceId: this.options.serverInstanceId,
      snapshotId: snapshot.snapshotId,
    } as TaskCatalogPage;
    while (items.length > 0 && encodedBytes(page) > TASK_CATALOG_LIMITS.pageBytes) {
      items = items.slice(0, -1);
      nextOffset = offset + items.length;
      nextCursor = createCursor(snapshot.snapshotId, args.kind, nextOffset);
      page = { ...page, items, nextCursor } as TaskCatalogPage;
    }
    return isTaskCatalogPage(page) ? { kind: 'found', value: page } : { kind: 'unavailable' };
  }

  getDeltasSince(
    args: GetTaskCatalogDeltasSinceRequest,
  ): TaskCatalogFetchResult<TaskCatalogDeltaBatch> {
    this.expireSnapshot();
    const { catalogVersion } = args;
    if (
      args.serverInstanceId !== this.options.serverInstanceId ||
      !Number.isSafeInteger(catalogVersion) ||
      catalogVersion < 0 ||
      catalogVersion > this.catalogVersion
    ) {
      return { kind: 'catalog-snapshot-stale' };
    }
    if (catalogVersion === this.catalogVersion) {
      return {
        kind: 'found',
        value: {
          events: [],
          fromCatalogVersion: catalogVersion,
          serverInstanceId: this.options.serverInstanceId,
          toCatalogVersion: this.catalogVersion,
        },
      };
    }
    const events = this.deltaEvents.filter((event) => event.catalogVersion > catalogVersion);
    if (
      events.length === 0 ||
      Math.min(...events.map((event) => event.catalogVersion)) > catalogVersion + 1
    ) {
      return { kind: 'catalog-snapshot-stale' };
    }
    return {
      kind: 'found',
      value: {
        events: structuredClone(events),
        fromCatalogVersion: catalogVersion,
        serverInstanceId: this.options.serverInstanceId,
        toCatalogVersion: this.catalogVersion,
      },
    };
  }

  getCurrentTaskProjection(taskId: string): TaskRemovalCurrentProjection {
    const taskIndex = this.rowIndexes.task.get(taskId);
    const task = taskIndex === undefined ? undefined : this.rows.task[taskIndex];
    return {
      catalogVersion: this.catalogVersion,
      serverInstanceId: this.options.serverInstanceId,
      taskClosing: task?.lifecycle === 'closing',
      taskState: task ? 'present' : this.removedTaskIds.has(taskId) ? 'removed' : 'not-visible',
    };
  }

  /**
   * Point reads for backend workflow joins. These stay on the catalog owner so
   * creation/session workflows do not page the public transport projection or
   * maintain a second task index.
   */
  getCurrentTaskSummary(taskId: string): RemoteTaskSummary | null {
    const index = this.rowIndexes.task.get(taskId);
    const task = index === undefined ? undefined : this.rows.task[index];
    return task ? structuredClone(task) : null;
  }

  getCurrentSessionSummary(sessionId: string): RemoteTaskSessionRef | null {
    const index = this.rowIndexes.session.get(sessionId);
    const session = index === undefined ? undefined : this.rows.session[index];
    return session ? structuredClone(session) : null;
  }

  subscribe(listener: (batch: TaskCatalogDeltaBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private appendDeltas(events: readonly TaskCatalogEvent[]): void {
    if (!this.snapshot) return;
    for (const event of events) {
      this.deltaEvents.push(structuredClone(event));
      this.deltaBytes += encodedBytes(event);
    }
    if (
      this.deltaEvents.length > TASK_CATALOG_LIMITS.deltaEvents ||
      this.deltaBytes > TASK_CATALOG_LIMITS.deltaBytes
    ) {
      this.snapshot = null;
      this.deltaEvents = [];
      this.deltaBytes = 0;
    }
  }

  private retainProjectionOverlays(
    rows: CatalogRows,
    closingTaskIds: ReadonlySet<string>,
    sessionRuntime: ReadonlyMap<string, TaskCatalogSessionRuntime>,
  ): void {
    const taskIds = new Set(rows.task.map((task) => task.taskId));
    const sessionIds = new Set(rows.session.map((session) => session.sessionId));
    this.closingTaskIds = new Set([...closingTaskIds].filter((taskId) => taskIds.has(taskId)));
    this.sessionRuntimeById = new Map(
      [...sessionRuntime].filter(([sessionId]) => sessionIds.has(sessionId)),
    );
  }

  private noChangeBatch(): TaskCatalogDeltaBatch {
    return {
      events: [],
      fromCatalogVersion: this.catalogVersion,
      serverInstanceId: this.options.serverInstanceId,
      toCatalogVersion: this.catalogVersion,
    };
  }

  private publishPointReplacement<Kind extends 'session' | 'task'>(
    kind: Kind,
    index: number,
    entity: TaskCatalogEntityMap[Kind],
  ): TaskCatalogDeltaBatch {
    const fromCatalogVersion = this.catalogVersion;
    const catalogVersion = nextVersion(fromCatalogVersion);
    this.expireSnapshot();
    const event = {
      catalogVersion,
      entity,
      entityKind: kind,
      kind: 'replace',
      serverInstanceId: this.options.serverInstanceId,
    } as TaskCatalogEvent;
    const rows = this.rows[kind] as TaskCatalogEntityMap[Kind][];
    rows[index] = entity;
    this.catalogVersion = catalogVersion;
    this.signature = null;
    this.appendDeltas([event]);
    this.publishBatch({
      events: [event],
      fromCatalogVersion,
      serverInstanceId: this.options.serverInstanceId,
      toCatalogVersion: catalogVersion,
    });
    return {
      events: [structuredClone(event)],
      fromCatalogVersion,
      serverInstanceId: this.options.serverInstanceId,
      toCatalogVersion: catalogVersion,
    };
  }

  private publishBatch(batch: TaskCatalogDeltaBatch): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(batch));
      } catch {
        // Projection publication failures are repairable by manifest resync and never roll back truth.
      }
    }
  }

  private expireSnapshot(): void {
    if (this.snapshot && this.snapshot.expiresAt <= this.readNow()) {
      this.snapshot = null;
      this.deltaEvents = [];
      this.deltaBytes = 0;
    }
  }

  private readNow(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isFinite(now) || now < 0) {
      throw new TaskCatalogProjectionError('Task catalog clock is invalid');
    }
    return now;
  }

  private rememberRemovedTask(taskId: string): void {
    this.removedTaskIds.delete(taskId);
    this.removedTaskIds.set(taskId, true);
    while (this.removedTaskIds.size > MAX_REMOVED_TASK_TOMBSTONES) {
      const oldest = this.removedTaskIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removedTaskIds.delete(oldest);
    }
  }
}

export function createTaskCatalogState(options: TaskCatalogStateOptions): TaskCatalogState {
  return new TaskCatalogState(options);
}
