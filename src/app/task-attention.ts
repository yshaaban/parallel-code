import { isRemovedAgentSupervisionEvent, type AgentSupervisionEvent } from '../domain/server-state';
import { setStore, store } from '../store/core';
import {
  getTaskAttentionEntry,
  getTaskAttentionPriority,
  type TaskAttentionEntry,
} from './task-presentation-status';
export type { TaskAttentionEntry } from './task-presentation-status';
import { deleteRecordEntry } from '../store/record-utils';

export function applyAgentSupervisionEvent(event: AgentSupervisionEvent): void {
  if (isRemovedAgentSupervisionEvent(event)) {
    setStore('agentSupervision', (snapshots) => {
      const next = { ...snapshots };
      deleteRecordEntry(next, event.agentId);
      return next;
    });
    return;
  }

  setStore('agentSupervision', event.agentId, event);
}

export function replaceAgentSupervisionSnapshots(
  snapshots: ReadonlyArray<Exclude<AgentSupervisionEvent, { removed: true }>>,
): void {
  setStore('agentSupervision', () =>
    Object.fromEntries(snapshots.map((snapshot) => [snapshot.agentId, snapshot])),
  );
}

export function clearAgentSupervisionSnapshots(agentIds: string[]): void {
  if (agentIds.length === 0) {
    return;
  }

  setStore('agentSupervision', (snapshots) => {
    const next = { ...snapshots };
    for (const agentId of agentIds) {
      deleteRecordEntry(next, agentId);
    }
    return next;
  });
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
