import { isRemovedAgentSupervisionEvent, type AgentSupervisionEvent } from '../domain/server-state';
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

export function applyAgentSupervisionEvent(event: AgentSupervisionEvent): void {
  if (isRemovedAgentSupervisionEvent(event)) {
    clearKeyedSnapshotRecordEntry('agentSupervision', event.agentId);
    return;
  }

  setKeyedSnapshotRecordEntry('agentSupervision', event.agentId, event);
}

export function replaceAgentSupervisionSnapshots(
  snapshots: ReadonlyArray<Exclude<AgentSupervisionEvent, { removed: true }>>,
): void {
  replaceKeyedSnapshotRecord('agentSupervision', snapshots, (snapshot) => snapshot.agentId);
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
