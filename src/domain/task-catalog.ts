import { isRecord } from '../lib/type-guards.js';
import { isWellFormedUnicodeScalarString } from '../lib/unicode-scalar.js';

export const TASK_CATALOG_ENTITY_KINDS = ['project', 'static-agent', 'task', 'session'] as const;

export type TaskCatalogEntityKind = (typeof TASK_CATALOG_ENTITY_KINDS)[number];
export type TaskCatalogTaskState = 'present' | 'removed' | 'not-visible';
export type RemoteTaskMode = 'agent' | 'terminal';
export type RemoteTaskLocationKind = 'managed-worktree' | 'project-root' | 'existing-worktree';
export type RemoteTaskLifecycle = 'active' | 'closing';

export const TASK_CATALOG_LIMITS = Object.freeze({
  agentCount: 256,
  deltaBytes: 4 * 1024 * 1024,
  deltaEvents: 4_096,
  manifestBytes: 1_024,
  pageBytes: 49_152,
  pageEnvelopeBytes: 1_024,
  pageItems: 50,
  projectCount: 1_024,
  rowBytes: Object.freeze({
    project: 768,
    'static-agent': 384,
    task: 768,
    session: 320,
  }),
  sessionCount: 20_000,
  sessionsPerTask: 64,
  taskCount: 10_000,
});

export type TaskCatalogCapabilityReason =
  | 'not-supported'
  | 'not-authorized'
  | 'project-mode-unavailable'
  | 'secure-transport-required'
  | 'backend-unavailable';

export type TaskCatalogCapability =
  | { enabled: true }
  | { enabled: false; reason: TaskCatalogCapabilityReason };

export interface RemoteProjectSummary {
  baseBranchChoiceCount: number;
  baseBranchChoicesTruncated: boolean;
  id: string;
  label: string;
  labelTruncated: boolean;
  locations: Record<RemoteTaskLocationKind, TaskCatalogCapability>;
  projectMode: 'git' | 'non-git';
  worktreeChoiceCount: number;
  worktreeChoicesTruncated: boolean;
}

export interface RemoteAgentChoice {
  agentDefId: string;
  displayName: string;
  displayNameTruncated: boolean;
  glyph: string | null;
  glyphTruncated: boolean;
  providerLabel: string | null;
  providerLabelTruncated: boolean;
  supportsInitialPrompt: boolean;
  supportsPermissionBypass: boolean;
}

export interface RemoteTaskSummary {
  branchLabel: string | null;
  branchLabelTruncated: boolean;
  creationStatus: 'ready' | 'starting' | 'needs-attention' | 'failed';
  lifecycle: RemoteTaskLifecycle;
  location: RemoteTaskLocationKind;
  name: string;
  nameTruncated: boolean;
  ownership: 'managed' | 'shared' | 'external';
  primarySessionId?: string;
  projectId: string;
  sessionCount: number;
  taskId: string;
  taskMode: RemoteTaskMode;
}

export interface RemoteTaskSessionRef {
  agentId?: string;
  generation: number;
  kind: 'agent' | 'shell';
  orderKey: string;
  sessionId: string;
  state: 'running' | 'stopped' | 'failed' | 'not-started';
  taskId: string;
}

export interface TaskCatalogReplaceManifest {
  catalogVersion: number;
  counts: Record<TaskCatalogEntityKind, number>;
  mode: 'replace-paged';
  pageByteLimit: 49_152;
  pageItemLimit: 50;
  serverInstanceId: string;
  snapshotId: string;
}

interface TaskCatalogPageBase {
  catalogVersion: number;
  nextCursor: string | null;
  serverInstanceId: string;
  snapshotId: string;
}

export type TaskCatalogPage =
  | (TaskCatalogPageBase & { items: RemoteProjectSummary[]; kind: 'project' })
  | (TaskCatalogPageBase & { items: RemoteAgentChoice[]; kind: 'static-agent' })
  | (TaskCatalogPageBase & { items: RemoteTaskSummary[]; kind: 'task' })
  | (TaskCatalogPageBase & { items: RemoteTaskSessionRef[]; kind: 'session' });

export type TaskCatalogEntityMap = {
  project: RemoteProjectSummary;
  'static-agent': RemoteAgentChoice;
  task: RemoteTaskSummary;
  session: RemoteTaskSessionRef;
};

export type TaskCatalogEntityReplacement = {
  [Kind in TaskCatalogEntityKind]: {
    catalogVersion: number;
    entity: TaskCatalogEntityMap[Kind];
    entityKind: Kind;
    kind: 'replace';
    serverInstanceId: string;
  };
}[TaskCatalogEntityKind];

export type TaskCatalogEntityTombstone = {
  catalogVersion: number;
  entityId: string;
  entityKind: TaskCatalogEntityKind;
  kind: 'remove';
  serverInstanceId: string;
};

export type TaskCatalogEvent = TaskCatalogEntityReplacement | TaskCatalogEntityTombstone;

export type TaskCatalogLiveMessage =
  | { batch: TaskCatalogDeltaBatch; kind: 'catalog-delta' }
  | { kind: 'connection-state'; state: 'connected' | 'disconnected' };

export interface TaskCatalogLiveEventSource {
  subscribe(listener: (message: unknown) => void): () => void;
}

export type TaskCatalogFetchResult<T> =
  | { kind: 'found'; value: T }
  | { kind: 'catalog-snapshot-stale' }
  | { kind: 'catalog-capacity-exceeded' }
  | { kind: 'unavailable' };

export interface GetTaskCatalogPageRequest {
  catalogVersion: number;
  cursor?: string;
  kind: TaskCatalogEntityKind;
  serverInstanceId: string;
  snapshotId: string;
}

export interface GetTaskCatalogDeltasSinceRequest {
  catalogVersion: number;
  serverInstanceId: string;
}

export interface TaskCatalogDeltaBatch {
  events: readonly TaskCatalogEvent[];
  fromCatalogVersion: number;
  serverInstanceId: string;
  toCatalogVersion: number;
}

/**
 * Narrow read boundary consumed by the remote catalog runtime. Live deltas
 * arrive through the state channel and are deliberately not hidden behind an
 * arbitrary channel-name dispatcher.
 */
export interface TaskCatalogClientFacade {
  getDeltasSince(
    request: GetTaskCatalogDeltasSinceRequest,
    signal?: AbortSignal,
  ): Promise<TaskCatalogFetchResult<TaskCatalogDeltaBatch>>;
  getManifest(signal?: AbortSignal): Promise<TaskCatalogFetchResult<TaskCatalogReplaceManifest>>;
  getPage(
    request: GetTaskCatalogPageRequest,
    signal?: AbortSignal,
  ): Promise<TaskCatalogFetchResult<TaskCatalogPage>>;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:@-]+$/u;
const SAFE_CURSOR = /^[A-Za-z0-9._~-]+$/u;
const DISPLAY_CONTROL = /\p{Cc}/u;

function encodedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function isTaskCatalogIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 64 &&
    SAFE_IDENTIFIER.test(value)
  );
}

export function isTaskCatalogCursor(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 64 && SAFE_CURSOR.test(value)
  );
}

function isBoundedDisplay(value: unknown, maxEncodedBytes: number): value is string {
  return (
    typeof value === 'string' &&
    !DISPLAY_CONTROL.test(value) &&
    isWellFormedUnicodeScalarString(value) &&
    encodedBytes(value) <= maxEncodedBytes
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTaskCatalogCapability(value: unknown): value is TaskCatalogCapability {
  if (!isRecord(value)) return false;
  if (value.enabled === true) return hasExactKeys(value, ['enabled']);
  return (
    value.enabled === false &&
    hasExactKeys(value, ['enabled', 'reason']) &&
    (value.reason === 'not-supported' ||
      value.reason === 'not-authorized' ||
      value.reason === 'project-mode-unavailable' ||
      value.reason === 'secure-transport-required' ||
      value.reason === 'backend-unavailable')
  );
}

function isLocationCapabilities(
  value: unknown,
): value is Record<RemoteTaskLocationKind, TaskCatalogCapability> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['managed-worktree', 'project-root', 'existing-worktree']) &&
    isTaskCatalogCapability(value['managed-worktree']) &&
    isTaskCatalogCapability(value['project-root']) &&
    isTaskCatalogCapability(value['existing-worktree'])
  );
}

export function isRemoteProjectSummary(value: unknown): value is RemoteProjectSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'baseBranchChoiceCount',
      'baseBranchChoicesTruncated',
      'id',
      'label',
      'labelTruncated',
      'locations',
      'projectMode',
      'worktreeChoiceCount',
      'worktreeChoicesTruncated',
    ]) &&
    isTaskCatalogIdentifier(value.id) &&
    isBoundedDisplay(value.label, 256) &&
    typeof value.labelTruncated === 'boolean' &&
    (value.projectMode === 'git' || value.projectMode === 'non-git') &&
    isLocationCapabilities(value.locations) &&
    isNonNegativeSafeInteger(value.baseBranchChoiceCount) &&
    typeof value.baseBranchChoicesTruncated === 'boolean' &&
    isNonNegativeSafeInteger(value.worktreeChoiceCount) &&
    typeof value.worktreeChoicesTruncated === 'boolean' &&
    encodedBytes(value) <= TASK_CATALOG_LIMITS.rowBytes.project
  );
}

export function isRemoteAgentChoice(value: unknown): value is RemoteAgentChoice {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'agentDefId',
      'displayName',
      'displayNameTruncated',
      'glyph',
      'glyphTruncated',
      'providerLabel',
      'providerLabelTruncated',
      'supportsInitialPrompt',
      'supportsPermissionBypass',
    ]) &&
    isTaskCatalogIdentifier(value.agentDefId) &&
    isBoundedDisplay(value.displayName, 160) &&
    typeof value.displayNameTruncated === 'boolean' &&
    (value.glyph === null || isBoundedDisplay(value.glyph, 32)) &&
    typeof value.glyphTruncated === 'boolean' &&
    (value.providerLabel === null || isBoundedDisplay(value.providerLabel, 96)) &&
    typeof value.providerLabelTruncated === 'boolean' &&
    typeof value.supportsInitialPrompt === 'boolean' &&
    typeof value.supportsPermissionBypass === 'boolean' &&
    encodedBytes(value) <= TASK_CATALOG_LIMITS.rowBytes['static-agent']
  );
}

export function isRemoteTaskSummary(value: unknown): value is RemoteTaskSummary {
  if (!isRecord(value)) return false;
  const allowed = [
    'branchLabel',
    'branchLabelTruncated',
    'creationStatus',
    'lifecycle',
    'location',
    'name',
    'nameTruncated',
    'ownership',
    'primarySessionId',
    'projectId',
    'sessionCount',
    'taskId',
    'taskMode',
  ] as const;
  const required = allowed.filter((key) => key !== 'primarySessionId');
  return (
    hasOnlyKeys(value, allowed) &&
    required.every((key) => key in value) &&
    isTaskCatalogIdentifier(value.taskId) &&
    isTaskCatalogIdentifier(value.projectId) &&
    isBoundedDisplay(value.name, 256) &&
    typeof value.nameTruncated === 'boolean' &&
    (value.branchLabel === null || isBoundedDisplay(value.branchLabel, 96)) &&
    typeof value.branchLabelTruncated === 'boolean' &&
    (value.taskMode === 'agent' || value.taskMode === 'terminal') &&
    (value.location === 'managed-worktree' ||
      value.location === 'project-root' ||
      value.location === 'existing-worktree') &&
    (value.ownership === 'managed' ||
      value.ownership === 'shared' ||
      value.ownership === 'external') &&
    (value.lifecycle === 'active' || value.lifecycle === 'closing') &&
    (value.creationStatus === 'ready' ||
      value.creationStatus === 'starting' ||
      value.creationStatus === 'needs-attention' ||
      value.creationStatus === 'failed') &&
    isNonNegativeSafeInteger(value.sessionCount) &&
    value.sessionCount <= TASK_CATALOG_LIMITS.sessionsPerTask &&
    (value.primarySessionId === undefined || isTaskCatalogIdentifier(value.primarySessionId)) &&
    (value.sessionCount > 0 || value.primarySessionId === undefined) &&
    encodedBytes(value) <= TASK_CATALOG_LIMITS.rowBytes.task
  );
}

export function isRemoteTaskSessionRef(value: unknown): value is RemoteTaskSessionRef {
  if (!isRecord(value)) return false;
  const allowed = [
    'agentId',
    'generation',
    'kind',
    'orderKey',
    'sessionId',
    'state',
    'taskId',
  ] as const;
  const required = allowed.filter((key) => key !== 'agentId');
  return (
    hasOnlyKeys(value, allowed) &&
    required.every((key) => key in value) &&
    isTaskCatalogIdentifier(value.taskId) &&
    isTaskCatalogIdentifier(value.sessionId) &&
    (value.agentId === undefined || isTaskCatalogIdentifier(value.agentId)) &&
    (value.kind === 'agent' || value.kind === 'shell') &&
    isTaskCatalogIdentifier(value.orderKey) &&
    isNonNegativeSafeInteger(value.generation) &&
    (value.state === 'running' ||
      value.state === 'stopped' ||
      value.state === 'failed' ||
      value.state === 'not-started') &&
    encodedBytes(value) <= TASK_CATALOG_LIMITS.rowBytes.session
  );
}

function isTaskCatalogCounts(value: unknown): value is Record<TaskCatalogEntityKind, number> {
  return (
    isRecord(value) &&
    hasExactKeys(value, TASK_CATALOG_ENTITY_KINDS) &&
    isNonNegativeSafeInteger(value.project) &&
    value.project <= TASK_CATALOG_LIMITS.projectCount &&
    isNonNegativeSafeInteger(value['static-agent']) &&
    value['static-agent'] <= TASK_CATALOG_LIMITS.agentCount &&
    isNonNegativeSafeInteger(value.task) &&
    value.task <= TASK_CATALOG_LIMITS.taskCount &&
    isNonNegativeSafeInteger(value.session) &&
    value.session <= TASK_CATALOG_LIMITS.sessionCount
  );
}

export function isTaskCatalogReplaceManifest(value: unknown): value is TaskCatalogReplaceManifest {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'catalogVersion',
      'counts',
      'mode',
      'pageByteLimit',
      'pageItemLimit',
      'serverInstanceId',
      'snapshotId',
    ]) &&
    value.mode === 'replace-paged' &&
    isTaskCatalogIdentifier(value.serverInstanceId) &&
    isNonNegativeSafeInteger(value.catalogVersion) &&
    isTaskCatalogIdentifier(value.snapshotId) &&
    isTaskCatalogCounts(value.counts) &&
    value.pageItemLimit === TASK_CATALOG_LIMITS.pageItems &&
    value.pageByteLimit === TASK_CATALOG_LIMITS.pageBytes &&
    encodedBytes(value) <= TASK_CATALOG_LIMITS.manifestBytes
  );
}

function isTaskCatalogPageItems(
  kind: TaskCatalogEntityKind,
  items: unknown[],
): items is TaskCatalogEntityMap[typeof kind][] {
  switch (kind) {
    case 'project':
      return items.every(isRemoteProjectSummary);
    case 'static-agent':
      return items.every(isRemoteAgentChoice);
    case 'task':
      return items.every(isRemoteTaskSummary);
    case 'session':
      return items.every(isRemoteTaskSessionRef);
  }
}

export function isTaskCatalogPage(value: unknown): value is TaskCatalogPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'catalogVersion',
      'items',
      'kind',
      'nextCursor',
      'serverInstanceId',
      'snapshotId',
    ]) ||
    !TASK_CATALOG_ENTITY_KINDS.includes(value.kind as TaskCatalogEntityKind) ||
    !isTaskCatalogIdentifier(value.serverInstanceId) ||
    !isNonNegativeSafeInteger(value.catalogVersion) ||
    !isTaskCatalogIdentifier(value.snapshotId) ||
    !Array.isArray(value.items) ||
    value.items.length > TASK_CATALOG_LIMITS.pageItems ||
    !(value.nextCursor === null || isTaskCatalogCursor(value.nextCursor))
  ) {
    return false;
  }

  const kind = value.kind as TaskCatalogEntityKind;
  return (
    isTaskCatalogPageItems(kind, value.items) &&
    encodedBytes({ ...value, items: [] }) <= TASK_CATALOG_LIMITS.pageEnvelopeBytes &&
    encodedBytes(value) <= TASK_CATALOG_LIMITS.pageBytes
  );
}

export function getTaskCatalogEntityId(
  kind: TaskCatalogEntityKind,
  entity: TaskCatalogEntityMap[TaskCatalogEntityKind],
): string {
  switch (kind) {
    case 'project':
      return (entity as RemoteProjectSummary).id;
    case 'static-agent':
      return (entity as RemoteAgentChoice).agentDefId;
    case 'task':
      return (entity as RemoteTaskSummary).taskId;
    case 'session':
      return (entity as RemoteTaskSessionRef).sessionId;
  }
}

export function isTaskCatalogEvent(value: unknown): value is TaskCatalogEvent {
  if (
    !isRecord(value) ||
    !isTaskCatalogIdentifier(value.serverInstanceId) ||
    !isNonNegativeSafeInteger(value.catalogVersion) ||
    !TASK_CATALOG_ENTITY_KINDS.includes(value.entityKind as TaskCatalogEntityKind)
  ) {
    return false;
  }

  if (value.kind === 'remove') {
    return (
      hasExactKeys(value, [
        'catalogVersion',
        'entityId',
        'entityKind',
        'kind',
        'serverInstanceId',
      ]) && isTaskCatalogIdentifier(value.entityId)
    );
  }
  if (value.kind !== 'replace' || !('entity' in value)) return false;
  if (
    !hasExactKeys(value, ['catalogVersion', 'entity', 'entityKind', 'kind', 'serverInstanceId'])
  ) {
    return false;
  }

  switch (value.entityKind) {
    case 'project':
      return isRemoteProjectSummary(value.entity);
    case 'static-agent':
      return isRemoteAgentChoice(value.entity);
    case 'task':
      return isRemoteTaskSummary(value.entity);
    case 'session':
      return isRemoteTaskSessionRef(value.entity);
    default:
      return false;
  }
}

export function isTaskCatalogLiveMessage(value: unknown): value is TaskCatalogLiveMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'connection-state') {
    return (
      hasExactKeys(value, ['kind', 'state']) &&
      (value.state === 'connected' || value.state === 'disconnected')
    );
  }
  return (
    value.kind === 'catalog-delta' &&
    hasExactKeys(value, ['batch', 'kind']) &&
    isTaskCatalogDeltaBatch(value.batch)
  );
}

export function isTaskCatalogDeltaBatch(value: unknown): value is TaskCatalogDeltaBatch {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'events',
      'fromCatalogVersion',
      'serverInstanceId',
      'toCatalogVersion',
    ]) ||
    !isTaskCatalogIdentifier(value.serverInstanceId) ||
    !isNonNegativeSafeInteger(value.fromCatalogVersion) ||
    !isNonNegativeSafeInteger(value.toCatalogVersion) ||
    value.fromCatalogVersion > value.toCatalogVersion ||
    !Array.isArray(value.events) ||
    value.events.length > TASK_CATALOG_LIMITS.deltaEvents ||
    !value.events.every(isTaskCatalogEvent) ||
    value.events.reduce((total, event) => total + encodedBytes(event), 0) >
      TASK_CATALOG_LIMITS.deltaBytes
  ) {
    return false;
  }

  if (value.events.length === 0) {
    return value.fromCatalogVersion === value.toCatalogVersion;
  }

  const versions = new Set<number>();
  const entityKeys = new Set<string>();
  let previousVersion = value.fromCatalogVersion;
  for (const event of value.events) {
    if (
      event.serverInstanceId !== value.serverInstanceId ||
      event.catalogVersion < previousVersion ||
      event.catalogVersion <= value.fromCatalogVersion ||
      event.catalogVersion > value.toCatalogVersion
    ) {
      return false;
    }
    previousVersion = event.catalogVersion;
    versions.add(event.catalogVersion);
    const entityId =
      event.kind === 'remove'
        ? event.entityId
        : getTaskCatalogEntityId(event.entityKind, event.entity);
    const entityKey = `${event.catalogVersion}\u0000${event.entityKind}\u0000${entityId}`;
    if (entityKeys.has(entityKey)) return false;
    entityKeys.add(entityKey);
  }

  for (
    let expectedVersion = value.fromCatalogVersion + 1;
    expectedVersion <= value.toCatalogVersion;
    expectedVersion += 1
  ) {
    if (!versions.has(expectedVersion)) return false;
  }
  return true;
}

export function isTaskCatalogFetchResult<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): value is TaskCatalogFetchResult<T> {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'found') {
    return hasExactKeys(value, ['kind', 'value']) && guard(value.value);
  }
  return (
    hasExactKeys(value, ['kind']) &&
    (value.kind === 'catalog-snapshot-stale' ||
      value.kind === 'catalog-capacity-exceeded' ||
      value.kind === 'unavailable')
  );
}

/**
 * Safe, transport-neutral task-removal view. Private deletion identities,
 * cleanup evidence, and repair phases deliberately never cross this boundary.
 */
export interface TaskRemovalCurrentProjection {
  catalogVersion: number;
  serverInstanceId: string;
  taskClosing: boolean;
  taskState: TaskCatalogTaskState;
}

export function isTaskRemovalCurrentProjection(
  value: unknown,
): value is TaskRemovalCurrentProjection {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ['catalogVersion', 'serverInstanceId', 'taskClosing', 'taskState']) &&
    isTaskCatalogIdentifier(value.serverInstanceId) &&
    isNonNegativeSafeInteger(value.catalogVersion) &&
    (value.taskState === 'present' ||
      value.taskState === 'removed' ||
      value.taskState === 'not-visible') &&
    typeof value.taskClosing === 'boolean' &&
    (value.taskState === 'present' || value.taskClosing === false)
  );
}

/**
 * Catalog cursors are ordered only within one backend instance. A restart
 * establishes a new baseline regardless of its numeric version.
 */
export function reduceTaskRemovalCurrentProjection(
  current: TaskRemovalCurrentProjection | null,
  incoming: TaskRemovalCurrentProjection,
): TaskRemovalCurrentProjection {
  if (!isTaskRemovalCurrentProjection(incoming)) {
    throw new Error('Invalid task-removal current projection');
  }
  if (
    current &&
    current.serverInstanceId === incoming.serverInstanceId &&
    current.catalogVersion > incoming.catalogVersion
  ) {
    return current;
  }
  return incoming;
}

export function canDispatchToTask(current: TaskRemovalCurrentProjection): boolean {
  return current.taskState === 'present' && !current.taskClosing;
}
