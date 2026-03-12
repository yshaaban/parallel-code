import type {
  TaskExposedPort,
  TaskObservedPort,
  TaskPortSnapshot,
  TaskPortsEvent,
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
  taskPortListeners.forEach((listener) => listener(event));
}

function updateRecordTimestamp(record: TaskPortRecord): void {
  record.updatedAt = Date.now();
}

function emitTaskPortSnapshot(taskId: string, record: TaskPortRecord): TaskPortSnapshot {
  const snapshot = createTaskPortSnapshot(taskId, record);
  emitTaskPortsEvent(snapshot);
  return snapshot;
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
    if (record.observed.has(detection.port)) {
      continue;
    }

    record.observed.set(detection.port, {
      port: detection.port,
      protocol: 'http',
      source: 'output',
      suggestion: detection.suggestion,
      updatedAt: Date.now(),
    });
    changed = true;
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
    port,
    protocol: 'http',
    source: observedPort ? 'observed' : 'manual',
    label: normalizeLabel(label),
    updatedAt: Date.now(),
  };

  const currentPort = record.exposed.get(port);
  if (
    currentPort &&
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
    emitTaskPortsEvent({ taskId, removed: true });
    return undefined;
  }

  updateRecordTimestamp(record);
  return emitTaskPortSnapshot(taskId, record);
}

export function removeTaskPorts(taskId: string): void {
  if (!taskPorts.delete(taskId)) {
    return;
  }

  emitTaskPortsEvent({
    taskId,
    removed: true,
  });
}

export function clearTaskPortRegistry(): void {
  taskPorts.clear();
}
