import {
  isRemovedAgentSupervisionEvent,
  type AgentSupervisionEvent,
  type AgentSupervisionSnapshot,
} from '../domain/server-state';
import { store } from '../store/state';
import {
  getTaskAttentionEntry,
  getTaskAttentionPriority,
  type TaskAttentionEntry,
} from './task-presentation-status';
export type { TaskAttentionEntry } from './task-presentation-status';
import {
  clearKeyedSnapshotRecordEntries,
  clearKeyedSnapshotRecordEntry,
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

const agentSupervisionVersionTracker = createServerStateVersionTracker();

function toStoredAgentSupervisionSnapshot(
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

export function applyAgentSupervisionEvent(event: AgentSupervisionEvent): void {
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
    clearKeyedSnapshotRecordEntry('agentSupervision', event.agentId);
    noteServerStateEventVersion(agentSupervisionVersionTracker, event.agentId, stateVersion);
    return;
  }

  const current = store.agentSupervision[event.agentId];
  if (
    !shouldApplyServerStateSnapshotEvent(
      agentSupervisionVersionTracker,
      event.agentId,
      stateVersion,
      current?.updatedAt,
      event.updatedAt,
    )
  ) {
    return;
  }

  setKeyedSnapshotRecordEntry(
    'agentSupervision',
    event.agentId,
    toStoredAgentSupervisionSnapshot(event),
  );
  noteServerStateEventVersion(agentSupervisionVersionTracker, event.agentId, stateVersion);
}

export function replaceAgentSupervisionSnapshots(
  snapshots: ReadonlyArray<AgentSupervisionSnapshot>,
  options: { replaceVersion?: number } = {},
): void {
  if (!shouldApplyServerStateReplacement(agentSupervisionVersionTracker, options.replaceVersion)) {
    return;
  }

  replaceKeyedSnapshotRecord(
    'agentSupervision',
    snapshots.map((snapshot) => toStoredAgentSupervisionSnapshot(snapshot)),
    (snapshot) => snapshot.agentId,
  );
  noteServerStateReplacement(
    agentSupervisionVersionTracker,
    snapshots.map((snapshot) => snapshot.agentId),
    options.replaceVersion,
  );
}

export function clearAgentSupervisionSnapshots(agentIds: string[]): void {
  if (agentIds.length === 0) {
    return;
  }

  clearKeyedSnapshotRecordEntries('agentSupervision', agentIds);
}

export function getTaskAttentionEntries(): TaskAttentionEntry[] {
  const entries = Object.keys(store.tasks)
    .map((taskId) => getTaskAttentionEntry(taskId))
    .filter((entry): entry is TaskAttentionEntry => entry !== null);

  return entries.sort((left, right) => {
    const priorityDelta =
      getTaskAttentionPriority(left.reason) - getTaskAttentionPriority(right.reason);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return right.updatedAt - left.updatedAt;
  });
}

export function getTaskAttentionFocusPanel(
  entry: TaskAttentionEntry,
): TaskAttentionEntry['focusPanel'] {
  return entry.focusPanel;
}

export function resetAgentSupervisionProjectionStateForTests(): void {
  resetServerStateVersionTracker(agentSupervisionVersionTracker);
}
