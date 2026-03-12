import { isRemovedAgentSupervisionEvent, type AgentSupervisionEvent } from '../domain/server-state';
import { isHydraAgentDef } from '../lib/hydra';
import { setStore, store } from '../store/core';
import type { PanelId } from '../store/types';

export interface TaskAttentionEntry {
  agentId: string;
  group: 'needs-action' | 'quiet' | 'ready';
  label: string;
  lastOutputAt: number | null;
  preview: string;
  reason:
    | 'failed'
    | 'flow-controlled'
    | 'paused'
    | 'quiet-too-long'
    | 'ready-for-next-step'
    | 'restoring'
    | 'waiting-input';
  state: Exclude<AgentSupervisionEvent, { removed: true }>['state'];
  taskId: string;
  updatedAt: number;
}

function deleteRecordEntry<T>(record: Record<string, T>, key: string): void {
  Reflect.deleteProperty(record, key);
}

function getAttentionGroup(reason: TaskAttentionEntry['reason']): TaskAttentionEntry['group'] {
  switch (reason) {
    case 'ready-for-next-step':
      return 'ready';
    case 'quiet-too-long':
      return 'quiet';
    default:
      return 'needs-action';
  }
}

function getAttentionLabel(reason: TaskAttentionEntry['reason']): string {
  switch (reason) {
    case 'failed':
      return 'Failed';
    case 'flow-controlled':
      return 'Flow controlled';
    case 'paused':
      return 'Paused';
    case 'quiet-too-long':
      return 'Quiet';
    case 'ready-for-next-step':
      return 'Ready';
    case 'restoring':
      return 'Restoring';
    case 'waiting-input':
      return 'Waiting';
    default:
      return 'Attention';
  }
}

function getAttentionPriority(reason: TaskAttentionEntry['reason']): number {
  switch (reason) {
    case 'failed':
      return 0;
    case 'waiting-input':
      return 1;
    case 'flow-controlled':
      return 2;
    case 'paused':
      return 3;
    case 'restoring':
      return 4;
    case 'ready-for-next-step':
      return 5;
    case 'quiet-too-long':
      return 6;
    default:
      return 99;
  }
}

function isHigherPriority(next: TaskAttentionEntry, current: TaskAttentionEntry): boolean {
  const nextPriority = getAttentionPriority(next.reason);
  const currentPriority = getAttentionPriority(current.reason);
  if (nextPriority !== currentPriority) {
    return nextPriority < currentPriority;
  }

  return next.updatedAt > current.updatedAt;
}

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
  const attentionByTask = new Map<string, TaskAttentionEntry>();

  for (const snapshot of Object.values(store.agentSupervision)) {
    if (snapshot.isShell || !store.tasks[snapshot.taskId] || !snapshot.attentionReason) {
      continue;
    }

    const nextEntry: TaskAttentionEntry = {
      agentId: snapshot.agentId,
      group: getAttentionGroup(snapshot.attentionReason),
      label: getAttentionLabel(snapshot.attentionReason),
      lastOutputAt: snapshot.lastOutputAt,
      preview: snapshot.preview,
      reason: snapshot.attentionReason,
      state: snapshot.state,
      taskId: snapshot.taskId,
      updatedAt: snapshot.updatedAt,
    };

    const currentEntry = attentionByTask.get(snapshot.taskId);
    if (!currentEntry || isHigherPriority(nextEntry, currentEntry)) {
      attentionByTask.set(snapshot.taskId, nextEntry);
    }
  }

  return Array.from(attentionByTask.values()).sort((left, right) => {
    const priorityDelta = getAttentionPriority(left.reason) - getAttentionPriority(right.reason);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return right.updatedAt - left.updatedAt;
  });
}

export function getTaskAttentionFocusPanel(entry: TaskAttentionEntry): PanelId {
  if (entry.reason === 'ready-for-next-step') {
    const agent = store.agents[entry.agentId];
    if (agent && !isHydraAgentDef(agent.def)) {
      return 'prompt';
    }
  }

  return 'ai-terminal';
}
