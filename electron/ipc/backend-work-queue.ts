// Global prioritized backend work queue. All deferrable backend recomputation
// (git-status refresh chains, convergence/review/signals refreshes, background
// reconciliation) routes through this owner so boot and steady-state subprocess
// fan-out stays bounded and focus-driven.

export type BackendWorkPriorityClass = 'interactive' | 'selected' | 'visible' | 'background';

export interface BackendWorkJobOptions {
  key: string;
  priority?: BackendWorkPriorityClass;
  taskId?: string;
}

export interface BackendClientTaskFocus {
  focusedChannelIds?: string[];
  selectedTaskId: string | null;
  visibleTaskIds: string[];
}

export interface BackendWorkQueueDiagnostics {
  completed: number;
  pendingByClass: Record<BackendWorkPriorityClass, number>;
  running: number;
}

interface PendingBackendWorkJob {
  effectivePriority: BackendWorkPriorityClass;
  enqueuedAt: number;
  explicitPriority: BackendWorkPriorityClass | null;
  key: string;
  promotionTimer: ReturnType<typeof setTimeout> | null;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  run: () => Promise<unknown> | unknown;
  taskId: string | null;
}

interface BackendClientFocusEntry {
  // Retained for the attach-pipeline item's channel-priority consumer; the work
  // queue itself derives priority from task focus only.
  focusedChannelIds: ReadonlySet<string>;
  selectedTaskId: string | null;
  updatedAt: number;
  visibleTaskIds: Set<string>;
}

const PRIORITY_ORDER: readonly BackendWorkPriorityClass[] = [
  'interactive',
  'selected',
  'visible',
  'background',
];

const DEFAULT_CONCURRENCY = 3;
const BACKGROUND_AGING_PROMOTION_MS = 60_000;
const BACKGROUND_SWEEP_START_DELAY_MS = 15_000;
const CLIENT_FOCUS_TTL_MS = 60_000;

const pending: PendingBackendWorkJob[] = [];
const pendingByKey = new Map<string, PendingBackendWorkJob>();
const jobPromises = new WeakMap<PendingBackendWorkJob, Promise<unknown>>();
const clientFocus = new Map<string, BackendClientFocusEntry>();
const reconciliationTaskIds: string[] = [];
let reconciliationRunTask: ((taskId: string) => Promise<void>) | null = null;
let reconciliationTimer: ReturnType<typeof setTimeout> | null = null;
let reconciliationActive = false;
let clientFocusExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let backgroundReleased = false;
let runningCount = 0;
let runningBackgroundCount = 0;
let runningHigherLaneCount = 0;
let completedCount = 0;

function priorityRank(priority: BackendWorkPriorityClass): number {
  return PRIORITY_ORDER.indexOf(priority);
}

function getConcurrencyCap(): number {
  const raw = process.env.PARALLEL_CODE_BACKEND_WORK_CONCURRENCY;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_CONCURRENCY;
}

function getBackgroundSweepStartDelayMs(): number {
  const raw = process.env.PARALLEL_CODE_BACKEND_SWEEP_DELAY_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return BACKGROUND_SWEEP_START_DELAY_MS;
}

function isClientFocusEntryLive(entry: BackendClientFocusEntry, now: number): boolean {
  return now - entry.updatedAt <= CLIENT_FOCUS_TTL_MS;
}

// Expired entries are deleted, not just skipped, so HTTP-only clients that never
// had a websocket disconnect hook cannot accumulate in the registry forever.
function pruneExpiredClientFocus(now: number): boolean {
  let removed = false;
  for (const [clientId, entry] of clientFocus) {
    if (!isClientFocusEntryLive(entry, now)) {
      clientFocus.delete(clientId);
      removed = true;
    }
  }

  return removed;
}

function clearClientFocusExpiryTimer(): void {
  if (clientFocusExpiryTimer !== null) {
    clearTimeout(clientFocusExpiryTimer);
    clientFocusExpiryTimer = null;
  }
}

function getNextClientFocusExpiryDelay(now: number): number | null {
  let earliestExpiryAt: number | null = null;
  for (const entry of clientFocus.values()) {
    const expiryAt = entry.updatedAt + CLIENT_FOCUS_TTL_MS;
    if (earliestExpiryAt === null || expiryAt < earliestExpiryAt) {
      earliestExpiryAt = expiryAt;
    }
  }

  if (earliestExpiryAt === null) {
    return null;
  }

  return Math.max(0, earliestExpiryAt - now);
}

function scheduleClientFocusExpiry(now = Date.now()): void {
  clearClientFocusExpiryTimer();
  const delayMs = getNextClientFocusExpiryDelay(now);
  if (delayMs === null) {
    return;
  }

  const timer = setTimeout(() => {
    clientFocusExpiryTimer = null;
    if (pruneExpiredClientFocus(Date.now())) {
      reprioritizePendingJobsForFocus();
      notifyFocusedChannelListeners();
    }
    scheduleClientFocusExpiry();
  }, delayMs);
  timer.unref?.();
  clientFocusExpiryTimer = timer;
}

function refreshClientFocusLiveness(now = Date.now()): void {
  if (pruneExpiredClientFocus(now)) {
    reprioritizePendingJobsForFocus();
  }
  scheduleClientFocusExpiry(now);
}

function getLiveClientFocusEntries(now = Date.now()): Iterable<BackendClientFocusEntry> {
  refreshClientFocusLiveness(now);
  return clientFocus.values();
}

function deriveFocusPriorityForTask(taskId: string): BackendWorkPriorityClass {
  const liveEntries = getLiveClientFocusEntries();
  let hasLiveClient = false;
  let visible = false;
  for (const entry of liveEntries) {
    hasLiveClient = true;
    if (entry.selectedTaskId === taskId) {
      return 'selected';
    }
    if (entry.visibleTaskIds.has(taskId)) {
      visible = true;
    }
  }

  if (!hasLiveClient) {
    return 'visible';
  }

  return visible ? 'visible' : 'background';
}

export function getBackendWorkPriorityForTask(
  taskId: string | undefined,
): BackendWorkPriorityClass {
  if (taskId === undefined) {
    return 'visible';
  }

  return deriveFocusPriorityForTask(taskId);
}

function clearPromotionTimer(job: PendingBackendWorkJob): void {
  if (job.promotionTimer !== null) {
    clearTimeout(job.promotionTimer);
    job.promotionTimer = null;
  }
}

function promoteAgedBackgroundJob(job: PendingBackendWorkJob): void {
  job.promotionTimer = null;
  if (job.effectivePriority !== 'background') {
    return;
  }

  job.effectivePriority = 'visible';
  dispatchPendingWork();
}

function syncPromotionTimer(job: PendingBackendWorkJob): void {
  if (job.effectivePriority !== 'background') {
    clearPromotionTimer(job);
    return;
  }

  if (job.promotionTimer !== null) {
    return;
  }

  const timer = setTimeout(() => {
    promoteAgedBackgroundJob(job);
  }, BACKGROUND_AGING_PROMOTION_MS);
  timer.unref?.();
  job.promotionTimer = timer;
}

function takeNextDispatchableJob(): PendingBackendWorkJob | null {
  const cap = getConcurrencyCap();
  if (runningCount >= cap || pending.length === 0) {
    return null;
  }

  let best: PendingBackendWorkJob | null = null;
  let bestIndex = -1;
  for (let index = 0; index < pending.length; index += 1) {
    const job = pending[index];
    if (!job) {
      continue;
    }
    if (
      best === null ||
      priorityRank(job.effectivePriority) < priorityRank(best.effectivePriority)
    ) {
      best = job;
      bestIndex = index;
    }
  }

  if (!best) {
    return null;
  }

  if (best.effectivePriority === 'background') {
    const higherLaneIdle = runningHigherLaneCount === 0 && !hasPendingHigherLaneWork();
    if (!backgroundReleased || runningBackgroundCount >= 1 || !higherLaneIdle) {
      return null;
    }
  }

  pending.splice(bestIndex, 1);
  pendingByKey.delete(best.key);
  clearPromotionTimer(best);
  return best;
}

function hasPendingHigherLaneWork(): boolean {
  return pending.some((job) => job.effectivePriority !== 'background');
}

function dispatchPendingWork(): void {
  while (true) {
    const job = takeNextDispatchableJob();
    if (!job) {
      return;
    }

    runJob(job);
  }
}

function runJob(job: PendingBackendWorkJob): void {
  const isBackground = job.effectivePriority === 'background';
  runningCount += 1;
  if (isBackground) {
    runningBackgroundCount += 1;
  } else {
    runningHigherLaneCount += 1;
  }

  void Promise.resolve()
    .then(job.run)
    .then(
      (value) => {
        job.resolve(value);
      },
      (error: unknown) => {
        job.reject(error);
      },
    )
    .finally(() => {
      runningCount -= 1;
      if (isBackground) {
        runningBackgroundCount -= 1;
      } else {
        runningHigherLaneCount -= 1;
      }
      completedCount += 1;
      dispatchPendingWork();
    });
}

export function enqueueBackendWork<T>(
  options: BackendWorkJobOptions,
  run: () => Promise<T> | T,
): Promise<T> {
  const existing = pendingByKey.get(options.key);
  const requestedPriority = options.priority ?? getBackendWorkPriorityForTask(options.taskId);
  if (existing) {
    if (priorityRank(requestedPriority) < priorityRank(existing.effectivePriority)) {
      existing.effectivePriority = requestedPriority;
      if (options.priority !== undefined) {
        existing.explicitPriority = requestedPriority;
      }
      syncPromotionTimer(existing);
      dispatchPendingWork();
    }
    return promiseOfJob<T>(existing);
  }

  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  const job: PendingBackendWorkJob = {
    effectivePriority: requestedPriority,
    enqueuedAt: Date.now(),
    explicitPriority: options.priority ?? null,
    key: options.key,
    promotionTimer: null,
    reject,
    resolve,
    run,
    taskId: options.taskId ?? null,
  };
  jobPromises.set(job, promise);
  pending.push(job);
  pendingByKey.set(job.key, job);
  syncPromotionTimer(job);
  dispatchPendingWork();
  return promise as Promise<T>;
}

function promiseOfJob<T>(job: PendingBackendWorkJob): Promise<T> {
  const promise = jobPromises.get(job);
  if (!promise) {
    throw new Error(`Backend work job promise missing for key ${job.key}`);
  }

  return promise as Promise<T>;
}

function reprioritizePendingJobsForFocus(): void {
  for (const job of pending) {
    if (job.explicitPriority !== null || job.taskId === null) {
      continue;
    }

    job.effectivePriority = getBackendWorkPriorityForTask(job.taskId);
    syncPromotionTimer(job);
  }

  dispatchPendingWork();
}

const focusedChannelListeners = new Set<() => void>();

function notifyFocusedChannelListeners(): void {
  for (const listener of focusedChannelListeners) {
    listener();
  }
}

// The control plane registers a consumer here to forward focused-channel ids
// from ReportClientTaskFocus into the channel manager's outbound lane
// priority; the focus signal stays single-owner (backend-focus-reporter) with
// two backend consumers.
export function subscribeBackendClientFocusedChannels(listener: () => void): () => void {
  focusedChannelListeners.add(listener);
  return () => {
    focusedChannelListeners.delete(listener);
  };
}

export function getAllBackendFocusedChannelIds(): ReadonlySet<string> {
  refreshClientFocusLiveness();
  const focusedChannelIds = new Set<string>();
  for (const focus of clientFocus.values()) {
    for (const channelId of focus.focusedChannelIds) {
      focusedChannelIds.add(channelId);
    }
  }
  return focusedChannelIds;
}

export function setBackendClientFocus(clientId: string, focus: BackendClientTaskFocus): void {
  const now = Date.now();
  pruneExpiredClientFocus(now);
  clientFocus.set(clientId, {
    focusedChannelIds: new Set(focus.focusedChannelIds ?? []),
    selectedTaskId: focus.selectedTaskId,
    updatedAt: now,
    visibleTaskIds: new Set(focus.visibleTaskIds),
  });
  scheduleClientFocusExpiry(now);
  reprioritizePendingJobsForFocus();
  notifyFocusedChannelListeners();
}

// Last reported selection per client, read by the focus IPC handler to decide
// whether a selection actually changed. Entries share the registry's TTL prune
// and disconnect cleanup, so this cannot grow with stale clients.
export function getBackendClientSelectedTaskId(clientId: string): string | null {
  refreshClientFocusLiveness();
  return clientFocus.get(clientId)?.selectedTaskId ?? null;
}

const EMPTY_CHANNEL_ID_SET: ReadonlySet<string> = new Set();

// Retained focus payload for the attach-pipeline item's channel-priority
// consumer (control plane / lane scheduler); the work queue itself never reads
// channel ids.
export function getBackendClientFocusedChannelIds(clientId: string): ReadonlySet<string> {
  refreshClientFocusLiveness();
  return clientFocus.get(clientId)?.focusedChannelIds ?? EMPTY_CHANNEL_ID_SET;
}

export function clearBackendClientFocus(clientId: string): void {
  if (!clientFocus.delete(clientId)) {
    return;
  }

  scheduleClientFocusExpiry();
  reprioritizePendingJobsForFocus();
  notifyFocusedChannelListeners();
}

export function releaseBackendBackgroundWork(): void {
  if (backgroundReleased) {
    return;
  }

  backgroundReleased = true;
  dispatchPendingWork();
  armBackgroundReconciliationSweep();
}

export function scheduleBackgroundReconciliation(
  taskIds: readonly string[],
  runTask: (taskId: string) => Promise<void>,
): void {
  reconciliationTaskIds.push(...taskIds);
  reconciliationRunTask = runTask;
  if (backgroundReleased) {
    armBackgroundReconciliationSweep();
  }
}

export function cancelBackendBackgroundReconciliation(): void {
  reconciliationTaskIds.length = 0;
  reconciliationRunTask = null;
  if (reconciliationTimer !== null) {
    clearTimeout(reconciliationTimer);
    reconciliationTimer = null;
  }
}

function armBackgroundReconciliationSweep(): void {
  if (reconciliationTimer !== null || reconciliationActive || reconciliationTaskIds.length === 0) {
    return;
  }

  const timer = setTimeout(() => {
    reconciliationTimer = null;
    void runBackgroundReconciliationSweep();
  }, getBackgroundSweepStartDelayMs());
  timer.unref?.();
  reconciliationTimer = timer;
}

async function runBackgroundReconciliationSweep(): Promise<void> {
  if (reconciliationActive) {
    return;
  }

  reconciliationActive = true;
  try {
    while (reconciliationTaskIds.length > 0) {
      const taskId = reconciliationTaskIds.shift();
      const runTask = reconciliationRunTask;
      if (taskId === undefined || runTask === null) {
        return;
      }

      await enqueueBackendWork({ key: `reconcile:${taskId}`, priority: 'background', taskId }, () =>
        runTask(taskId),
      ).catch(() => {});
    }
  } finally {
    reconciliationActive = false;
  }
}

export function getBackendWorkQueueDiagnostics(): BackendWorkQueueDiagnostics {
  const pendingByClass: Record<BackendWorkPriorityClass, number> = {
    background: 0,
    interactive: 0,
    selected: 0,
    visible: 0,
  };
  for (const job of pending) {
    pendingByClass[job.effectivePriority] += 1;
  }

  return {
    completed: completedCount,
    pendingByClass,
    running: runningCount,
  };
}

export function resetBackendWorkQueueForTests(): void {
  for (const job of pending) {
    clearPromotionTimer(job);
  }
  pending.length = 0;
  pendingByKey.clear();
  clientFocus.clear();
  focusedChannelListeners.clear();
  clearClientFocusExpiryTimer();
  reconciliationTaskIds.length = 0;
  reconciliationRunTask = null;
  if (reconciliationTimer !== null) {
    clearTimeout(reconciliationTimer);
    reconciliationTimer = null;
  }
  reconciliationActive = false;
  backgroundReleased = false;
  completedCount = 0;
  runningCount = 0;
  runningBackgroundCount = 0;
  runningHigherLaneCount = 0;
}
