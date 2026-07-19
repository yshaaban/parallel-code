import { store, setStore, updateWindowTitle } from './core';
import { getSelectedTaskRuntimeAgentId, isTaskAiAgentId } from './task-agent-selection';

export function setActiveTaskState(id: string): void {
  const task = store.tasks[id];
  const terminal = store.terminals[id];
  if (!task && !terminal) {
    return;
  }

  const selectedAgentId = task ? getSelectedTaskRuntimeAgentId(task, store.activeAgentId) : null;
  setStore('activeTaskId', id);
  setStore('activeAgentId', selectedAgentId);
  if (task && isTaskAiAgentId(task, selectedAgentId)) {
    setStore('tasks', id, 'selectedAgentId', selectedAgentId);
  }
  updateWindowTitle(task?.name ?? terminal?.name);
}
