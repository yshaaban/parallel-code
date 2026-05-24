import { store, setStore, updateWindowTitle } from './core';
import { getTaskFocusedPanel, setTaskFocusedPanel } from './focus';
import { getSelectedTaskAgentId } from './task-agent-selection';
import { reorderTask } from './tasks';

export function setActiveTask(id: string): void {
  const task = store.tasks[id];
  const terminal = store.terminals[id];
  if (!task && !terminal) return;
  const selectedAgentId = task ? getSelectedTaskAgentId(task, store.activeAgentId) : null;
  setStore('activeTaskId', id);
  setStore('activeAgentId', selectedAgentId);
  if (task && selectedAgentId) {
    setStore('tasks', id, 'selectedAgentId', selectedAgentId);
  }
  updateWindowTitle(task?.name ?? terminal?.name);
}

export function setActiveAgent(agentId: string): void {
  setStore('activeAgentId', agentId);
  const taskId = store.agents[agentId]?.taskId ?? store.activeTaskId;
  const task = taskId ? store.tasks[taskId] : undefined;
  if (taskId && task?.agentIds.includes(agentId)) {
    setStore('tasks', taskId, 'selectedAgentId', agentId);
  }
}

export function navigateAgent(direction: 'up' | 'down'): void {
  const { activeTaskId, activeAgentId } = store;
  if (!activeTaskId) return;
  const task = store.tasks[activeTaskId];
  if (!task) return;
  const idx = activeAgentId ? task.agentIds.indexOf(activeAgentId) : -1;
  const next =
    direction === 'up' ? Math.max(0, idx - 1) : Math.min(task.agentIds.length - 1, idx + 1);
  const nextAgentId = task.agentIds[next];
  if (!nextAgentId) return;
  setStore('activeAgentId', nextAgentId);
  setStore('tasks', activeTaskId, 'selectedAgentId', nextAgentId);
}

export function moveActiveTask(direction: 'left' | 'right'): void {
  const { taskOrder, activeTaskId } = store;
  if (!activeTaskId || taskOrder.length < 2) return;
  const idx = taskOrder.indexOf(activeTaskId);
  if (idx === -1) return;
  const target = direction === 'left' ? idx - 1 : idx + 1;
  if (target < 0 || target >= taskOrder.length) return;
  reorderTask(idx, target);
  setTaskFocusedPanel(activeTaskId, getTaskFocusedPanel(activeTaskId));
}

export function jumpToTask(index: number): void {
  const nextTaskId = store.taskOrder[index];
  if (!nextTaskId) return;
  setActiveTask(nextTaskId);
  setTaskFocusedPanel(nextTaskId, getTaskFocusedPanel(nextTaskId));
}

export function toggleNewTaskDialog(show?: boolean): void {
  const shouldShow = show ?? !store.showNewTaskDialog;
  if (!shouldShow) {
    setStore('newTaskDropUrl', null);
    setStore('newTaskPrefillPrompt', null);
  }
  setStore('showNewTaskDialog', shouldShow);
}
