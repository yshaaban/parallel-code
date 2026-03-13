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
import { detectObservedPortsFromOutput } from './port-detection.js';

interface TaskPortRecord {
  exposed: Map<number, TaskExposedPort>;
  observed: Map<number, TaskObservedPort>;
  updatedAt: number;
}

type TaskPortsListener = (event: TaskPortsEvent) => void;

const taskPorts = new Map<string, TaskPortRecord>();
const taskPortListeners = new Set<TaskPortsListener>();
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

function shouldReplaceObservedPort(
  current: TaskObservedPort,
  next: Pick<TaskObservedPort, 'host' | 'port' | 'protocol' | 'suggestion'>,
): boolean {
  return (
    current.host !== next.host ||
    current.protocol !== next.protocol ||
    current.suggestion !== next.suggestion
  );
}

function createObservedPort(
  detection: ReturnType<typeof detectObservedPortsFromOutput>[number],
): TaskObservedPort {
  const normalizedHost = isLoopbackTaskPreviewHost(detection.host)
    ? normalizeTaskPreviewHost(detection.host)
    : null;

  return {
    host: normalizedHost,
    port: detection.port,
    protocol: detection.protocol,
    source: 'output',
    suggestion: detection.suggestion,
    updatedAt: Date.now(),
  };
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

  const record = getOrCreateTaskPortRecord(taskId);
  let changed = false;

  for (const detection of detections) {
    const nextObservedPort = createObservedPort(detection);
    const currentObservedPort = record.observed.get(detection.port);
    if (!currentObservedPort) {
      record.observed.set(detection.port, nextObservedPort);
      changed = true;
      continue;
    }

    if (shouldReplaceObservedPort(currentObservedPort, nextObservedPort)) {
      record.observed.set(detection.port, nextObservedPort);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  updateRecordTimestamp(record);
  return emitTaskPortSnapshot(taskId, record);
}

export function exposeTaskPort(taskId: string, port: number, label?: string): TaskPortSnapshot {
  const record = getOrCreateTaskPortRecord(taskId);
  const observedPort = record.observed.get(port);
  const nextPort: TaskExposedPort = {
    host: observedPort?.host ?? null,
    port,
    protocol: observedPort?.protocol ?? 'http',
    source: observedPort ? 'observed' : 'manual',
    label: normalizeLabel(label),
    updatedAt: Date.now(),
  };

  const currentPort = record.exposed.get(port);
  if (
    currentPort &&
    currentPort.host === nextPort.host &&
    currentPort.label === nextPort.label &&
    currentPort.protocol === nextPort.protocol &&
    currentPort.source === nextPort.source
  ) {
    return createTaskPortSnapshot(taskId, record);
  }

  record.exposed.set(port, nextPort);
  updateRecordTimestamp(record);
  return emitTaskPortSnapshot(taskId, record);
}

export function unexposeTaskPort(taskId: string, port: number): TaskPortSnapshot | undefined {
  const record = taskPorts.get(taskId);
  if (!record || !record.exposed.delete(port)) {
    return record ? createTaskPortSnapshot(taskId, record) : undefined;
  }

  if (!hasPortRecordContent(record)) {
    taskPorts.delete(taskId);
    emitRemovedTaskPorts(taskId);
    return undefined;
  }

  updateRecordTimestamp(record);
  return emitTaskPortSnapshot(taskId, record);
}

export function removeTaskPorts(taskId: string): void {
  if (!taskPorts.delete(taskId)) {
    return;
  }

  emitRemovedTaskPorts(taskId);
}

export function clearTaskPortRegistry(): void {
  if (taskPorts.size === 0) {
    return;
  }

  taskPorts.clear();
  bumpTaskPortsStateVersion();
}
