import type { PersistedTaskExposedPort } from '../../src/store/types.js';
import type {
  TaskExposedPort,
  TaskObservedPort,
  TaskPortSnapshot,
  TaskPortsEvent,
} from '../../src/domain/server-state.js';
import {
  isLoopbackTaskPreviewHost,
  normalizeTaskPreviewHost,
} from '../../src/domain/server-state.js';
import { rediscoverTaskPorts } from './port-discovery.js';
import { detectObservedPortsFromOutput } from './port-detection.js';

interface TaskPortRecord {
  exposed: Map<number, TaskExposedPort>;
  observed: Map<number, TaskObservedPort>;
  updatedAt: number;
}

type TaskPortsListener = (event: TaskPortsEvent) => void;

interface ObservedPortInput {
  host: string | null;
  port: number;
  protocol: 'http' | 'https';
  source: TaskObservedPort['source'];
  suggestion: string;
}

interface SavedTaskPortsState {
  tasks?: Record<
    string,
    {
      exposedPorts?: PersistedTaskExposedPort[];
      id?: string;
      worktreePath?: string;
    }
  >;
}

const DEFAULT_PREVIEW_TARGET_CACHE_TTL_MS = 5_000;
const DEFAULT_PREVIEW_PROBE_TIMEOUT_MS = 250;

const taskPorts = new Map<string, TaskPortRecord>();
const taskPortListeners = new Set<TaskPortsListener>();
const previewTargetCache = new Map<string, { expiresAt: number; target: string }>();
const previewValidationTokens = new Map<string, number>();
let taskPortsStateVersion = 0;

function bumpTaskPortsStateVersion(): number {
  taskPortsStateVersion += 1;
  return taskPortsStateVersion;
}

function createTaskPortRecord(): TaskPortRecord {
  return {
    exposed: new Map(),
    observed: new Map(),
    updatedAt: Date.now(),
  };
}

function getTaskPortKey(taskId: string, port: number): string {
  return `${taskId}:${port}`;
}

function getOrCreateTaskPortRecord(taskId: string): TaskPortRecord {
  let record = taskPorts.get(taskId);
  if (!record) {
    record = createTaskPortRecord();
    taskPorts.set(taskId, record);
  }
  return record;
}

function sortPortsByNumber<T extends { port: number }>(ports: Iterable<T>): T[] {
  return Array.from(ports).sort((left, right) => left.port - right.port);
}

function createTaskPortSnapshot(taskId: string, record: TaskPortRecord): TaskPortSnapshot {
  return {
    taskId,
    exposed: sortPortsByNumber(record.exposed.values()),
    observed: sortPortsByNumber(record.observed.values()),
    updatedAt: record.updatedAt,
  };
}

function emitTaskPortsEvent(event: TaskPortsEvent): void {
  bumpTaskPortsStateVersion();
  taskPortListeners.forEach((listener) => listener(event));
}

function createRemovedTaskPortsEvent(taskId: string): TaskPortsEvent {
  return {
    taskId,
    removed: true,
  };
}

function updateRecordTimestamp(record: TaskPortRecord): void {
  record.updatedAt = Date.now();
}

function emitTaskPortSnapshot(taskId: string, record: TaskPortRecord): TaskPortSnapshot {
  const snapshot = createTaskPortSnapshot(taskId, record);
  emitTaskPortsEvent(snapshot);
  return snapshot;
}

function emitRemovedTaskPorts(taskId: string): void {
  emitTaskPortsEvent(createRemovedTaskPortsEvent(taskId));
}

function hasPortRecordContent(record: TaskPortRecord): boolean {
  return record.observed.size > 0 || record.exposed.size > 0;
}

function normalizeLabel(label: string | undefined): string | null {
  if (typeof label !== 'string') {
    return null;
  }

  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeObservedHost(host: string | null | undefined): string | null {
  const normalizedHost = normalizeTaskPreviewHost(host);
  if (!normalizedHost || !isLoopbackTaskPreviewHost(normalizedHost)) {
    return null;
  }

  return normalizedHost;
}

function createObservedPort(detection: ObservedPortInput): TaskObservedPort {
  return {
    host: normalizeObservedHost(detection.host),
    port: detection.port,
    protocol: detection.protocol,
    source: detection.source,
    suggestion: detection.suggestion,
    updatedAt: Date.now(),
  };
}

function createExposedPort(
  port: number,
  options?: {
    host?: string | null;
    label?: string | null;
    protocol?: 'http' | 'https';
    source?: 'manual' | 'observed';
  },
): TaskExposedPort {
  return {
    availability: 'unknown',
    host: normalizeObservedHost(options?.host),
    label: options?.label ?? null,
    lastVerifiedAt: null,
    port,
    protocol: options?.protocol ?? 'http',
    statusMessage: null,
    source: options?.source ?? 'manual',
    updatedAt: Date.now(),
    verifiedHost: null,
  };
}

function cloneExposedPort(
  current: TaskExposedPort,
  overrides: Partial<TaskExposedPort>,
): TaskExposedPort {
  return {
    ...current,
    ...overrides,
    updatedAt: Date.now(),
  };
}

function shouldReplaceObservedPort(
  current: TaskObservedPort,
  next: Pick<TaskObservedPort, 'host' | 'port' | 'protocol' | 'suggestion' | 'source'>,
): boolean {
  return (
    current.host !== next.host ||
    current.protocol !== next.protocol ||
    current.source !== next.source ||
    current.suggestion !== next.suggestion
  );
}

function clearCachedPreviewTarget(taskId: string, port: number): void {
  previewTargetCache.delete(getTaskPortKey(taskId, port));
}

function clearPreviewTracking(taskId: string, port: number): void {
  const key = getTaskPortKey(taskId, port);
  previewTargetCache.delete(key);
  previewValidationTokens.delete(key);
}

function syncExposedPortFromObserved(
  taskId: string,
  record: TaskPortRecord,
  observedPort: TaskObservedPort,
): boolean {
  const current = record.exposed.get(observedPort.port);
  if (!current) {
    return false;
  }

  if (current.host === observedPort.host && current.protocol === observedPort.protocol) {
    return false;
  }

  record.exposed.set(
    observedPort.port,
    cloneExposedPort(current, {
      availability: 'unknown',
      host: observedPort.host,
      lastVerifiedAt: null,
      protocol: observedPort.protocol,
      statusMessage: null,
      verifiedHost: null,
    }),
  );
  clearCachedPreviewTarget(taskId, observedPort.port);
  return true;
}

function parseTargetHost(target: string): string {
  return new URL(target).hostname;
}

function formatTargetHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function getTaskPreviewTargetCandidates(
  port: Pick<TaskExposedPort, 'host' | 'port' | 'protocol' | 'verifiedHost'>,
): string[] {
  const hosts = new Set<string>();
  const verifiedHost = normalizeObservedHost(port.verifiedHost);
  if (verifiedHost) {
    hosts.add(verifiedHost);
  }

  const explicitHost = normalizeObservedHost(port.host);
  if (explicitHost) {
    hosts.add(explicitHost);
  }

  hosts.add('127.0.0.1');
  hosts.add('localhost');
  hosts.add('::1');

  return Array.from(hosts).map(
    (host) => `${port.protocol}://${formatTargetHost(host)}:${port.port}`,
  );
}

async function probePreviewTarget(target: string, timeoutMs: number): Promise<boolean> {
  const { createConnection } = await import('net');
  const { hostname, port } = new URL(target);
  const numericPort = Number.parseInt(port, 10);

  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({
      host: hostname,
      port: numericPort,
    });

    function finish(result: boolean): void {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(result);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function resolvePreviewTargetForPort(
  port: TaskExposedPort,
  timeoutMs: number,
): Promise<string | null> {
  for (const target of getTaskPreviewTargetCandidates(port)) {
    if (await probePreviewTarget(target, timeoutMs)) {
      return target;
    }
  }

  return null;
}

function getValidationToken(taskId: string, port: number): number {
  const key = getTaskPortKey(taskId, port);
  const nextToken = (previewValidationTokens.get(key) ?? 0) + 1;
  previewValidationTokens.set(key, nextToken);
  return nextToken;
}

function hasCurrentValidationToken(taskId: string, port: number, token: number): boolean {
  return previewValidationTokens.get(getTaskPortKey(taskId, port)) === token;
}

function buildUnavailablePreviewMessage(port: number): string {
  return `Preview target is not reachable on loopback port ${port}.`;
}

function updateExposedPortAvailability(
  taskId: string,
  port: number,
  nextPort: TaskExposedPort,
): TaskPortSnapshot | undefined {
  const record = taskPorts.get(taskId);
  if (!record) {
    return undefined;
  }

  const current = record.exposed.get(port);
  if (!current) {
    return undefined;
  }

  if (
    current.availability === nextPort.availability &&
    current.host === nextPort.host &&
    current.protocol === nextPort.protocol &&
    current.statusMessage === nextPort.statusMessage &&
    current.verifiedHost === nextPort.verifiedHost &&
    current.lastVerifiedAt === nextPort.lastVerifiedAt
  ) {
    return createTaskPortSnapshot(taskId, record);
  }

  record.exposed.set(port, nextPort);
  updateRecordTimestamp(record);
  return emitTaskPortSnapshot(taskId, record);
}

function parseSavedTaskPortsState(savedJson: string): SavedTaskPortsState | null {
  try {
    const parsed = JSON.parse(savedJson) as SavedTaskPortsState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function syncObservedPort(
  taskId: string,
  detection: ObservedPortInput,
  options?: { emit?: boolean },
): TaskPortSnapshot | null {
  const record = getOrCreateTaskPortRecord(taskId);
  const nextObservedPort = createObservedPort(detection);
  const currentObservedPort = record.observed.get(detection.port);
  let changed = false;

  if (!currentObservedPort) {
    record.observed.set(detection.port, nextObservedPort);
    changed = true;
  } else if (shouldReplaceObservedPort(currentObservedPort, nextObservedPort)) {
    record.observed.set(detection.port, nextObservedPort);
    changed = true;
  }

  if (syncExposedPortFromObserved(taskId, record, nextObservedPort)) {
    changed = true;
  }

  if (!changed) {
    return null;
  }

  updateRecordTimestamp(record);
  if (options?.emit === false) {
    return createTaskPortSnapshot(taskId, record);
  }

  return emitTaskPortSnapshot(taskId, record);
}

function syncSavedExposedPorts(savedState: SavedTaskPortsState): void {
  const tasks = savedState.tasks ?? {};

  for (const [taskId, task] of Object.entries(tasks)) {
    if (!Array.isArray(task.exposedPorts) || task.exposedPorts.length === 0) {
      continue;
    }

    const record = getOrCreateTaskPortRecord(taskId);
    for (const savedPort of task.exposedPorts) {
      if (
        typeof savedPort !== 'object' ||
        savedPort === null ||
        typeof savedPort.port !== 'number' ||
        !Number.isInteger(savedPort.port) ||
        savedPort.port < 1 ||
        savedPort.port > 65_535
      ) {
        continue;
      }

      record.exposed.set(
        savedPort.port,
        createExposedPort(savedPort.port, {
          label: normalizeLabel(savedPort.label ?? undefined),
          protocol: savedPort.protocol === 'https' ? 'https' : 'http',
          source: savedPort.source === 'observed' ? 'observed' : 'manual',
          ...(savedPort.host !== undefined ? { host: savedPort.host } : {}),
        }),
      );
    }

    if (record.exposed.size > 0) {
      updateRecordTimestamp(record);
    }
  }
}

function rediscoverSavedTaskPorts(savedState: SavedTaskPortsState): void {
  const tasks = savedState.tasks ?? {};
  const discoveryTargets = Object.entries(tasks)
    .map(([taskId, task]) => ({
      taskId,
      worktreePath: task.worktreePath ?? '',
    }))
    .filter((task) => task.worktreePath.length > 0);

  for (const detection of rediscoverTaskPorts(discoveryTargets)) {
    syncObservedPort(
      detection.taskId,
      {
        host: detection.host,
        port: detection.port,
        protocol: 'http',
        source: 'rediscovery',
        suggestion: detection.suggestion,
      },
      { emit: false },
    );
  }
}

export function subscribeTaskPorts(listener: TaskPortsListener): () => void {
  taskPortListeners.add(listener);
  return () => {
    taskPortListeners.delete(listener);
  };
}

export function getTaskPortSnapshots(): TaskPortSnapshot[] {
  return Array.from(taskPorts.entries())
    .map(([taskId, record]) => createTaskPortSnapshot(taskId, record))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

export function getTaskPortSnapshot(taskId: string): TaskPortSnapshot | undefined {
  const record = taskPorts.get(taskId);
  if (!record) {
    return undefined;
  }

  return createTaskPortSnapshot(taskId, record);
}

export function getTaskPortsStateVersion(): number {
  return taskPortsStateVersion;
}

export function getExposedTaskPort(taskId: string, port: number): TaskExposedPort | undefined {
  return taskPorts.get(taskId)?.exposed.get(port);
}

export function observeTaskPortsFromOutput(
  taskId: string,
  output: string,
): TaskPortSnapshot | null {
  const detections = detectObservedPortsFromOutput(output);
  if (detections.length === 0) {
    return null;
  }

  let latestSnapshot: TaskPortSnapshot | null = null;
  let shouldRevalidate = false;

  for (const detection of detections) {
    latestSnapshot =
      syncObservedPort(taskId, {
        host: detection.host,
        port: detection.port,
        protocol: detection.protocol,
        source: 'output',
        suggestion: detection.suggestion,
      }) ?? latestSnapshot;
    if (getExposedTaskPort(taskId, detection.port)) {
      shouldRevalidate = true;
    }
  }

  if (shouldRevalidate) {
    for (const detection of detections) {
      if (getExposedTaskPort(taskId, detection.port)) {
        void revalidateTaskPortPreview(taskId, detection.port);
      }
    }
  }

  return latestSnapshot;
}

export function exposeTaskPort(taskId: string, port: number, label?: string): TaskPortSnapshot {
  const record = getOrCreateTaskPortRecord(taskId);
  const observedPort = record.observed.get(port);
  const nextPort = createExposedPort(port, {
    host: observedPort?.host ?? null,
    label: normalizeLabel(label),
    protocol: observedPort?.protocol ?? 'http',
    source: observedPort ? 'observed' : 'manual',
  });

  const currentPort = record.exposed.get(port);
  if (
    currentPort &&
    currentPort.host === nextPort.host &&
    currentPort.label === nextPort.label &&
    currentPort.protocol === nextPort.protocol &&
    currentPort.source === nextPort.source
  ) {
    void revalidateTaskPortPreview(taskId, port);
    return createTaskPortSnapshot(taskId, record);
  }

  record.exposed.set(port, nextPort);
  updateRecordTimestamp(record);
  const snapshot = emitTaskPortSnapshot(taskId, record);
  void revalidateTaskPortPreview(taskId, port);
  return snapshot;
}

export async function revalidateTaskPortPreview(
  taskId: string,
  port: number,
  options?: {
    previewTargetCacheTtlMs?: number;
    previewTargetProbeTimeoutMs?: number;
  },
): Promise<TaskPortSnapshot | undefined> {
  const record = taskPorts.get(taskId);
  const exposedPort = record?.exposed.get(port);
  if (!record || !exposedPort) {
    return record ? createTaskPortSnapshot(taskId, record) : undefined;
  }

  clearCachedPreviewTarget(taskId, port);
  const validationToken = getValidationToken(taskId, port);
  const timeoutMs = options?.previewTargetProbeTimeoutMs ?? DEFAULT_PREVIEW_PROBE_TIMEOUT_MS;
  const target = await resolvePreviewTargetForPort(exposedPort, timeoutMs);
  if (!hasCurrentValidationToken(taskId, port, validationToken)) {
    return getTaskPortSnapshot(taskId);
  }

  const currentPort = taskPorts.get(taskId)?.exposed.get(port);
  if (!currentPort) {
    return getTaskPortSnapshot(taskId);
  }

  const now = Date.now();
  if (!target) {
    clearCachedPreviewTarget(taskId, port);
    return updateExposedPortAvailability(
      taskId,
      port,
      cloneExposedPort(currentPort, {
        availability: 'unavailable',
        lastVerifiedAt: now,
        statusMessage: buildUnavailablePreviewMessage(port),
        verifiedHost: null,
      }),
    );
  }

  const cacheTtlMs = options?.previewTargetCacheTtlMs ?? DEFAULT_PREVIEW_TARGET_CACHE_TTL_MS;
  previewTargetCache.set(getTaskPortKey(taskId, port), {
    expiresAt: now + cacheTtlMs,
    target,
  });
  return updateExposedPortAvailability(
    taskId,
    port,
    cloneExposedPort(currentPort, {
      availability: 'available',
      lastVerifiedAt: now,
      statusMessage: null,
      verifiedHost: parseTargetHost(target),
    }),
  );
}

export async function resolveTaskPreviewTarget(
  taskId: string,
  port: number,
  options?: {
    previewTargetCacheTtlMs?: number;
    previewTargetProbeTimeoutMs?: number;
  },
): Promise<string | null> {
  const cacheKey = getTaskPortKey(taskId, port);
  const cachedTarget = previewTargetCache.get(cacheKey);
  if (cachedTarget && cachedTarget.expiresAt > Date.now()) {
    return cachedTarget.target;
  }

  const exposedPort = getExposedTaskPort(taskId, port);
  if (!exposedPort) {
    return null;
  }

  const cacheTtlMs = options?.previewTargetCacheTtlMs ?? DEFAULT_PREVIEW_TARGET_CACHE_TTL_MS;
  if (
    exposedPort.availability === 'available' &&
    exposedPort.verifiedHost &&
    exposedPort.lastVerifiedAt &&
    exposedPort.lastVerifiedAt + cacheTtlMs > Date.now()
  ) {
    const target = `${exposedPort.protocol}://${formatTargetHost(exposedPort.verifiedHost)}:${port}`;
    previewTargetCache.set(cacheKey, {
      expiresAt: exposedPort.lastVerifiedAt + cacheTtlMs,
      target,
    });
    return target;
  }

  await revalidateTaskPortPreview(taskId, port, options);
  return previewTargetCache.get(cacheKey)?.target ?? null;
}

export function markTaskPreviewUnavailable(
  taskId: string,
  port: number,
): TaskPortSnapshot | undefined {
  const current = getExposedTaskPort(taskId, port);
  if (!current) {
    return undefined;
  }

  clearCachedPreviewTarget(taskId, port);
  return updateExposedPortAvailability(
    taskId,
    port,
    cloneExposedPort(current, {
      availability: 'unavailable',
      lastVerifiedAt: Date.now(),
      statusMessage: buildUnavailablePreviewMessage(port),
      verifiedHost: null,
    }),
  );
}

export function restoreSavedTaskPorts(savedJson: string): void {
  const savedState = parseSavedTaskPortsState(savedJson);
  if (!savedState) {
    return;
  }

  clearTaskPortRegistry();
  syncSavedExposedPorts(savedState);
  rediscoverSavedTaskPorts(savedState);
  bumpTaskPortsStateVersion();

  for (const snapshot of getTaskPortSnapshots()) {
    for (const port of snapshot.exposed) {
      void revalidateTaskPortPreview(snapshot.taskId, port.port);
    }
  }
}

export function unexposeTaskPort(taskId: string, port: number): TaskPortSnapshot | undefined {
  const record = taskPorts.get(taskId);
  if (!record || !record.exposed.delete(port)) {
    return record ? createTaskPortSnapshot(taskId, record) : undefined;
  }

  clearPreviewTracking(taskId, port);
  if (!hasPortRecordContent(record)) {
    taskPorts.delete(taskId);
    emitRemovedTaskPorts(taskId);
    return undefined;
  }

  updateRecordTimestamp(record);
  return emitTaskPortSnapshot(taskId, record);
}

export function removeTaskPorts(taskId: string): void {
  const record = taskPorts.get(taskId);
  if (!record) {
    return;
  }

  for (const port of record.exposed.keys()) {
    clearPreviewTracking(taskId, port);
  }
  taskPorts.delete(taskId);
  emitRemovedTaskPorts(taskId);
}

export function clearTaskPortRegistry(): void {
  if (taskPorts.size === 0 && previewTargetCache.size === 0 && previewValidationTokens.size === 0) {
    return;
  }

  taskPorts.clear();
  previewTargetCache.clear();
  previewValidationTokens.clear();
  bumpTaskPortsStateVersion();
}
