import type { Task } from './types.js';

export function isTaskAiAgentId(
  task: Pick<Task, 'agentIds'>,
  agentId: string | null | undefined,
): agentId is string {
  return typeof agentId === 'string' && task.agentIds.includes(agentId);
}

export function isTaskRuntimeAgentId(
  task: Pick<Task, 'agentIds' | 'shellAgentIds'>,
  agentId: string | null | undefined,
): agentId is string {
  return (
    typeof agentId === 'string' &&
    (task.agentIds.includes(agentId) || task.shellAgentIds.includes(agentId))
  );
}

export function getSelectedTaskAgentId(
  task: Pick<Task, 'agentIds' | 'selectedAgentId'>,
  preferredAgentId?: string | null,
): string | null {
  if (isTaskAiAgentId(task, preferredAgentId)) {
    return preferredAgentId;
  }

  if (isTaskAiAgentId(task, task.selectedAgentId)) {
    return task.selectedAgentId;
  }

  return task.agentIds[0] ?? null;
}

export function getSelectedTaskRuntimeAgentId(
  task: Pick<Task, 'agentIds' | 'selectedAgentId' | 'shellAgentIds'>,
  preferredAgentId?: string | null,
): string | null {
  if (isTaskRuntimeAgentId(task, preferredAgentId)) {
    return preferredAgentId;
  }

  return getSelectedTaskAgentId(task) ?? task.shellAgentIds[0] ?? null;
}
