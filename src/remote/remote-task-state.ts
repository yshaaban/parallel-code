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
import {
  createServerStateVersionTracker,
  getServerStatePayloadVersion,
  noteServerStateEventVersion,
  noteServerStateReplacement,
  resetServerStateVersionTracker,
  shouldApplyServerStateEventVersion,
  shouldApplyServerStateReplacement,
  shouldApplyServerStateSnapshotEvent,
  stripServerStatePayloadVersion,
} from '../store/server-state-versioning';

const [agentSupervisionByAgentId, setAgentSupervisionByAgentId] = createSignal<
  Record<string, AgentSupervisionSnapshot>
>({});
const [taskPortsByTaskId, setTaskPortsByTaskId] = createSignal<Record<string, TaskPortSnapshot>>(
  {},
);
const [taskReviewByTaskId, setTaskReviewByTaskId] = createSignal<
  Record<string, TaskReviewSnapshot>
>({});

const agentSupervisionVersionTracker = createServerStateVersionTracker();
const taskPortsVersionTracker = createServerStateVersionTracker();
const taskReviewVersionTracker = createServerStateVersionTracker();

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

function toRemoteAgentSupervisionSnapshot(
  snapshot: AgentSupervisionSnapshot,
): AgentSupervisionSnapshot {
  return {
    agentId: snapshot.agentId,
    attentionReason: snapshot.attentionReason,
    isShell: snapshot.isShell,
    lastOutputAt: snapshot.lastOutputAt,
    preview: snapshot.preview,
    state: snapshot.state,
    taskId: snapshot.taskId,
    updatedAt: snapshot.updatedAt,
  };
}

function toRemoteTaskPortSnapshot(snapshot: TaskPortSnapshot): TaskPortSnapshot {
  return {
    exposed: snapshot.exposed,
    observed: snapshot.observed,
    taskId: snapshot.taskId,
    updatedAt: snapshot.updatedAt,
  };
}

export function replaceRemoteAgentSupervisionSnapshots(
  snapshots: ReadonlyArray<AgentSupervisionSnapshot>,
  version?: number,
): void {
  if (!shouldApplyServerStateReplacement(agentSupervisionVersionTracker, version)) {
    return;
  }

  const storedSnapshots = snapshots.map((snapshot) => toRemoteAgentSupervisionSnapshot(snapshot));
  setAgentSupervisionByAgentId(createSnapshotRecord(storedSnapshots, 'agentId'));
  noteServerStateReplacement(
    agentSupervisionVersionTracker,
    storedSnapshots.map((snapshot) => snapshot.agentId),
    version,
  );
}

export function applyRemoteAgentSupervisionChanged(event: AgentSupervisionEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  if (isRemovedAgentSupervisionEvent(event)) {
    if (
      !shouldApplyServerStateEventVersion(
        agentSupervisionVersionTracker,
        event.agentId,
        stateVersion,
      )
    ) {
      return;
    }
    setAgentSupervisionByAgentId((current) => omitRecordKey(current, event.agentId));
    noteServerStateEventVersion(agentSupervisionVersionTracker, event.agentId, stateVersion);
    return;
  }

  const currentSnapshot = agentSupervisionByAgentId()[event.agentId];
  if (
    !shouldApplyServerStateSnapshotEvent(
      agentSupervisionVersionTracker,
      event.agentId,
      stateVersion,
      currentSnapshot?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setAgentSupervisionByAgentId((current) => {
    return {
      ...current,
      [event.agentId]: toRemoteAgentSupervisionSnapshot(event),
    };
  });
  noteServerStateEventVersion(agentSupervisionVersionTracker, event.agentId, stateVersion);
}

export function getRemoteAgentSupervision(agentId: string): AgentSupervisionSnapshot | null {
  return agentSupervisionByAgentId()[agentId] ?? null;
}

export function replaceRemoteTaskReviewSnapshots(
  snapshots: ReadonlyArray<TaskReviewSnapshot>,
  version?: number,
): void {
  if (!shouldApplyServerStateReplacement(taskReviewVersionTracker, version)) {
    return;
  }

  setTaskReviewByTaskId(createSnapshotRecord(snapshots, 'taskId'));
  noteServerStateReplacement(
    taskReviewVersionTracker,
    snapshots.map((snapshot) => snapshot.taskId),
    version,
  );
}

export function applyRemoteTaskReviewChanged(event: TaskReviewEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  if (isRemovedTaskReviewEvent(event)) {
    if (!shouldApplyServerStateEventVersion(taskReviewVersionTracker, event.taskId, stateVersion)) {
      return;
    }
    setTaskReviewByTaskId((current) => omitRecordKey(current, event.taskId));
    noteServerStateEventVersion(taskReviewVersionTracker, event.taskId, stateVersion);
    return;
  }

  const currentSnapshot = taskReviewByTaskId()[event.taskId];
  if (
    !shouldApplyServerStateSnapshotEvent(
      taskReviewVersionTracker,
      event.taskId,
      stateVersion,
      currentSnapshot?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setTaskReviewByTaskId((current) => {
    return {
      ...current,
      [event.taskId]: stripServerStatePayloadVersion(event),
    };
  });
  noteServerStateEventVersion(taskReviewVersionTracker, event.taskId, stateVersion);
}

export function getRemoteTaskReview(taskId: string): TaskReviewSnapshot | null {
  return taskReviewByTaskId()[taskId] ?? null;
}

export function replaceRemoteTaskPortsSnapshots(
  snapshots: ReadonlyArray<TaskPortSnapshot>,
  version?: number,
): void {
  if (!shouldApplyServerStateReplacement(taskPortsVersionTracker, version)) {
    return;
  }

  const storedSnapshots = snapshots.map((snapshot) => toRemoteTaskPortSnapshot(snapshot));
  setTaskPortsByTaskId(createSnapshotRecord(storedSnapshots, 'taskId'));
  noteServerStateReplacement(
    taskPortsVersionTracker,
    storedSnapshots.map((snapshot) => snapshot.taskId),
    version,
  );
}

export function applyRemoteTaskPortsChanged(event: TaskPortsEvent): void {
  const stateVersion = getServerStatePayloadVersion(event);
  if (isRemovedTaskPortsEvent(event)) {
    if (!shouldApplyServerStateEventVersion(taskPortsVersionTracker, event.taskId, stateVersion)) {
      return;
    }
    setTaskPortsByTaskId((current) => omitRecordKey(current, event.taskId));
    noteServerStateEventVersion(taskPortsVersionTracker, event.taskId, stateVersion);
    return;
  }

  const currentSnapshot = taskPortsByTaskId()[event.taskId];
  if (
    !shouldApplyServerStateSnapshotEvent(
      taskPortsVersionTracker,
      event.taskId,
      stateVersion,
      currentSnapshot?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setTaskPortsByTaskId((current) => {
    return {
      ...current,
      [event.taskId]: toRemoteTaskPortSnapshot(event),
    };
  });
  noteServerStateEventVersion(taskPortsVersionTracker, event.taskId, stateVersion);
}

export function getRemoteTaskPorts(taskId: string): TaskPortSnapshot | null {
  return taskPortsByTaskId()[taskId] ?? null;
}

export function resetRemoteTaskStateForTests(): void {
  setAgentSupervisionByAgentId({});
  setTaskPortsByTaskId({});
  setTaskReviewByTaskId({});
  resetServerStateVersionTracker(agentSupervisionVersionTracker);
  resetServerStateVersionTracker(taskPortsVersionTracker);
  resetServerStateVersionTracker(taskReviewVersionTracker);
}
