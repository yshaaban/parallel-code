import { store, setStore, updateWindowTitle } from './core';
import { getSelectedTaskAgentId } from './task-agent-selection';

export function setActiveTaskState(id: string): void {
  const task = store.tasks[id];
  const terminal = store.terminals[id];
  if (!task && !terminal) {
    return;
  }

  const selectedAgentId = task ? getSelectedTaskAgentId(task, store.activeAgentId) : null;
  setStore('activeTaskId', id);
  setStore('activeAgentId', selectedAgentId);
  if (task && selectedAgentId) {
    setStore('tasks', id, 'selectedAgentId', selectedAgentId);
  }
  updateWindowTitle(task?.name ?? terminal?.name);
}
