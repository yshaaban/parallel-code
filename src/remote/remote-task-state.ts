import { createSignal } from 'solid-js';
import {
  isRemovedAgentSupervisionEvent,
  isRemovedTaskPortsEvent,
  type AgentSupervisionEvent,
  type AgentSupervisionSnapshot,
  type TaskPortSnapshot,
  type TaskPortsEvent,
} from '../domain/server-state';
import {
  isRemovedTaskReviewEvent,
  type TaskReviewEvent,
  type TaskReviewSnapshot,
} from '../domain/task-review';
import { omitRecordKey } from '../lib/record-utils';

const [agentSupervisionByAgentId, setAgentSupervisionByAgentId] = createSignal<
  Record<string, AgentSupervisionSnapshot>
>({});
const [taskPortsByTaskId, setTaskPortsByTaskId] = createSignal<Record<string, TaskPortSnapshot>>(
  {},
);
const [taskReviewByTaskId, setTaskReviewByTaskId] = createSignal<
  Record<string, TaskReviewSnapshot>
>({});

let agentSupervisionReplaceVersion = -1;
let taskPortsReplaceVersion = -1;
let taskReviewReplaceVersion = -1;

function shouldApplyReplaceVersion(
  version: number | undefined,
  currentVersion: number,
): version is number {
  return typeof version === 'number' && Number.isFinite(version) && version >= currentVersion;
}

function createSnapshotRecord<
  Snapshot extends { [Key in Property]: string },
  Property extends keyof Snapshot,
>(snapshots: ReadonlyArray<Snapshot>, key: Property): Record<string, Snapshot> {
  const nextRecord: Record<string, Snapshot> = {};

  for (const snapshot of snapshots) {
    nextRecord[snapshot[key]] = snapshot;
  }

  return nextRecord;
}

function shouldApplySnapshotUpdate(
  currentUpdatedAt: number | undefined,
  nextUpdatedAt: number,
): boolean {
  return currentUpdatedAt === undefined || nextUpdatedAt >= currentUpdatedAt;
}

export function replaceRemoteAgentSupervisionSnapshots(
  snapshots: ReadonlyArray<AgentSupervisionSnapshot>,
  version?: number,
): void {
  if (
    version !== undefined &&
    !shouldApplyReplaceVersion(version, agentSupervisionReplaceVersion)
  ) {
    return;
  }
  if (shouldApplyReplaceVersion(version, agentSupervisionReplaceVersion)) {
    agentSupervisionReplaceVersion = version;
  }

  setAgentSupervisionByAgentId(createSnapshotRecord(snapshots, 'agentId'));
}

export function applyRemoteAgentSupervisionChanged(event: AgentSupervisionEvent): void {
  if (isRemovedAgentSupervisionEvent(event)) {
    setAgentSupervisionByAgentId((current) => omitRecordKey(current, event.agentId));
    return;
  }

  setAgentSupervisionByAgentId((current) => {
    const currentSnapshot = current[event.agentId];
    if (!shouldApplySnapshotUpdate(currentSnapshot?.updatedAt, event.updatedAt)) {
      return current;
    }

    return {
      ...current,
      [event.agentId]: event,
    };
  });
}

export function getRemoteAgentSupervision(agentId: string): AgentSupervisionSnapshot | null {
  return agentSupervisionByAgentId()[agentId] ?? null;
}

export function replaceRemoteTaskReviewSnapshots(
  snapshots: ReadonlyArray<TaskReviewSnapshot>,
  version?: number,
): void {
  if (version !== undefined && !shouldApplyReplaceVersion(version, taskReviewReplaceVersion)) {
    return;
  }
  if (shouldApplyReplaceVersion(version, taskReviewReplaceVersion)) {
    taskReviewReplaceVersion = version;
  }

  setTaskReviewByTaskId(createSnapshotRecord(snapshots, 'taskId'));
}

export function applyRemoteTaskReviewChanged(event: TaskReviewEvent): void {
  if (isRemovedTaskReviewEvent(event)) {
    setTaskReviewByTaskId((current) => omitRecordKey(current, event.taskId));
    return;
  }

  setTaskReviewByTaskId((current) => {
    const currentSnapshot = current[event.taskId];
    if (!shouldApplySnapshotUpdate(currentSnapshot?.updatedAt, event.updatedAt)) {
      return current;
    }

    return {
      ...current,
      [event.taskId]: event,
    };
  });
}

export function getRemoteTaskReview(taskId: string): TaskReviewSnapshot | null {
  return taskReviewByTaskId()[taskId] ?? null;
}

export function replaceRemoteTaskPortsSnapshots(
  snapshots: ReadonlyArray<TaskPortSnapshot>,
  version?: number,
): void {
  if (version !== undefined && !shouldApplyReplaceVersion(version, taskPortsReplaceVersion)) {
    return;
  }
  if (shouldApplyReplaceVersion(version, taskPortsReplaceVersion)) {
    taskPortsReplaceVersion = version;
  }

  setTaskPortsByTaskId(createSnapshotRecord(snapshots, 'taskId'));
}

export function applyRemoteTaskPortsChanged(event: TaskPortsEvent): void {
  if (isRemovedTaskPortsEvent(event)) {
    setTaskPortsByTaskId((current) => omitRecordKey(current, event.taskId));
    return;
  }

  setTaskPortsByTaskId((current) => {
    const currentSnapshot = current[event.taskId];
    if (!shouldApplySnapshotUpdate(currentSnapshot?.updatedAt, event.updatedAt)) {
      return current;
    }

    return {
      ...current,
      [event.taskId]: event,
    };
  });
}

export function getRemoteTaskPorts(taskId: string): TaskPortSnapshot | null {
  return taskPortsByTaskId()[taskId] ?? null;
}

export function resetRemoteTaskStateForTests(): void {
  setAgentSupervisionByAgentId({});
  setTaskPortsByTaskId({});
  setTaskReviewByTaskId({});
  agentSupervisionReplaceVersion = -1;
  taskPortsReplaceVersion = -1;
  taskReviewReplaceVersion = -1;
}
