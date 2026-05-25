import { produce } from 'solid-js/store';

import { setStore, store } from './core';
import { getSelectedTaskAgentId } from './task-agent-selection';
import type { Task, TaskTerminalLayoutMode } from './types';

const MAX_GRID_VISIBLE_AGENTS = 4;

export function getTaskTerminalLayoutMode(
  task: Pick<Task, 'terminalLayoutMode'>,
): TaskTerminalLayoutMode {
  return task.terminalLayoutMode ?? 'focused';
}

function getTaskAgentIdsSelectedFirst(
  task: Pick<Task, 'agentIds'>,
  selectedAgentId: string,
): string[] {
  return [selectedAgentId, ...task.agentIds.filter((agentId) => agentId !== selectedAgentId)];
}

function getNextSiblingAgentId(
  task: Pick<Task, 'agentIds'>,
  selectedAgentId: string,
): string | null {
  return task.agentIds.find((agentId) => agentId !== selectedAgentId) ?? null;
}

export function getTaskVisibleAiTerminalAgentIds(
  task: Task,
  preferredAgentId?: string | null,
): string[] {
  const selectedAgentId = getSelectedTaskAgentId(task, preferredAgentId);
  if (!selectedAgentId) {
    return [];
  }

  const layoutMode = getTaskTerminalLayoutMode(task);
  switch (layoutMode) {
    case 'focused':
      return [selectedAgentId];
    case 'split': {
      const siblingAgentId = getNextSiblingAgentId(task, selectedAgentId);
      return siblingAgentId ? [selectedAgentId, siblingAgentId] : [selectedAgentId];
    }
    case 'grid': {
      return getTaskAgentIdsSelectedFirst(task, selectedAgentId).slice(0, MAX_GRID_VISIBLE_AGENTS);
    }
    case 'stacked':
      return getTaskAgentIdsSelectedFirst(task, selectedAgentId);
  }
}

export function setTaskTerminalLayoutMode(
  taskId: string,
  layoutMode: TaskTerminalLayoutMode,
): void {
  if (!store.tasks[taskId]) {
    return;
  }

  setStore(
    produce((storeState) => {
      const task = storeState.tasks[taskId];
      if (!task) {
        return;
      }
      if (layoutMode === 'focused') {
        delete task.terminalLayoutMode;
        return;
      }

      task.terminalLayoutMode = layoutMode;
    }),
  );
}
