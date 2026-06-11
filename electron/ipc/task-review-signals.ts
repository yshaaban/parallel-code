import fs from 'fs';
import path from 'path';

import type {
  RemovedTaskReviewSignalsEvent,
  TaskReviewCiSignal,
  TaskReviewCoverageSignal,
  TaskReviewCoverageSource,
  TaskReviewSignalsEvent,
  TaskReviewSignalsSnapshot,
} from '../../src/domain/task-review-signals.js';
import { parseGitHubUrl } from '../../src/lib/github-url.js';
import { enqueueBackendWork, type BackendWorkPriorityClass } from './backend-work-queue.js';
import { runQueuedRefresh } from './queued-refresh.js';
import { toSavedStateDocument, type SavedStateDocument } from './saved-state-document.js';

interface TaskReviewSignalsMetadata {
  githubUrl?: string;
  taskId: string;
  worktreePath: string;
}

interface GithubFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type GithubFetch = (url: string, init: RequestInit) => Promise<GithubFetchResponse>;
type TaskReviewSignalsListener = (event: TaskReviewSignalsEvent) => void;

const COVERAGE_SUMMARY_RELATIVE_PATHS = [
  'coverage/coverage-summary.json',
  'coverage-summary.json',
] as const;
const LCOV_RELATIVE_PATHS = ['coverage/lcov.info', 'lcov.info'] as const;
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_FETCH_TIMEOUT_MS = 5_000;

const taskReviewSignalsMetadata = new Map<string, TaskReviewSignalsMetadata>();
const taskReviewSignalsSnapshots = new Map<string, TaskReviewSignalsSnapshot>();
const taskReviewSignalsListeners = new Set<TaskReviewSignalsListener>();
const inFlightRefreshes = new Map<string, Promise<void>>();
const pendingRefreshes = new Set<string>();

let taskReviewSignalsStateVersion = 0;
let githubFetch: GithubFetch = defaultGithubFetch;

function bumpTaskReviewSignalsStateVersion(): number {
  taskReviewSignalsStateVersion += 1;
  return taskReviewSignalsStateVersion;
}

function emitTaskReviewSignalsEvent(event: TaskReviewSignalsEvent): void {
  const stateVersion = bumpTaskReviewSignalsStateVersion();
  const versionedEvent = {
    ...event,
    stateVersion,
  };
  for (const listener of taskReviewSignalsListeners) {
    listener(versionedEvent);
  }
}

function createRemovedTaskReviewSignalsEvent(taskId: string): RemovedTaskReviewSignalsEvent {
  return {
    removed: true,
    taskId,
  };
}

function createFetchSignal(): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS);
  }

  return undefined;
}

async function defaultGithubFetch(url: string, init: RequestInit): Promise<GithubFetchResponse> {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is unavailable in this runtime');
  }

  return fetch(url, init);
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getMetricPct(total: Record<string, unknown>, key: string): number | undefined {
  const metric = getRecord(total[key]);
  return metric ? getNumber(metric.pct) : undefined;
}

function createMissingCoverageSignal(
  description = 'No coverage artifact found',
): TaskReviewCoverageSignal {
  return {
    description,
    label: 'Coverage unavailable',
    state: 'missing',
  };
}

function createCoverageErrorSignal(error: unknown): TaskReviewCoverageSignal {
  return {
    description: error instanceof Error ? error.message : 'Coverage could not be parsed',
    label: 'Coverage unavailable',
    state: 'error',
  };
}

function createAvailableCoverageSignal(
  source: TaskReviewCoverageSource,
  metrics: {
    branchesPct?: number;
    functionsPct?: number;
    linesPct?: number;
    statementsPct?: number;
  },
): TaskReviewCoverageSignal {
  const primaryPct = metrics.linesPct ?? metrics.statementsPct;
  return {
    ...metrics,
    checkedAt: Date.now(),
    label: primaryPct === undefined ? 'Coverage available' : `Coverage ${primaryPct.toFixed(1)}%`,
    source,
    state: 'available',
  };
}

function createCoverageMetrics(metrics: {
  branchesPct?: number | undefined;
  functionsPct?: number | undefined;
  linesPct?: number | undefined;
  statementsPct?: number | undefined;
}): {
  branchesPct?: number;
  functionsPct?: number;
  linesPct?: number;
  statementsPct?: number;
} {
  return {
    ...(metrics.branchesPct !== undefined ? { branchesPct: metrics.branchesPct } : {}),
    ...(metrics.functionsPct !== undefined ? { functionsPct: metrics.functionsPct } : {}),
    ...(metrics.linesPct !== undefined ? { linesPct: metrics.linesPct } : {}),
    ...(metrics.statementsPct !== undefined ? { statementsPct: metrics.statementsPct } : {}),
  };
}

function parseCoverageSummaryJson(value: unknown): TaskReviewCoverageSignal | null {
  const root = getRecord(value);
  const total = root ? getRecord(root.total) : null;
  if (!total) {
    return null;
  }

  const metrics = createCoverageMetrics({
    branchesPct: getMetricPct(total, 'branches'),
    functionsPct: getMetricPct(total, 'functions'),
    linesPct: getMetricPct(total, 'lines'),
    statementsPct: getMetricPct(total, 'statements'),
  });

  if (Object.values(metrics).every((metric) => metric === undefined)) {
    return null;
  }

  return createAvailableCoverageSignal('coverage-summary', metrics);
}

function addLcovValue(totals: Record<string, number>, line: string, key: string): void {
  if (!line.startsWith(`${key}:`)) {
    return;
  }

  const value = Number.parseInt(line.slice(key.length + 1), 10);
  if (Number.isFinite(value)) {
    totals[key] = (totals[key] ?? 0) + value;
  }
}

function getPct(hit: number | undefined, found: number | undefined): number | undefined {
  if (!found || found <= 0 || hit === undefined) {
    return undefined;
  }

  return (hit / found) * 100;
}

function parseLcov(contents: string): TaskReviewCoverageSignal | null {
  const totals: Record<string, number> = {};
  for (const line of contents.split(/\r?\n/u)) {
    addLcovValue(totals, line, 'LF');
    addLcovValue(totals, line, 'LH');
    addLcovValue(totals, line, 'BRF');
    addLcovValue(totals, line, 'BRH');
    addLcovValue(totals, line, 'FNF');
    addLcovValue(totals, line, 'FNH');
  }

  const metrics = createCoverageMetrics({
    branchesPct: getPct(totals.BRH, totals.BRF),
    functionsPct: getPct(totals.FNH, totals.FNF),
    linesPct: getPct(totals.LH, totals.LF),
  });

  if (Object.values(metrics).every((metric) => metric === undefined)) {
    return null;
  }

  return createAvailableCoverageSignal('lcov', metrics);
}

function parseCoverageSummaryContents(contents: string): TaskReviewCoverageSignal | null {
  return parseCoverageSummaryJson(JSON.parse(contents));
}

async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (getRecord(error)?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function rememberFirstCoverageError(
  currentError: unknown | undefined,
  nextError: unknown | undefined,
): unknown | undefined {
  if (currentError !== undefined) {
    return currentError;
  }

  return nextError;
}

async function readCoverageSignalCandidate(
  worktreePath: string,
  relativePath: string,
  parseContents: (contents: string) => TaskReviewCoverageSignal | null,
): Promise<{ error?: unknown; signal?: TaskReviewCoverageSignal }> {
  try {
    const contents = await readTextFileIfExists(path.join(worktreePath, relativePath));
    if (!contents) {
      return {};
    }

    const signal = parseContents(contents);
    if (signal) {
      return { signal };
    }

    return { error: new Error(`Invalid ${relativePath}`) };
  } catch (error) {
    return { error };
  }
}

async function loadCoverageSignalFromCandidates(
  worktreePath: string,
  relativePaths: ReadonlyArray<string>,
  parseContents: (contents: string) => TaskReviewCoverageSignal | null,
  firstError: unknown | undefined,
): Promise<{ error?: unknown; signal?: TaskReviewCoverageSignal }> {
  let nextError = firstError;
  for (const relativePath of relativePaths) {
    const candidate = await readCoverageSignalCandidate(worktreePath, relativePath, parseContents);
    if (candidate.signal) {
      return { signal: candidate.signal };
    }

    nextError = rememberFirstCoverageError(nextError, candidate.error);
  }

  return nextError === undefined ? {} : { error: nextError };
}

async function loadCoverageSignal(worktreePath: string): Promise<TaskReviewCoverageSignal> {
  const summaryResult = await loadCoverageSignalFromCandidates(
    worktreePath,
    COVERAGE_SUMMARY_RELATIVE_PATHS,
    parseCoverageSummaryContents,
    undefined,
  );
  if (summaryResult.signal) {
    return summaryResult.signal;
  }

  const lcovResult = await loadCoverageSignalFromCandidates(
    worktreePath,
    LCOV_RELATIVE_PATHS,
    parseLcov,
    summaryResult.error,
  );
  if (lcovResult.signal) {
    return lcovResult.signal;
  }

  if (lcovResult.error) {
    return createCoverageErrorSignal(lcovResult.error);
  }

  return createMissingCoverageSignal();
}

function getGithubToken(): string | undefined {
  return process.env.PARALLEL_CODE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

function createGithubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'parallel-code',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  const token = getGithubToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGithubJson(url: string): Promise<unknown> {
  const signal = createFetchSignal();
  const response = await githubFetch(url, {
    headers: createGithubHeaders(),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed with status ${response.status}`);
  }

  return response.json();
}

function createUnconfiguredCiSignal(description: string): TaskReviewCiSignal {
  return {
    description,
    label: 'CI unavailable',
    state: 'unconfigured',
  };
}

function createCiErrorSignal(error: unknown): TaskReviewCiSignal {
  return {
    checkedAt: Date.now(),
    description: error instanceof Error ? error.message : 'CI status could not be loaded',
    label: 'CI unavailable',
    state: 'error',
  };
}

function getGithubPullRequest(value: unknown): {
  headSha: string;
  htmlUrl?: string;
} | null {
  const record = getRecord(value);
  const head = record ? getRecord(record.head) : null;
  const headSha = head ? getString(head.sha) : undefined;
  if (!headSha) {
    return null;
  }

  const htmlUrl = getString(record?.html_url);
  return {
    headSha,
    ...(htmlUrl !== undefined ? { htmlUrl } : {}),
  };
}

function isFailureConclusion(conclusion: string | undefined): boolean {
  return (
    conclusion === 'failure' ||
    conclusion === 'cancelled' ||
    conclusion === 'timed_out' ||
    conclusion === 'action_required'
  );
}

function summarizeGithubCi(options: {
  checkRuns: unknown;
  combinedStatus: unknown;
  headSha: string;
  targetUrl?: string;
}): TaskReviewCiSignal {
  let failureCount = 0;
  let pendingCount = 0;
  let successCount = 0;
  let totalCount = 0;
  const targetUrls: string[] = [];
  const combinedRecord = getRecord(options.combinedStatus);
  const combinedState = getString(combinedRecord?.state);
  const statuses = getArray(combinedRecord?.statuses);

  if (combinedState) {
    totalCount += Math.max(1, statuses.length);
    if (combinedState === 'failure' || combinedState === 'error') {
      failureCount += 1;
    } else if (combinedState === 'pending') {
      pendingCount += 1;
    } else if (combinedState === 'success') {
      successCount += 1;
    }
  }

  for (const status of statuses) {
    const targetUrl = getString(getRecord(status)?.target_url);
    if (targetUrl) {
      targetUrls.push(targetUrl);
    }
  }

  const checkRunsRecord = getRecord(options.checkRuns);
  for (const checkRun of getArray(checkRunsRecord?.check_runs)) {
    const record = getRecord(checkRun);
    const status = getString(record?.status);
    const conclusion = getString(record?.conclusion);
    totalCount += 1;

    const htmlUrl = getString(record?.html_url);
    if (htmlUrl) {
      targetUrls.push(htmlUrl);
    }

    if (status !== 'completed') {
      pendingCount += 1;
    } else if (isFailureConclusion(conclusion)) {
      failureCount += 1;
    } else if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
      successCount += 1;
    }
  }

  const targetUrl = targetUrls[0] ?? options.targetUrl;
  const checkedAt = Date.now();
  if (failureCount > 0) {
    return {
      checkedAt,
      failureCount,
      headSha: options.headSha,
      label: 'CI failing',
      pendingCount,
      state: 'failure',
      ...(targetUrl !== undefined ? { targetUrl } : {}),
      totalCount,
    };
  }

  if (pendingCount > 0) {
    return {
      checkedAt,
      headSha: options.headSha,
      label: 'CI pending',
      pendingCount,
      state: 'pending',
      ...(targetUrl !== undefined ? { targetUrl } : {}),
      totalCount,
    };
  }

  if (successCount > 0 || totalCount > 0) {
    return {
      checkedAt,
      headSha: options.headSha,
      label: 'CI passing',
      state: 'success',
      ...(targetUrl !== undefined ? { targetUrl } : {}),
      totalCount,
    };
  }

  return {
    checkedAt,
    description: 'No GitHub status checks were found for this PR head',
    headSha: options.headSha,
    label: 'CI unavailable',
    state: 'unconfigured',
    ...(options.targetUrl !== undefined ? { targetUrl: options.targetUrl } : {}),
  };
}

async function loadGithubCiSignal(githubUrl: string | undefined): Promise<TaskReviewCiSignal> {
  if (!githubUrl) {
    return createUnconfiguredCiSignal('No GitHub PR URL is attached to this task');
  }

  const parsed = parseGitHubUrl(githubUrl);
  if (!parsed || parsed.type !== 'pull' || !parsed.number) {
    return createUnconfiguredCiSignal('Task GitHub URL is not a pull request');
  }

  const owner = encodeURIComponent(parsed.org);
  const repo = encodeURIComponent(parsed.repo.replace(/\.git$/u, ''));
  const pullNumber = encodeURIComponent(parsed.number);

  try {
    const pullRequest = getGithubPullRequest(
      await fetchGithubJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`),
    );
    if (!pullRequest) {
      return createCiErrorSignal(new Error('GitHub PR response did not include a head SHA'));
    }

    const commitUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(
      pullRequest.headSha,
    )}`;
    const [combinedStatus, checkRuns] = await Promise.all([
      fetchGithubJson(`${commitUrl}/status`),
      fetchGithubJson(`${commitUrl}/check-runs`),
    ]);

    return summarizeGithubCi({
      checkRuns,
      combinedStatus,
      headSha: pullRequest.headSha,
      ...(pullRequest.htmlUrl !== undefined ? { targetUrl: pullRequest.htmlUrl } : {}),
    });
  } catch (error) {
    return createCiErrorSignal(error);
  }
}

async function loadTaskReviewSignalsSnapshot(
  metadata: TaskReviewSignalsMetadata,
): Promise<TaskReviewSignalsSnapshot> {
  const [ci, coverage] = await Promise.all([
    loadGithubCiSignal(metadata.githubUrl),
    loadCoverageSignal(metadata.worktreePath),
  ]);

  return {
    ci,
    coverage,
    taskId: metadata.taskId,
    updatedAt: Date.now(),
  };
}

function createStableSnapshotIdentity(snapshot: TaskReviewSignalsSnapshot): string {
  const { updatedAt: _updatedAt, ci, coverage, ...stableSnapshot } = snapshot;
  const { checkedAt: _ciCheckedAt, ...stableCi } = ci;
  const { checkedAt: _coverageCheckedAt, ...stableCoverage } = coverage;
  return JSON.stringify({
    ...stableSnapshot,
    ci: stableCi,
    coverage: stableCoverage,
  });
}

function areTaskReviewSignalsSnapshotsEqual(
  left: TaskReviewSignalsSnapshot | undefined,
  right: TaskReviewSignalsSnapshot,
): boolean {
  return (
    left !== undefined && createStableSnapshotIdentity(left) === createStableSnapshotIdentity(right)
  );
}

function setTaskReviewSignalsSnapshot(snapshot: TaskReviewSignalsSnapshot): void {
  const current = taskReviewSignalsSnapshots.get(snapshot.taskId);
  if (areTaskReviewSignalsSnapshotsEqual(current, snapshot)) {
    return;
  }

  taskReviewSignalsSnapshots.set(snapshot.taskId, snapshot);
  emitTaskReviewSignalsEvent(snapshot);
}

async function refreshTaskReviewSignalsInternal(taskId: string): Promise<void> {
  const metadata = taskReviewSignalsMetadata.get(taskId);
  if (!metadata) {
    return;
  }

  const snapshot = await loadTaskReviewSignalsSnapshot(metadata);
  const currentMetadata = taskReviewSignalsMetadata.get(taskId);
  if (!currentMetadata) {
    return;
  }

  if (
    currentMetadata.githubUrl !== metadata.githubUrl ||
    currentMetadata.worktreePath !== metadata.worktreePath
  ) {
    return;
  }

  setTaskReviewSignalsSnapshot(snapshot);
}

function removeTaskReviewSignalsSnapshot(taskId: string): void {
  if (!taskReviewSignalsSnapshots.delete(taskId)) {
    return;
  }

  emitTaskReviewSignalsEvent(createRemovedTaskReviewSignalsEvent(taskId));
}

function collectTaskReviewSignalsMetadataFromSavedState(
  savedState: string | SavedStateDocument,
): TaskReviewSignalsMetadata[] {
  const parsed = toSavedStateDocument(savedState).taskLookup;
  const metadata: TaskReviewSignalsMetadata[] = [];
  for (const task of Object.values(parsed.tasks)) {
    if (!task.id || !task.worktreePath) {
      continue;
    }

    metadata.push({
      ...(task.githubUrl !== undefined ? { githubUrl: task.githubUrl } : {}),
      taskId: task.id,
      worktreePath: task.worktreePath,
    });
  }

  return metadata;
}

export function subscribeTaskReviewSignals(listener: TaskReviewSignalsListener): () => void {
  taskReviewSignalsListeners.add(listener);
  return () => {
    taskReviewSignalsListeners.delete(listener);
  };
}

export function listTaskReviewSignalsSnapshots(): TaskReviewSignalsSnapshot[] {
  return Array.from(taskReviewSignalsSnapshots.values()).sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
}

export function getTaskReviewSignalsStateVersion(): number {
  return taskReviewSignalsStateVersion;
}

export function getTaskReviewSignalsSnapshot(
  taskId: string,
): TaskReviewSignalsSnapshot | undefined {
  return taskReviewSignalsSnapshots.get(taskId);
}

export function registerTaskReviewSignalsTask(metadata: TaskReviewSignalsMetadata): void {
  const previous = taskReviewSignalsMetadata.get(metadata.taskId);
  taskReviewSignalsMetadata.set(metadata.taskId, metadata);

  if (!previous) {
    return;
  }

  if (
    previous.githubUrl === metadata.githubUrl &&
    previous.worktreePath === metadata.worktreePath
  ) {
    return;
  }

  removeTaskReviewSignalsSnapshot(metadata.taskId);
  // Queue-routed (interactive) so save/load/reconnect identity changes stay
  // inside the global concurrency cap and dedupe keys.
  scheduleTaskReviewSignalsRefresh(metadata.taskId, 'interactive');
}

export function syncTaskReviewSignalsFromSavedState(savedState: string | SavedStateDocument): void {
  const nextMetadata = collectTaskReviewSignalsMetadataFromSavedState(savedState);
  const nextTaskIds = new Set(nextMetadata.map((metadata) => metadata.taskId));

  for (const taskId of taskReviewSignalsMetadata.keys()) {
    if (nextTaskIds.has(taskId)) {
      continue;
    }

    taskReviewSignalsMetadata.delete(taskId);
    removeTaskReviewSignalsSnapshot(taskId);
  }

  for (const metadata of nextMetadata) {
    registerTaskReviewSignalsTask(metadata);
  }
}

export function restoreSavedTaskReviewSignals(savedState: string | SavedStateDocument): void {
  syncTaskReviewSignalsFromSavedState(savedState);
}

export function hydrateTaskReviewSignalsSnapshots(
  snapshots: ReadonlyArray<TaskReviewSignalsSnapshot>,
): void {
  let hydrated = false;
  for (const snapshot of snapshots) {
    if (!taskReviewSignalsMetadata.has(snapshot.taskId)) {
      continue;
    }

    taskReviewSignalsSnapshots.set(snapshot.taskId, snapshot);
    hydrated = true;
  }

  if (hydrated) {
    bumpTaskReviewSignalsStateVersion();
  }
}

export function removeTaskReviewSignals(taskId: string): void {
  taskReviewSignalsMetadata.delete(taskId);
  removeTaskReviewSignalsSnapshot(taskId);
}

export async function refreshTaskReviewSignals(taskId: string): Promise<void> {
  await runQueuedRefresh(taskId, inFlightRefreshes, pendingRefreshes, () =>
    refreshTaskReviewSignalsInternal(taskId),
  );
}

export function scheduleTaskReviewSignalsRefresh(
  taskId: string,
  priority?: BackendWorkPriorityClass,
): void {
  void enqueueBackendWork(
    {
      key: `review-signals:${taskId}`,
      ...(priority !== undefined ? { priority } : {}),
      taskId,
    },
    () => refreshTaskReviewSignals(taskId),
  ).catch(() => {});
}

export function scheduleTaskReviewSignalsRefreshForWorktree(
  worktreePath: string,
  priority?: BackendWorkPriorityClass,
): void {
  for (const metadata of taskReviewSignalsMetadata.values()) {
    if (metadata.worktreePath !== worktreePath) {
      continue;
    }

    scheduleTaskReviewSignalsRefresh(metadata.taskId, priority);
  }
}

export function clearTaskReviewSignalsRegistry(): void {
  taskReviewSignalsMetadata.clear();
  taskReviewSignalsSnapshots.clear();
  taskReviewSignalsListeners.clear();
  inFlightRefreshes.clear();
  pendingRefreshes.clear();
  taskReviewSignalsStateVersion = 0;
  githubFetch = defaultGithubFetch;
}

export function setTaskReviewSignalsFetchForTests(fetcher: GithubFetch | null): void {
  githubFetch = fetcher ?? defaultGithubFetch;
}
