import { IPC } from '../../electron/ipc/channels';
import {
  isLoopbackTaskPreviewHost,
  normalizeTaskPreviewHost,
  type TaskPortExposureCandidate,
  type TaskPortSnapshot,
  type TaskPortsEvent,
} from '../domain/server-state';
import { isElectronRuntime } from '../lib/browser-auth';
import { assertNever } from '../lib/assert-never';
import { invoke } from '../lib/ipc';
import {
  clearKeyedSnapshotRecordEntry,
  getKeyedSnapshotRecordEntry,
  replaceKeyedSnapshotRecord,
  setKeyedSnapshotRecordEntry,
} from '../store/keyed-snapshot-record';
import {
  createServerStateVersionTracker,
  getServerStatePayloadVersion,
  noteServerStateEventVersion,
  noteServerStateReplacement,
  resetServerStateVersionTracker,
  shouldApplyServerStateEventVersion,
  shouldApplyServerStateReplacement,
  shouldApplyServerStateSnapshotEvent,
} from '../store/server-state-versioning';
import { store } from '../store/state';

const taskPortsVersionTracker = createServerStateVersionTracker();

function normalizePreviewHost(host: string | null | undefined): string {
  const normalizedHost = normalizeTaskPreviewHost(host);
  if (!normalizedHost || !isLoopbackTaskPreviewHost(normalizedHost)) {
    return '127.0.0.1';
  }

  return normalizedHost === '::1' ? '[::1]' : normalizedHost;
}

export function applyTaskPortsEvent(event: TaskPortsEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  switch (event.kind) {
    case 'removed':
      if (
        !shouldApplyServerStateEventVersion(taskPortsVersionTracker, event.taskId, stateVersion)
      ) {
        return;
      }
      clearKeyedSnapshotRecordEntry('taskPorts', event.taskId);
      noteServerStateEventVersion(taskPortsVersionTracker, event.taskId, stateVersion);
      return;
    case 'snapshot': {
      const current = getKeyedSnapshotRecordEntry('taskPorts', event.taskId);
      if (
        !shouldApplyServerStateSnapshotEvent(
          taskPortsVersionTracker,
          event.taskId,
          stateVersion,
          current?.updatedAt,
          event.updatedAt,
        )
      ) {
        return;
      }
      setKeyedSnapshotRecordEntry('taskPorts', event.taskId, {
        exposed: event.exposed,
        observed: event.observed,
        taskId: event.taskId,
        updatedAt: event.updatedAt,
      });
      noteServerStateEventVersion(taskPortsVersionTracker, event.taskId, stateVersion);
      return;
    }
    default:
      return assertNever(event, 'Unhandled task ports event');
  }
}

export function replaceTaskPortSnapshots(
  snapshots: ReadonlyArray<TaskPortSnapshot>,
  options: { replaceVersion?: number } = {},
): void {
  if (!shouldApplyServerStateReplacement(taskPortsVersionTracker, options.replaceVersion)) {
    return;
  }

  replaceKeyedSnapshotRecord('taskPorts', snapshots, (snapshot) => snapshot.taskId);
  noteServerStateReplacement(
    taskPortsVersionTracker,
    snapshots.map((snapshot) => snapshot.taskId),
    options.replaceVersion,
  );
}

export function resetTaskPortsProjectionStateForTests(): void {
  resetServerStateVersionTracker(taskPortsVersionTracker);
}

export function getTaskPortSnapshot(taskId: string): TaskPortSnapshot | undefined {
  return getKeyedSnapshotRecordEntry('taskPorts', taskId);
}

export function getExposedTaskPort(taskId: string, port: number) {
  return store.taskPorts[taskId]?.exposed.find((entry) => entry.port === port);
}

export function getTaskPreviewCandidatePorts(taskId: string): number[] {
  const snapshot = store.taskPorts[taskId];
  if (!snapshot) {
    return [];
  }

  const exposedPorts = snapshot.exposed.map((port) => port.port);
  const exposedPortSet = new Set(exposedPorts);
  const observedPorts = snapshot.observed
    .map((port) => port.port)
    .filter((port) => !exposedPortSet.has(port));
  return [...exposedPorts, ...observedPorts];
}

export function buildTaskPreviewUrl(taskId: string, port: number): string | null {
  const snapshot = store.taskPorts[taskId];
  const exposedPort = getExposedTaskPort(taskId, port);
  const matchingPort = exposedPort ?? snapshot?.observed.find((entry) => entry.port === port);

  if (isElectronRuntime()) {
    const protocol = matchingPort?.protocol ?? 'http';
    const host = normalizePreviewHost(exposedPort?.verifiedHost ?? matchingPort?.host);
    return `${protocol}://${host}:${port}/`;
  }

  const encodedTaskId = encodeURIComponent(taskId);
  return `${window.location.origin}/_preview/${encodedTaskId}/${port}/`;
}

export async function fetchTaskPorts(): Promise<TaskPortSnapshot[]> {
  return invoke(IPC.GetTaskPorts);
}

export async function fetchTaskPortExposureCandidates(
  taskId: string,
  worktreePath: string,
): Promise<TaskPortExposureCandidate[]> {
  return invoke(IPC.GetTaskPortExposureCandidates, {
    taskId,
    worktreePath,
  });
}

export async function exposeTaskPortForTask(
  taskId: string,
  port: number,
  label?: string,
): Promise<TaskPortSnapshot> {
  return invoke(IPC.ExposePort, {
    taskId,
    port,
    ...(typeof label === 'string' ? { label } : {}),
  });
}

export async function refreshTaskPreviewForTask(
  taskId: string,
  port: number,
): Promise<TaskPortSnapshot | undefined> {
  return invoke(IPC.RefreshTaskPortPreview, {
    taskId,
    port,
  });
}

export async function unexposeTaskPortForTask(
  taskId: string,
  port: number,
): Promise<TaskPortSnapshot | undefined> {
  return invoke(IPC.UnexposePort, {
    taskId,
    port,
  });
}
