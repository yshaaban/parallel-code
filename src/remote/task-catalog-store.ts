import {
  TASK_CATALOG_ENTITY_KINDS,
  TASK_CATALOG_LIMITS,
  getTaskCatalogEntityId,
  isTaskCatalogDeltaBatch,
  isTaskCatalogLiveMessage,
  isTaskCatalogPage,
  isTaskCatalogReplaceManifest,
  type GetTaskCatalogPageRequest,
  type RemoteAgentChoice,
  type RemoteProjectSummary,
  type RemoteTaskSessionRef,
  type RemoteTaskSummary,
  type TaskCatalogClientFacade,
  type TaskCatalogDeltaBatch,
  type TaskCatalogEntityKind,
  type TaskCatalogEvent,
  type TaskCatalogLiveEventSource,
  type TaskCatalogPage,
  type TaskCatalogReplaceManifest,
} from '../domain/task-catalog';

const MAX_BUFFERED_DELTA_COUNT = 4_096;
const MAX_BUFFERED_DELTA_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

function runBestEffortCleanup(cleanup: (() => void) | null): void {
  try {
    cleanup?.();
  } catch {
    // A live transport cleanup failure must not derail replacement or runtime disposal.
  }
}

export type TaskCatalogStaleReason =
  | 'capacity-exceeded'
  | 'count-mismatch'
  | 'cursor-loop'
  | 'delta-gap'
  | 'delta-overflow'
  | 'duplicate-row'
  | 'invalid-manifest'
  | 'invalid-page'
  | 'referential-integrity'
  | 'server-restarted'
  | 'snapshot-stale'
  | 'transport-unavailable';

export type TaskCatalogLoadStatus =
  | 'empty'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'reconnecting'
  | 'stale'
  | 'unavailable'
  | 'capacity-exceeded';

export interface TaskCatalogProjection {
  readonly agents: ReadonlyMap<string, RemoteAgentChoice>;
  readonly catalogVersion: number;
  readonly projects: ReadonlyMap<string, RemoteProjectSummary>;
  readonly serverInstanceId: string;
  readonly sessions: ReadonlyMap<string, RemoteTaskSessionRef>;
  readonly sessionsByTask: ReadonlyMap<string, readonly RemoteTaskSessionRef[]>;
  readonly tasks: ReadonlyMap<string, RemoteTaskSummary>;
}

export interface TaskCatalogStoreSnapshot {
  readonly projection: TaskCatalogProjection | null;
  readonly revision: number;
  readonly staleReason: TaskCatalogStaleReason | null;
  readonly status: TaskCatalogLoadStatus;
}

type MutableCatalogProjection = {
  agents: Map<string, RemoteAgentChoice>;
  catalogVersion: number;
  projects: Map<string, RemoteProjectSummary>;
  serverInstanceId: string;
  sessions: Map<string, RemoteTaskSessionRef>;
  sessionsByTask: Map<string, RemoteTaskSessionRef[]>;
  tasks: Map<string, RemoteTaskSummary>;
};

interface StagingKindState {
  complete: boolean;
  nextCursor: string | null | undefined;
  pageCount: number;
  seenCursors: Set<string>;
}

interface TaskCatalogStaging {
  bufferedDeltaBytes: number;
  bufferedDeltaFingerprints: Map<string, string>;
  bufferedDeltaCount: number;
  bufferedDeltas: TaskCatalogDeltaBatch[];
  kinds: Record<TaskCatalogEntityKind, StagingKindState>;
  manifest: TaskCatalogReplaceManifest;
  projection: MutableCatalogProjection;
}

export type BeginTaskCatalogManifestResult = 'current' | 'staged' | 'stale';
export type StageTaskCatalogPageResult = 'accepted' | 'published' | 'stale';
export type ApplyTaskCatalogDeltaResult = 'applied' | 'buffered' | 'ignored' | 'stale';

function encodedBytes(value: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function createEmptyProjection(manifest: TaskCatalogReplaceManifest): MutableCatalogProjection {
  return {
    agents: new Map(),
    catalogVersion: manifest.catalogVersion,
    projects: new Map(),
    serverInstanceId: manifest.serverInstanceId,
    sessions: new Map(),
    sessionsByTask: new Map(),
    tasks: new Map(),
  };
}

function cloneProjection(projection: MutableCatalogProjection): MutableCatalogProjection {
  return {
    agents: new Map(projection.agents),
    catalogVersion: projection.catalogVersion,
    projects: new Map(projection.projects),
    serverInstanceId: projection.serverInstanceId,
    sessions: new Map(projection.sessions),
    sessionsByTask: new Map(projection.sessionsByTask),
    tasks: new Map(projection.tasks),
  };
}

function createKindStates(): Record<TaskCatalogEntityKind, StagingKindState> {
  return {
    project: createKindState(),
    'static-agent': createKindState(),
    task: createKindState(),
    session: createKindState(),
  };
}

function createKindState(): StagingKindState {
  return {
    complete: false,
    nextCursor: undefined,
    pageCount: 0,
    seenCursors: new Set(),
  };
}

function getEntityMap(
  projection: MutableCatalogProjection,
  kind: TaskCatalogEntityKind,
): Map<
  string,
  RemoteProjectSummary | RemoteAgentChoice | RemoteTaskSummary | RemoteTaskSessionRef
> {
  switch (kind) {
    case 'project':
      return projection.projects;
    case 'static-agent':
      return projection.agents;
    case 'task':
      return projection.tasks;
    case 'session':
      return projection.sessions;
  }
}

function addSessionIndex(
  sessionsByTask: Map<string, RemoteTaskSessionRef[]>,
  session: RemoteTaskSessionRef,
): boolean {
  const taskSessions = sessionsByTask.get(session.taskId) ?? [];
  if (taskSessions.length >= TASK_CATALOG_LIMITS.sessionsPerTask) return false;
  sessionsByTask.set(session.taskId, [...taskSessions, session]);
  return true;
}

function addSessionIndexUnchecked(
  sessionsByTask: Map<string, RemoteTaskSessionRef[]>,
  session: RemoteTaskSessionRef,
): void {
  sessionsByTask.set(session.taskId, [...(sessionsByTask.get(session.taskId) ?? []), session]);
}

function removeSessionIndex(
  sessionsByTask: Map<string, RemoteTaskSessionRef[]>,
  session: RemoteTaskSessionRef,
): void {
  const taskSessions = sessionsByTask.get(session.taskId);
  if (!taskSessions) return;
  const next = taskSessions.filter((entry) => entry.sessionId !== session.sessionId);
  if (next.length === 0) {
    sessionsByTask.delete(session.taskId);
  } else {
    sessionsByTask.set(session.taskId, next);
  }
}

function sortSessionIndexes(projection: MutableCatalogProjection): void {
  for (const sessions of projection.sessionsByTask.values()) {
    sessions.sort(
      (left, right) =>
        left.orderKey.localeCompare(right.orderKey) ||
        left.sessionId.localeCompare(right.sessionId),
    );
  }
}

function sortSessionIndex(
  sessionsByTask: Map<string, RemoteTaskSessionRef[]>,
  taskId: string,
): void {
  const sessions = sessionsByTask.get(taskId);
  if (!sessions) return;
  sessions.sort(
    (left, right) =>
      left.orderKey.localeCompare(right.orderKey) || left.sessionId.localeCompare(right.sessionId),
  );
}

type ProjectionValidationFailure = 'capacity-exceeded' | 'referential-integrity';

function validateCompleteProjection(
  projection: MutableCatalogProjection,
): ProjectionValidationFailure | null {
  if (
    projection.projects.size > TASK_CATALOG_LIMITS.projectCount ||
    projection.agents.size > TASK_CATALOG_LIMITS.agentCount ||
    projection.tasks.size > TASK_CATALOG_LIMITS.taskCount ||
    projection.sessions.size > TASK_CATALOG_LIMITS.sessionCount
  ) {
    return 'capacity-exceeded';
  }

  for (const task of projection.tasks.values()) {
    if (!projection.projects.has(task.projectId)) return 'referential-integrity';
    const taskSessions = projection.sessionsByTask.get(task.taskId) ?? [];
    if (taskSessions.length !== task.sessionCount) return 'referential-integrity';
    if (
      task.primarySessionId !== undefined &&
      !taskSessions.some((session) => session.sessionId === task.primarySessionId)
    ) {
      return 'referential-integrity';
    }
  }

  for (const [taskId, sessions] of projection.sessionsByTask) {
    if (!projection.tasks.has(taskId) || sessions.length > TASK_CATALOG_LIMITS.sessionsPerTask) {
      return sessions.length > TASK_CATALOG_LIMITS.sessionsPerTask
        ? 'capacity-exceeded'
        : 'referential-integrity';
    }
  }
  return null;
}

function matchesPageRequest(page: TaskCatalogPage, request: GetTaskCatalogPageRequest): boolean {
  return (
    page.serverInstanceId === request.serverInstanceId &&
    page.catalogVersion === request.catalogVersion &&
    page.snapshotId === request.snapshotId &&
    page.kind === request.kind
  );
}

function getEventEntityId(event: TaskCatalogEvent): string {
  return event.kind === 'remove'
    ? event.entityId
    : getTaskCatalogEntityId(event.entityKind, event.entity);
}

function getBatchKey(batch: TaskCatalogDeltaBatch): string {
  return `${batch.fromCatalogVersion}\u0000${batch.toCatalogVersion}`;
}

function getBatchEventBytes(batch: TaskCatalogDeltaBatch): number {
  return batch.events.reduce((total, event) => total + encodedBytes(event), 0);
}

/**
 * Single owner for remote catalog replacement and incremental replay. Maps are
 * mutated only inside this class; consumers receive readonly views plus a
 * monotonically increasing revision for reactive invalidation.
 */
export class TaskCatalogStore {
  private listeners = new Set<(snapshot: TaskCatalogStoreSnapshot) => void>();
  private revision = 0;
  private staging: TaskCatalogStaging | null = null;
  private staleReason: TaskCatalogStaleReason | null = null;
  private status: TaskCatalogLoadStatus = 'empty';
  private visible: MutableCatalogProjection | null = null;

  getSnapshot(): TaskCatalogStoreSnapshot {
    return {
      projection: this.visible,
      revision: this.revision,
      staleReason: this.staleReason,
      status: this.status,
    };
  }

  getDeltaResumeVersion(): number | null {
    return this.visible?.catalogVersion ?? null;
  }

  subscribe(listener: (snapshot: TaskCatalogStoreSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  beginManifest(value: unknown): BeginTaskCatalogManifestResult {
    if (!isTaskCatalogReplaceManifest(value)) {
      this.markStale('invalid-manifest');
      return 'stale';
    }

    if (
      this.visible?.serverInstanceId === value.serverInstanceId &&
      this.visible.catalogVersion === value.catalogVersion
    ) {
      this.staging = null;
      this.status = 'ready';
      this.staleReason = null;
      this.notify();
      return 'current';
    }

    if (
      this.visible?.serverInstanceId === value.serverInstanceId &&
      this.visible.catalogVersion > value.catalogVersion
    ) {
      this.markStale('snapshot-stale');
      return 'stale';
    }

    this.staging = {
      bufferedDeltaBytes: 0,
      bufferedDeltaCount: 0,
      bufferedDeltaFingerprints: new Map(),
      bufferedDeltas: [],
      kinds: createKindStates(),
      manifest: value,
      projection: createEmptyProjection(value),
    };
    this.status = this.visible ? 'refreshing' : 'loading';
    this.staleReason = null;
    this.notify();
    return 'staged';
  }

  stagePage(value: unknown, request: GetTaskCatalogPageRequest): StageTaskCatalogPageResult {
    const staging = this.staging;
    if (
      !staging ||
      !isTaskCatalogPage(value) ||
      !matchesPageRequest(value, request) ||
      request.cursor !== staging.kinds[request.kind].nextCursor
    ) {
      this.markStale('invalid-page');
      return 'stale';
    }

    const kindState = staging.kinds[value.kind];
    if (kindState.complete) {
      this.markStale('invalid-page');
      return 'stale';
    }
    if (request.cursor !== undefined) {
      if (kindState.seenCursors.has(request.cursor)) {
        this.markStale('cursor-loop');
        return 'stale';
      }
      kindState.seenCursors.add(request.cursor);
    }
    if (
      value.nextCursor !== null &&
      (value.items.length !== TASK_CATALOG_LIMITS.pageItems ||
        kindState.seenCursors.has(value.nextCursor))
    ) {
      this.markStale('cursor-loop');
      return 'stale';
    }

    const maxPages = Math.max(1, Math.ceil(staging.manifest.counts[value.kind] / 50));
    kindState.pageCount += 1;
    if (kindState.pageCount > maxPages) {
      this.markStale('count-mismatch');
      return 'stale';
    }

    const target = getEntityMap(staging.projection, value.kind);
    for (const entity of value.items) {
      const entityId = getTaskCatalogEntityId(value.kind, entity);
      if (target.has(entityId)) {
        this.markStale('duplicate-row');
        return 'stale';
      }
      target.set(entityId, entity);
      if (value.kind === 'session') {
        if (!addSessionIndex(staging.projection.sessionsByTask, entity as RemoteTaskSessionRef)) {
          this.markStale('capacity-exceeded');
          return 'stale';
        }
      }
    }

    if (target.size > staging.manifest.counts[value.kind]) {
      this.markStale('count-mismatch');
      return 'stale';
    }

    kindState.nextCursor = value.nextCursor;
    kindState.complete = value.nextCursor === null;
    if (kindState.complete && target.size !== staging.manifest.counts[value.kind]) {
      this.markStale('count-mismatch');
      return 'stale';
    }

    if (!TASK_CATALOG_ENTITY_KINDS.every((kind) => staging.kinds[kind].complete)) {
      return 'accepted';
    }
    return this.publishStaging();
  }

  applyDeltaBatch(value: unknown): ApplyTaskCatalogDeltaResult {
    if (!isTaskCatalogDeltaBatch(value)) {
      this.markStale('delta-gap');
      return 'stale';
    }

    if (this.staging) return this.bufferDeltaBatch(value);
    const visible = this.visible;
    if (!visible) {
      this.markStale('delta-gap');
      return 'stale';
    }
    if (value.serverInstanceId !== visible.serverInstanceId) {
      this.markStale('server-restarted');
      return 'stale';
    }
    if (value.toCatalogVersion < visible.catalogVersion) return 'ignored';
    if (value.toCatalogVersion === visible.catalogVersion) {
      if (value.events.length !== 0 && value.fromCatalogVersion === visible.catalogVersion) {
        this.markStale('delta-gap');
        return 'stale';
      }
      if (value.events.length === 0) {
        this.status = 'ready';
        this.staleReason = null;
        this.notify();
      }
      return 'ignored';
    }
    if (value.fromCatalogVersion !== visible.catalogVersion) {
      this.markStale(
        value.serverInstanceId === visible.serverInstanceId ? 'delta-gap' : 'server-restarted',
      );
      return 'stale';
    }

    const candidate = cloneProjection(visible);
    const failure = this.applyBatchToProjection(candidate, value);
    if (failure) {
      this.markStale(failure);
      return 'stale';
    }
    this.visible = candidate;
    this.status = 'ready';
    this.staleReason = null;
    this.notify();
    return 'applied';
  }

  markReconnecting(): void {
    this.staging = null;
    this.status = 'reconnecting';
    this.staleReason = null;
    this.notify();
  }

  markUnavailable(): void {
    this.staging = null;
    this.status = 'unavailable';
    this.staleReason = 'transport-unavailable';
    this.notify();
  }

  markCapacityExceeded(): void {
    this.staging = null;
    this.status = 'capacity-exceeded';
    this.staleReason = 'capacity-exceeded';
    this.notify();
  }

  markSnapshotStale(): void {
    this.markStale('snapshot-stale');
  }

  private applyEventToProjection(
    projection: MutableCatalogProjection,
    event: TaskCatalogEvent,
  ): void {
    const target = getEntityMap(projection, event.entityKind);
    const entityId = getEventEntityId(event);

    if (event.entityKind === 'session') {
      const previous = projection.sessions.get(entityId);
      if (previous) removeSessionIndex(projection.sessionsByTask, previous);
      if (event.kind === 'replace') {
        const session = event.entity as RemoteTaskSessionRef;
        addSessionIndexUnchecked(projection.sessionsByTask, session);
        sortSessionIndex(projection.sessionsByTask, session.taskId);
      }
      if (previous) sortSessionIndex(projection.sessionsByTask, previous.taskId);
    }

    if (event.kind === 'remove') {
      target.delete(entityId);
    } else {
      target.set(entityId, event.entity);
    }

    projection.catalogVersion = event.catalogVersion;
  }

  private applyBatchToProjection(
    projection: MutableCatalogProjection,
    batch: TaskCatalogDeltaBatch,
  ): TaskCatalogStaleReason | null {
    if (batch.fromCatalogVersion !== projection.catalogVersion) return 'delta-gap';
    let activeVersion: number | null = null;
    for (const event of batch.events) {
      if (activeVersion !== null && event.catalogVersion !== activeVersion) {
        const failure = validateCompleteProjection(projection);
        if (failure) return failure;
      }
      activeVersion = event.catalogVersion;
      this.applyEventToProjection(projection, event);
    }
    projection.catalogVersion = batch.toCatalogVersion;
    return validateCompleteProjection(projection);
  }

  private bufferDeltaBatch(batch: TaskCatalogDeltaBatch): ApplyTaskCatalogDeltaResult {
    const staging = this.staging;
    if (!staging) return 'stale';
    if (batch.serverInstanceId !== staging.manifest.serverInstanceId) {
      this.markStale('server-restarted');
      return 'stale';
    }
    if (batch.toCatalogVersion <= staging.manifest.catalogVersion) return 'ignored';
    if (batch.fromCatalogVersion < staging.manifest.catalogVersion || batch.events.length === 0) {
      this.markStale('delta-gap');
      return 'stale';
    }

    const batchKey = getBatchKey(batch);
    const fingerprint = JSON.stringify(batch);
    const existing = staging.bufferedDeltaFingerprints.get(batchKey);
    if (existing !== undefined) {
      if (existing === fingerprint) return 'ignored';
      this.markStale('delta-gap');
      return 'stale';
    }
    const deltaBytes = getBatchEventBytes(batch);
    if (
      staging.bufferedDeltaCount + batch.events.length > MAX_BUFFERED_DELTA_COUNT ||
      staging.bufferedDeltaBytes + deltaBytes > MAX_BUFFERED_DELTA_BYTES
    ) {
      this.markStale('delta-overflow');
      return 'stale';
    }
    staging.bufferedDeltaFingerprints.set(batchKey, fingerprint);
    staging.bufferedDeltas.push(structuredClone(batch));
    staging.bufferedDeltaCount += batch.events.length;
    staging.bufferedDeltaBytes += deltaBytes;
    return 'buffered';
  }

  private markStale(reason: TaskCatalogStaleReason): void {
    this.staging = null;
    this.status = 'stale';
    this.staleReason = reason;
    this.notify();
  }

  private notify(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private publishStaging(): StageTaskCatalogPageResult {
    const staging = this.staging;
    if (!staging) return 'stale';

    sortSessionIndexes(staging.projection);
    const baseFailure = validateCompleteProjection(staging.projection);
    if (baseFailure) {
      this.markStale(baseFailure);
      return 'stale';
    }

    const buffered = [...staging.bufferedDeltas].sort(
      (left, right) =>
        left.fromCatalogVersion - right.fromCatalogVersion ||
        left.toCatalogVersion - right.toCatalogVersion,
    );
    const candidate = cloneProjection(staging.projection);
    let expectedVersion = staging.manifest.catalogVersion;
    for (const batch of buffered) {
      if (batch.fromCatalogVersion !== expectedVersion) {
        this.markStale('delta-gap');
        return 'stale';
      }
      const failure = this.applyBatchToProjection(candidate, batch);
      if (failure) {
        this.markStale(failure);
        return 'stale';
      }
      expectedVersion = batch.toCatalogVersion;
    }

    this.visible = candidate;
    this.staging = null;
    this.status = 'ready';
    this.staleReason = null;
    this.notify();
    return 'published';
  }
}

export interface TaskCatalogRuntimeOptions {
  readonly liveEvents?: TaskCatalogLiveEventSource;
  readonly store?: TaskCatalogStore;
  readonly transport: TaskCatalogClientFacade;
  readonly yieldBetweenPages?: () => Promise<void>;
}

export class TaskCatalogRuntime {
  readonly store: TaskCatalogStore;
  private activeAbortController: AbortController | null = null;
  private destroyed = false;
  private generation = 0;
  private liveEventCleanup: (() => void) | null = null;
  private resyncRequested = false;
  private scheduledResync: Promise<void> | null = null;
  private readonly transport: TaskCatalogClientFacade;
  private readonly yieldBetweenPages: () => Promise<void>;

  constructor(options: TaskCatalogRuntimeOptions) {
    this.store = options.store ?? new TaskCatalogStore();
    this.transport = options.transport;
    this.yieldBetweenPages = options.yieldBetweenPages ?? (() => Promise.resolve());
    if (options.liveEvents) this.connectLiveEvents(options.liveEvents);
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    runBestEffortCleanup(this.liveEventCleanup);
    this.liveEventCleanup = null;
    this.resyncRequested = false;
    this.cancelActiveRequest();
  }

  connectLiveEvents(source: TaskCatalogLiveEventSource): () => void {
    if (this.destroyed) return () => undefined;
    runBestEffortCleanup(this.liveEventCleanup);
    this.liveEventCleanup = null;
    let cleanup: (() => void) | null = null;
    try {
      cleanup = source.subscribe((message) => this.handleLiveMessage(message));
    } catch {
      this.store.markUnavailable();
      return () => undefined;
    }
    if (this.destroyed) {
      runBestEffortCleanup(cleanup);
      return () => undefined;
    }
    this.liveEventCleanup = cleanup;
    return () => {
      if (this.liveEventCleanup !== cleanup) return;
      this.liveEventCleanup = null;
      runBestEffortCleanup(cleanup);
    };
  }

  private cancelActiveRequest(): void {
    this.generation += 1;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
  }

  handleConnectionLoss(): void {
    if (this.destroyed) return;
    this.cancelActiveRequest();
    this.resyncRequested = false;
    this.store.markReconnecting();
  }

  handleLiveMessage(message: unknown): void {
    if (this.destroyed) return;
    if (!isTaskCatalogLiveMessage(message)) {
      this.store.markSnapshotStale();
      void this.requestResync();
      return;
    }
    if (message.kind === 'catalog-delta') {
      const result = this.store.applyDeltaBatch(message.batch);
      if (result === 'stale') void this.requestResync();
    } else if (message.state === 'disconnected') {
      this.handleConnectionLoss();
    } else {
      void this.requestResync();
    }
  }

  requestResync(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.resyncRequested = true;
    if (this.scheduledResync) return this.scheduledResync;
    const run = Promise.resolve().then(async () => {
      while (this.resyncRequested && !this.destroyed) {
        this.resyncRequested = false;
        await this.refresh();
      }
    });
    const scheduled = run.finally(() => {
      if (this.scheduledResync === scheduled) this.scheduledResync = null;
    });
    this.scheduledResync = scheduled;
    return scheduled;
  }

  async refresh(): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    this.activeAbortController?.abort();
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    try {
      for (let attempt = 0; attempt < 3 && this.isCurrent(generation); attempt += 1) {
        const outcome = await this.refreshOnce(generation, abortController);
        if (outcome !== 'retry') return;
        if (attempt < 2) await this.yieldBetweenPages();
      }
    } catch {
      if (!abortController.signal.aborted) this.store.markUnavailable();
    } finally {
      if (this.activeAbortController === abortController) this.activeAbortController = null;
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.activeAbortController?.signal.aborted;
  }

  private async refreshOnce(
    generation: number,
    abortController: AbortController,
  ): Promise<'complete' | 'retry' | 'stopped'> {
    const manifestResult = await this.transport.getManifest(abortController.signal);
    if (!this.isCurrent(generation)) return 'stopped';
    if (manifestResult.kind === 'catalog-capacity-exceeded') {
      this.store.markCapacityExceeded();
      return 'stopped';
    }
    if (manifestResult.kind !== 'found') {
      if (manifestResult.kind === 'catalog-snapshot-stale') {
        this.store.markSnapshotStale();
        return 'retry';
      }
      this.store.markUnavailable();
      return 'stopped';
    }

    const manifest = manifestResult.value;
    const visible = this.store.getSnapshot().projection;
    if (
      visible?.serverInstanceId === manifest.serverInstanceId &&
      visible.catalogVersion >= manifest.catalogVersion
    ) {
      return this.syncDeltas(generation, abortController);
    }

    const begin = this.store.beginManifest(manifest);
    if (begin === 'stale') return 'retry';
    if (begin === 'current') return this.syncDeltas(generation, abortController);

    for (const kind of TASK_CATALOG_ENTITY_KINDS) {
      let cursor: string | undefined;
      do {
        const request: GetTaskCatalogPageRequest = {
          catalogVersion: manifest.catalogVersion,
          kind,
          serverInstanceId: manifest.serverInstanceId,
          snapshotId: manifest.snapshotId,
          ...(cursor === undefined ? {} : { cursor }),
        };
        const pageResult = await this.transport.getPage(request, abortController.signal);
        if (!this.isCurrent(generation)) return 'stopped';
        if (pageResult.kind === 'catalog-capacity-exceeded') {
          this.store.markCapacityExceeded();
          return 'stopped';
        }
        if (pageResult.kind !== 'found') {
          if (pageResult.kind === 'catalog-snapshot-stale') {
            this.store.markSnapshotStale();
            return 'retry';
          }
          this.store.markUnavailable();
          return 'stopped';
        }

        const stageResult = this.store.stagePage(pageResult.value, request);
        if (stageResult === 'stale') return 'retry';
        cursor = pageResult.value.nextCursor ?? undefined;
        if (cursor !== undefined) await this.yieldBetweenPages();
      } while (cursor !== undefined && this.isCurrent(generation));
    }

    return this.syncDeltas(generation, abortController);
  }

  private async syncDeltas(
    generation: number,
    abortController: AbortController,
  ): Promise<'complete' | 'retry' | 'stopped'> {
    const projection = this.store.getSnapshot().projection;
    const catalogVersion = this.store.getDeltaResumeVersion();
    if (!projection || catalogVersion === null) return 'retry';
    const result = await this.transport.getDeltasSince(
      { catalogVersion, serverInstanceId: projection.serverInstanceId },
      abortController.signal,
    );
    if (!this.isCurrent(generation)) return 'stopped';
    if (result.kind === 'catalog-capacity-exceeded') {
      this.store.markCapacityExceeded();
      return 'stopped';
    }
    if (result.kind !== 'found') {
      if (result.kind === 'catalog-snapshot-stale') {
        this.store.markSnapshotStale();
        return 'retry';
      }
      this.store.markUnavailable();
      return 'stopped';
    }
    return this.store.applyDeltaBatch(result.value) === 'stale' ? 'retry' : 'complete';
  }
}
