import fs from 'fs';
import path from 'path';
import {
  createRemovedTaskStepsEvent,
  isTaskStepStatus,
  type TaskStepEntry,
  type TaskStepStatus,
  type TaskStepsEvent,
  type TaskStepsSnapshot,
  type TaskStepsSummarySnapshot,
} from '../../src/domain/task-steps.js';
import { parseSavedStateTasksRecord } from '../../src/domain/saved-state-tasks.js';
import { assertNever } from '../../src/lib/assert-never.js';
import { isFiniteNumber, isRecord } from '../../src/lib/type-guards.js';

interface TaskStepsMetadata {
  taskId: string;
  worktreePath: string;
}

interface TaskStepsWatcher {
  fsWatcher: fs.FSWatcher | null;
  stepsDir: string;
  stepsFile: string;
  timeout: ReturnType<typeof setTimeout> | null;
  worktreePath: string;
}

interface LoadedTaskStepsState {
  errorMessage: string | null;
  steps: TaskStepEntry[];
}

type TaskStepsListener = (event: TaskStepsEvent) => void;

const watchers = new Map<string, TaskStepsWatcher>();
const metadataByTaskId = new Map<string, TaskStepsMetadata>();
const snapshotsByTaskId = new Map<string, TaskStepsSnapshot>();
const summarySnapshotsByTaskId = new Map<string, TaskStepsSummarySnapshot>();
const taskStepsListeners = new Set<TaskStepsListener>();
const processedStepCounts = new Map<string, number>();

const CHANGE_DEBOUNCE_MS = 200;
let taskStepsStateVersion = 0;

function bumpTaskStepsStateVersion(): number {
  taskStepsStateVersion += 1;
  return taskStepsStateVersion;
}

function emitTaskStepsEvent(event: TaskStepsEvent): void {
  const stateVersion = bumpTaskStepsStateVersion();
  const versionedEvent = {
    ...event,
    stateVersion,
  };
  for (const listener of taskStepsListeners) {
    listener(versionedEvent);
  }
}

function normalizeStepText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFilesTouched(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const files = value
    .map((entry) => normalizeStepText(entry))
    .filter((entry): entry is string => entry !== undefined);
  return files.length > 0 ? [...new Set(files)] : undefined;
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalizedValue =
    value.endsWith('Z') || /[+-]\d{2}:/.test(value.slice(-6)) ? value : `${value}Z`;
  const parsed = Date.parse(normalizedValue);
  if (!isFiniteNumber(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function normalizeTaskStepEntry(entry: unknown): TaskStepEntry | null {
  if (!isRecord(entry)) {
    return null;
  }

  const summary = normalizeStepText(entry.summary);
  const detail = normalizeStepText(entry.detail);
  const next = normalizeStepText(entry.next);
  const fallbackSummary = summary ?? detail ?? next;
  if (!fallbackSummary) {
    return null;
  }

  const rawStatus = normalizeStepText(entry.status) ?? 'investigating';
  const status = isTaskStepStatus(rawStatus) ? rawStatus : 'investigating';
  const filesTouched = normalizeFilesTouched(entry.files_touched);
  const agentId = normalizeStepText(entry.agent_id);
  const timestamp = normalizeIsoTimestamp(normalizeStepText(entry.timestamp)) ?? '';

  return {
    summary: fallbackSummary,
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(next !== undefined ? { next } : {}),
    ...(filesTouched !== undefined ? { filesTouched } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    timestamp,
  };
}

function createRevisionId(
  taskId: string,
  state: TaskStepsSnapshot['state'],
  steps: ReadonlyArray<TaskStepEntry>,
  errorMessage: string | null,
): string {
  const serializedSteps = steps
    .map((step) =>
      [
        step.summary,
        step.detail ?? '',
        step.next ?? '',
        step.status,
        step.timestamp,
        step.agentId ?? '',
        (step.filesTouched ?? []).join(','),
      ].join('|'),
    )
    .join('||');

  return [taskId, state, errorMessage ?? '', `${steps.length}`, serializedSteps].join('::');
}

function createTaskStepsSnapshot(
  metadata: TaskStepsMetadata,
  state: LoadedTaskStepsState,
): TaskStepsSnapshot {
  const snapshotState = getTaskStepsSnapshotState(state);

  return {
    errorMessage: state.errorMessage,
    revisionId: createRevisionId(metadata.taskId, snapshotState, state.steps, state.errorMessage),
    state: snapshotState,
    steps: state.steps,
    taskId: metadata.taskId,
    trackingEnabled: true,
    updatedAt: Date.now(),
  };
}

function getTaskStepsSnapshotState(state: LoadedTaskStepsState): TaskStepsSnapshot['state'] {
  if (state.errorMessage !== null) {
    return 'error';
  }

  const latestStep = state.steps[state.steps.length - 1] ?? null;
  if (!latestStep) {
    return 'waiting';
  }

  return getTaskStepsSnapshotStateFromLatestStatus(latestStep.status);
}

function getTaskStepsSnapshotStateFromLatestStatus(
  latestStatus: TaskStepStatus,
): TaskStepsSnapshot['state'] {
  switch (latestStatus) {
    case 'awaiting_review':
      return 'ready';
    case 'done':
      return 'done';
    case 'implementing':
    case 'investigating':
    case 'starting':
    case 'testing':
      return 'active';
    default:
      return assertNever(latestStatus, 'Unhandled task step status');
  }
}

function createTaskStepsSummary(snapshot: TaskStepsSnapshot): TaskStepsSummarySnapshot {
  const latestStep = snapshot.steps[snapshot.steps.length - 1] ?? null;
  const nextAction = latestStep?.next ?? null;
  const preview =
    snapshot.errorMessage ??
    nextAction ??
    latestStep?.summary ??
    (snapshot.state === 'waiting' ? 'Waiting for the next step' : null);

  return {
    errorMessage: snapshot.errorMessage,
    latestStep,
    nextAction,
    preview,
    revisionId: snapshot.revisionId,
    state: snapshot.state,
    stepCount: snapshot.steps.length,
    taskId: snapshot.taskId,
    trackingEnabled: snapshot.trackingEnabled,
    updatedAt: snapshot.updatedAt,
  };
}

function areTaskStepsSummariesEqual(
  left: TaskStepsSummarySnapshot | undefined,
  right: TaskStepsSummarySnapshot,
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.revisionId === right.revisionId &&
    left.state === right.state &&
    left.updatedAt === right.updatedAt &&
    left.errorMessage === right.errorMessage &&
    left.preview === right.preview &&
    left.nextAction === right.nextAction &&
    left.stepCount === right.stepCount
  );
}

function setTaskStepsSnapshot(snapshot: TaskStepsSnapshot): void {
  const previousSnapshot = snapshotsByTaskId.get(snapshot.taskId);
  const previousSummary = summarySnapshotsByTaskId.get(snapshot.taskId);
  const nextSnapshot =
    previousSnapshot &&
    previousSnapshot.revisionId === snapshot.revisionId &&
    previousSnapshot.errorMessage === snapshot.errorMessage &&
    previousSnapshot.state === snapshot.state
      ? previousSnapshot
      : {
          ...snapshot,
          updatedAt: Date.now(),
        };
  const nextSummary = createTaskStepsSummary(nextSnapshot);

  snapshotsByTaskId.set(snapshot.taskId, nextSnapshot);
  if (areTaskStepsSummariesEqual(previousSummary, nextSummary)) {
    return;
  }

  summarySnapshotsByTaskId.set(snapshot.taskId, nextSummary);
  emitTaskStepsEvent(nextSummary);
}

function removeTaskStepsSnapshot(taskId: string): void {
  const removedSnapshot = snapshotsByTaskId.delete(taskId);
  const removedSummary = summarySnapshotsByTaskId.delete(taskId);
  if (!removedSnapshot && !removedSummary) {
    return;
  }

  emitTaskStepsEvent(createRemovedTaskStepsEvent(taskId));
}

function readStepsFileRaw(stepsFile: string): unknown[] | null {
  try {
    const raw = fs.readFileSync(stepsFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function rewriteStepsFileIfNeeded(
  stepsFile: string,
  normalizedEntries: TaskStepEntry[],
  currentRawEntries: unknown[] | null,
): void {
  if (!currentRawEntries) {
    return;
  }

  const serialized = JSON.stringify(
    normalizedEntries.map((entry) => ({
      summary: entry.summary,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      ...(entry.next !== undefined ? { next: entry.next } : {}),
      status: entry.status,
      ...(entry.filesTouched !== undefined ? { files_touched: entry.filesTouched } : {}),
      ...(entry.agentId !== undefined ? { agent_id: entry.agentId } : {}),
      timestamp: entry.timestamp,
    })),
    null,
    2,
  );

  const currentSerialized = JSON.stringify(currentRawEntries, null, 2);
  if (serialized === currentSerialized) {
    return;
  }

  fs.writeFileSync(stepsFile, `${serialized}\n`, 'utf8');
}

function loadTaskStepsState(taskId: string, stepsFile: string): LoadedTaskStepsState {
  const currentRawEntries = readStepsFileRaw(stepsFile);
  if (currentRawEntries === null) {
    processedStepCounts.delete(taskId);
    return {
      errorMessage: null,
      steps: [],
    };
  }

  const firstRun = !processedStepCounts.has(taskId);
  const previousCount = processedStepCounts.get(taskId) ?? currentRawEntries.length;
  const nowIso = new Date().toISOString();

  const normalizedEntries = currentRawEntries
    .map((entry) => normalizeTaskStepEntry(entry))
    .filter((entry): entry is TaskStepEntry => entry !== null)
    .map((entry, index) => {
      const isNewEntry = !firstRun && index >= previousCount;
      const timestamp = isNewEntry || entry.timestamp.length === 0 ? nowIso : entry.timestamp;
      return {
        ...entry,
        timestamp,
      };
    });

  processedStepCounts.set(taskId, normalizedEntries.length);
  rewriteStepsFileIfNeeded(stepsFile, normalizedEntries, currentRawEntries);

  return {
    errorMessage: null,
    steps: normalizedEntries,
  };
}

function loadTaskStepsStateSafely(taskId: string, stepsFile: string): LoadedTaskStepsState {
  try {
    return loadTaskStepsState(taskId, stepsFile);
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Failed to read steps';
    return {
      errorMessage: message,
      steps: [],
    };
  }
}

function getGitExcludePath(worktreePath: string): string | null {
  const gitPath = path.join(worktreePath, '.git');

  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return path.join(gitPath, 'info', 'exclude');
    }

    const raw = fs.readFileSync(gitPath, 'utf8').trim();
    const match = /^gitdir: (.+)$/.exec(raw);
    const gitDir = match?.[1];
    if (!gitDir) {
      return null;
    }

    const resolvedGitDir = path.isAbsolute(gitDir)
      ? gitDir
      : path.resolve(path.dirname(gitPath), gitDir);
    return path.join(resolvedGitDir, 'info', 'exclude');
  } catch {
    return null;
  }
}

function ensureStepsIgnored(worktreePath: string): void {
  const excludePath = getGitExcludePath(worktreePath);
  if (!excludePath) {
    return;
  }

  const excludeEntry = '.claude/steps.json';
  try {
    let content = '';
    if (fs.existsSync(excludePath)) {
      content = fs.readFileSync(excludePath, 'utf8');
      if (content.split('\n').some((line) => line.trim() === excludeEntry)) {
        return;
      }
    } else {
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    }

    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludePath, `${prefix}${excludeEntry}\n`, 'utf8');
  } catch (error) {
    console.warn('Failed to update git exclude for task steps:', error);
  }
}

function refreshTaskSteps(taskId: string): void {
  const metadata = metadataByTaskId.get(taskId);
  const watcher = watchers.get(taskId);
  if (!metadata || !watcher) {
    return;
  }

  const state = loadTaskStepsStateSafely(taskId, watcher.stepsFile);
  setTaskStepsSnapshot(createTaskStepsSnapshot(metadata, state));
}

function attachStepsDirectoryWatcher(
  watcher: TaskStepsWatcher,
  onChange: (event: string, filename: string | Buffer | null) => void,
): void {
  try {
    const fsWatcher = fs.watch(watcher.stepsDir, onChange);
    fsWatcher.on('error', (error) => {
      console.warn(`Task steps watcher error for ${watcher.stepsDir}:`, error);
    });
    watcher.fsWatcher = fsWatcher;
  } catch (error) {
    console.warn(`Failed to watch task steps directory ${watcher.stepsDir}:`, error);
  }
}

function normalizeTaskStepsWatcherFilename(filename: string | Buffer | null): string | null {
  if (filename === null) {
    return null;
  }

  if (typeof filename === 'string') {
    return filename;
  }

  return filename.toString('utf8');
}

function startTaskStepsWatcher(taskId: string, worktreePath: string): void {
  stopTaskStepsWatcher(taskId);
  ensureStepsIgnored(worktreePath);

  const stepsDir = path.join(worktreePath, '.claude');
  const stepsFile = path.join(stepsDir, 'steps.json');
  const watcher: TaskStepsWatcher = {
    fsWatcher: null,
    stepsDir,
    stepsFile,
    timeout: null,
    worktreePath,
  };

  const onChange = (_event: string, filename: string | Buffer | null) => {
    const normalizedFilename = normalizeTaskStepsWatcherFilename(filename);
    if (normalizedFilename !== null && normalizedFilename !== 'steps.json') {
      return;
    }

    const current = watchers.get(taskId);
    if (!current) {
      return;
    }

    if (current.timeout !== null) {
      clearTimeout(current.timeout);
    }

    current.timeout = setTimeout(() => {
      current.timeout = null;
      refreshTaskSteps(taskId);
    }, CHANGE_DEBOUNCE_MS);
  };

  if (fs.existsSync(stepsDir)) {
    attachStepsDirectoryWatcher(watcher, onChange);
  } else {
    try {
      const rootWatcher = fs.watch(worktreePath, (_event, filename) => {
        const normalizedFilename = typeof filename === 'string' ? filename : null;
        if (normalizedFilename !== '.claude' || !fs.existsSync(stepsDir)) {
          return;
        }

        rootWatcher.close();
        const current = watchers.get(taskId);
        if (!current) {
          return;
        }

        attachStepsDirectoryWatcher(current, onChange);
        refreshTaskSteps(taskId);
      });
      rootWatcher.on('error', (error) => {
        console.warn(`Task steps root watcher error for ${worktreePath}:`, error);
      });
      watcher.fsWatcher = rootWatcher;
    } catch (error) {
      console.warn(`Failed to watch task worktree root for steps ${worktreePath}:`, error);
    }
  }

  watchers.set(taskId, watcher);
  refreshTaskSteps(taskId);
}

export function stopTaskStepsWatcher(taskId: string): void {
  const watcher = watchers.get(taskId);
  if (!watcher) {
    return;
  }

  if (watcher.timeout !== null) {
    clearTimeout(watcher.timeout);
  }
  watcher.fsWatcher?.close();
  watchers.delete(taskId);
  processedStepCounts.delete(taskId);
}

type ParsedTaskStepsMetadata =
  | { kind: 'invalid' }
  | { kind: 'valid'; metadata: TaskStepsMetadata[] };

function parseTaskStepsMetadataEntry(task: unknown): TaskStepsMetadata | null | 'invalid' {
  if (!isRecord(task)) {
    return 'invalid';
  }
  if (task.stepsTracking !== true) {
    return null;
  }
  if (typeof task.id !== 'string' || typeof task.worktreePath !== 'string') {
    return 'invalid';
  }

  return {
    taskId: task.id,
    worktreePath: task.worktreePath,
  };
}

function collectTaskStepsMetadataFromSavedState(savedJson: string): ParsedTaskStepsMetadata {
  const parsed = parseSavedStateTasksRecord(savedJson);
  if (parsed.kind === 'invalid') {
    return { kind: 'invalid' };
  }
  if (parsed.kind === 'missing') {
    return { kind: 'valid', metadata: [] };
  }

  const metadata: TaskStepsMetadata[] = [];
  let invalidTaskCount = 0;
  for (const task of Object.values(parsed.tasks)) {
    const parsedTask = parseTaskStepsMetadataEntry(task);
    if (parsedTask === 'invalid') {
      invalidTaskCount += 1;
      continue;
    }
    if (parsedTask === null) {
      continue;
    }

    metadata.push(parsedTask);
  }

  if (metadata.length === 0 && invalidTaskCount > 0) {
    return { kind: 'invalid' };
  }

  return { kind: 'valid', metadata };
}

export function subscribeTaskSteps(listener: TaskStepsListener): () => void {
  taskStepsListeners.add(listener);
  return () => {
    taskStepsListeners.delete(listener);
  };
}

export function listTaskStepsSummarySnapshots(): TaskStepsSummarySnapshot[] {
  return Array.from(summarySnapshotsByTaskId.values()).sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  );
}

export function getTaskStepsStateVersion(): number {
  return taskStepsStateVersion;
}

export function getTaskStepsSnapshot(taskId: string): TaskStepsSnapshot | null {
  const snapshot = snapshotsByTaskId.get(taskId);
  if (snapshot) {
    return snapshot;
  }

  if (!metadataByTaskId.has(taskId)) {
    return null;
  }

  refreshTaskSteps(taskId);
  return snapshotsByTaskId.get(taskId) ?? null;
}

export function registerTaskStepsTask(metadata: TaskStepsMetadata): void {
  const previous = metadataByTaskId.get(metadata.taskId);
  metadataByTaskId.set(metadata.taskId, metadata);

  if (!previous) {
    startTaskStepsWatcher(metadata.taskId, metadata.worktreePath);
    return;
  }

  if (previous.worktreePath !== metadata.worktreePath) {
    startTaskStepsWatcher(metadata.taskId, metadata.worktreePath);
    return;
  }

  refreshTaskSteps(metadata.taskId);
}

function syncTaskStepsMetadata(nextMetadata: ReadonlyArray<TaskStepsMetadata>): void {
  const nextTaskIds = new Set(nextMetadata.map((metadata) => metadata.taskId));

  for (const taskId of metadataByTaskId.keys()) {
    if (nextTaskIds.has(taskId)) {
      continue;
    }

    metadataByTaskId.delete(taskId);
    stopTaskStepsWatcher(taskId);
    removeTaskStepsSnapshot(taskId);
  }

  for (const metadata of nextMetadata) {
    registerTaskStepsTask(metadata);
  }
}

export function syncTaskStepsFromSavedState(savedJson: string): void {
  const parsed = collectTaskStepsMetadataFromSavedState(savedJson);
  if (parsed.kind === 'invalid') {
    return;
  }

  syncTaskStepsMetadata(parsed.metadata);
}

export function restoreSavedTaskSteps(savedJson: string): void {
  const parsed = collectTaskStepsMetadataFromSavedState(savedJson);
  if (parsed.kind === 'invalid') {
    return;
  }

  syncTaskStepsMetadata(parsed.metadata);
  for (const metadata of parsed.metadata) {
    refreshTaskSteps(metadata.taskId);
  }
}

export function removeTaskSteps(taskId: string): void {
  metadataByTaskId.delete(taskId);
  stopTaskStepsWatcher(taskId);
  removeTaskStepsSnapshot(taskId);
}

export function stopAllTaskStepsWatchers(): void {
  for (const taskId of watchers.keys()) {
    stopTaskStepsWatcher(taskId);
  }
}

export function clearTaskStepsRegistry(): void {
  metadataByTaskId.clear();
  snapshotsByTaskId.clear();
  summarySnapshotsByTaskId.clear();
  taskStepsListeners.clear();
  processedStepCounts.clear();
}
