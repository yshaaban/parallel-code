import { batch } from 'solid-js';
import { store, setStore } from './core';
import { setActiveTask } from './navigation';

// Imperative focus registry: components register focus callbacks on mount
const focusRegistry = new Map<string, () => void>();
const actionRegistry = new Map<string, () => void>();

export function registerFocusFn(key: string, fn: () => void): void {
  focusRegistry.set(key, fn);
}

export function unregisterFocusFn(key: string): void {
  focusRegistry.delete(key);
}

export function triggerFocus(key: string): void {
  focusRegistry.get(key)?.();
}

export function registerAction(key: string, fn: () => void): void {
  actionRegistry.set(key, fn);
}

export function unregisterAction(key: string): void {
  actionRegistry.delete(key);
}

export function triggerAction(key: string): void {
  actionRegistry.get(key)?.();
}

// --- Dynamic grid-based spatial navigation ---
//
// The grid is built per-task based on its shell count:
//
//        col 0           col 1         col 2 ...
// row 0: notes               changed-files
// row 1: shell-toolbar:0     shell-toolbar:1 ... (one cell per toolbar button)
// row 2: shell:0         shell:1       shell:2   (only if shells exist)
// row 3: ai-terminal
// row 4: prompt

function getShellToolbarColumnCount(taskId: string): number {
  const task = store.tasks[taskId];
  if (!task) {
    return 1;
  }

  const bookmarkCount =
    store.projects.find((project) => project.id === task.projectId)?.terminalBookmarks?.length ?? 0;
  return 1 + bookmarkCount;
}

function getNormalizedTaskPanelId(taskId: string, panelId: string | undefined): string {
  if (!panelId) {
    return defaultPanelFor(taskId);
  }

  if (panelId === 'shell-toolbar') {
    return 'shell-toolbar:0';
  }

  if (!panelId.startsWith('shell-toolbar:')) {
    return panelId;
  }

  const parsedIndex = Number.parseInt(panelId.slice('shell-toolbar:'.length), 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return 'shell-toolbar:0';
  }

  const maxIndex = getShellToolbarColumnCount(taskId) - 1;
  return `shell-toolbar:${Math.min(parsedIndex, maxIndex)}`;
}

function buildGrid(taskId: string): string[][] {
  const task = store.tasks[taskId];
  if (task) {
    const toolbarColumns = Array.from(
      { length: getShellToolbarColumnCount(taskId) },
      (_, index) => `shell-toolbar:${index}`,
    );
    const grid: string[][] = [['title'], ['notes', 'changed-files'], toolbarColumns];
    if (task.shellAgentIds.length > 0) {
      grid.push(task.shellAgentIds.map((_, i) => `shell:${i}`));
    }
    grid.push(['ai-terminal']);
    grid.push(['prompt']);
    return grid;
  }

  // Terminal panel: just title + terminal
  return [['title'], ['terminal']];
}

/** The panel to focus when navigating into a task or terminal. */
function defaultPanelFor(panelId: string): string {
  return store.tasks[panelId] ? 'ai-terminal' : 'terminal';
}

function hasBlockingDialog(): boolean {
  return store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog;
}

interface GridPos {
  row: number;
  col: number;
}

function findInGrid(grid: string[][], cell: string): GridPos | null {
  for (let row = 0; row < grid.length; row++) {
    const gridRow = grid[row];
    if (!gridRow) continue;

    const col = gridRow.indexOf(cell);
    if (col !== -1) return { row, col };
  }
  return null;
}

export function getTaskFocusedPanel(taskId: string): string {
  return getNormalizedTaskPanelId(taskId, store.focusedPanel[taskId]);
}

export function getStoredTaskFocusedPanel(taskId: string): string | null {
  return store.focusedPanel[taskId] ?? null;
}

export function isTaskPanelFocused(taskId: string, panelId: string): boolean {
  return getTaskFocusedPanel(taskId) === getNormalizedTaskPanelId(taskId, panelId);
}

export function setTaskFocusedPanelState(taskId: string, panel: string): void {
  const normalizedPanel = getNormalizedTaskPanelId(taskId, panel);
  setStore('focusedPanel', taskId, normalizedPanel);
}

export function setTaskFocusedPanel(taskId: string, panel: string): void {
  const normalizedPanel = getNormalizedTaskPanelId(taskId, panel);
  setTaskFocusedPanelState(taskId, normalizedPanel);
  setStore('sidebarFocused', false);
  setStore('placeholderFocused', false);
  triggerFocus(`${taskId}:${normalizedPanel}`);
  scrollTaskIntoView(taskId);
}

function scrollTaskIntoView(taskId: string): void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;

  requestAnimationFrame(() => {
    const escapedTaskId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(taskId)
        : taskId.replace(/["\\]/g, '\\$&');
    const el = document.querySelector<HTMLElement>(`[data-task-id="${escapedTaskId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });
}

export function focusSidebar(): void {
  setStore('sidebarFocused', true);
  setStore('placeholderFocused', false);
  setStore('sidebarFocusedTaskId', store.activeTaskId);
  setStore('sidebarFocusedProjectId', null);
  triggerFocus('sidebar');
}

export function unfocusSidebar(): void {
  setStore('sidebarFocused', false);
  setStore('sidebarFocusedProjectId', null);
  setStore('sidebarFocusedTaskId', null);
}

export function focusPlaceholder(button?: 'add-task' | 'add-terminal'): void {
  setStore('placeholderFocused', true);
  setStore('sidebarFocused', false);
  if (button) setStore('placeholderFocusedButton', button);
  const target = button ?? store.placeholderFocusedButton;
  triggerFocus(`placeholder:${target}`);
}

export function unfocusPlaceholder(): void {
  setStore('placeholderFocused', false);
}

export function setSidebarFocusedProjectId(id: string | null): void {
  setStore('sidebarFocusedProjectId', id);
}

function focusTaskPanel(taskId: string, panel: string): void {
  const normalizedPanel = getNormalizedTaskPanelId(taskId, panel);
  batch(() => {
    setStore('focusedPanel', taskId, normalizedPanel);
    setStore('sidebarFocused', false);
    setStore('placeholderFocused', false);
    setActiveTask(taskId);
  });
  triggerFocus(`${taskId}:${normalizedPanel}`);
}

export function navigateRow(direction: 'up' | 'down'): void {
  if (hasBlockingDialog()) return;

  if (store.placeholderFocused) {
    const btn = direction === 'up' ? 'add-task' : 'add-terminal';
    setStore('placeholderFocusedButton', btn);
    triggerFocus(`placeholder:${btn}`);
    return;
  }

  if (store.sidebarFocused) {
    const { taskOrder, projects, sidebarFocusedProjectId, sidebarFocusedTaskId } = store;

    if (sidebarFocusedProjectId !== null) {
      // Project mode: navigate within projects
      const projectIdx = projects.findIndex((p) => p.id === sidebarFocusedProjectId);
      if (direction === 'up') {
        if (projectIdx > 0) {
          const previousProject = projects[projectIdx - 1];
          if (previousProject) {
            setStore('sidebarFocusedProjectId', previousProject.id);
          }
        }
        // At first project: stay put
      } else {
        if (projectIdx < projects.length - 1) {
          const nextProject = projects[projectIdx + 1];
          if (nextProject) {
            setStore('sidebarFocusedProjectId', nextProject.id);
          }
        } else if (taskOrder.length > 0) {
          // Past last project: enter task mode
          setStore('sidebarFocusedProjectId', null);
          const firstTaskId = taskOrder[0];
          if (firstTaskId) {
            setStore('sidebarFocusedTaskId', firstTaskId);
          }
        }
      }
      return;
    }

    // Task mode: navigate within tasks (highlight only, don't activate)
    if (taskOrder.length === 0 && projects.length === 0) return;
    const currentIdx = sidebarFocusedTaskId ? taskOrder.indexOf(sidebarFocusedTaskId) : -1;
    if (direction === 'up') {
      if (currentIdx <= 0 && projects.length > 0) {
        // At first task (or no task): enter project mode at last project
        setStore('sidebarFocusedTaskId', null);
        const lastProject = projects[projects.length - 1];
        if (lastProject) {
          setStore('sidebarFocusedProjectId', lastProject.id);
        }
      } else if (currentIdx > 0) {
        const previousTaskId = taskOrder[currentIdx - 1];
        if (previousTaskId) {
          setStore('sidebarFocusedTaskId', previousTaskId);
        }
      }
    } else {
      if (taskOrder.length === 0) return;
      const nextIdx = Math.min(taskOrder.length - 1, currentIdx + 1);
      const nextTaskId = taskOrder[nextIdx];
      if (nextTaskId) {
        setStore('sidebarFocusedTaskId', nextTaskId);
      }
    }
    return;
  }

  const taskId = store.activeTaskId;
  if (!taskId) return;

  const grid = buildGrid(taskId);
  const current = getTaskFocusedPanel(taskId);
  const pos = findInGrid(grid, current);
  if (!pos) return;

  const nextRow = direction === 'up' ? pos.row - 1 : pos.row + 1;
  if (nextRow < 0 || nextRow >= grid.length) return;

  // Clamp column to target row width
  const targetRow = grid[nextRow];
  if (!targetRow) return;
  const col = Math.min(pos.col, targetRow.length - 1);
  const targetPanel = targetRow[col];
  if (!targetPanel) return;
  setTaskFocusedPanel(taskId, targetPanel);
}

export function navigateColumn(direction: 'left' | 'right'): void {
  if (hasBlockingDialog()) return;

  const taskId = store.activeTaskId;

  // From placeholder
  if (store.placeholderFocused) {
    if (direction === 'left') {
      unfocusPlaceholder();
      const lastTaskId = store.taskOrder[store.taskOrder.length - 1];
      if (lastTaskId) {
        setActiveTask(lastTaskId);
        setTaskFocusedPanel(lastTaskId, getTaskFocusedPanel(lastTaskId));
      } else if (store.sidebarVisible) {
        focusSidebar();
      }
    }
    return;
  }

  // From sidebar
  if (store.sidebarFocused) {
    if (direction === 'right') {
      const targetTaskId = store.sidebarFocusedTaskId ?? taskId;
      if (targetTaskId) {
        if (targetTaskId !== store.activeTaskId) setActiveTask(targetTaskId);
        unfocusSidebar();
        setTaskFocusedPanel(targetTaskId, getTaskFocusedPanel(targetTaskId));
      }
    }
    return;
  }

  if (!taskId) return;

  const grid = buildGrid(taskId);
  const current = getTaskFocusedPanel(taskId);
  const pos = findInGrid(grid, current);
  if (!pos) return;

  const row = grid[pos.row];
  if (!row) return;
  const nextCol = direction === 'left' ? pos.col - 1 : pos.col + 1;

  // Within-row movement
  const nextPanel = row[nextCol];
  if (nextCol >= 0 && nextCol < row.length && nextPanel) {
    setTaskFocusedPanel(taskId, nextPanel);
    return;
  }

  // Cross task boundary
  const { taskOrder } = store;
  const taskIdx = taskOrder.indexOf(taskId);
  const isCurrentTerminal = !store.tasks[taskId];

  if (direction === 'left') {
    if (taskIdx === 0) {
      if (store.sidebarVisible) focusSidebar();
      return;
    }
    const prevTaskId = taskOrder[taskIdx - 1];
    if (prevTaskId) {
      if (isCurrentTerminal && store.tasks[prevTaskId]) {
        // Terminal → Task: restore last focused panel
        focusTaskPanel(prevTaskId, getTaskFocusedPanel(prevTaskId));
      } else if (!store.tasks[prevTaskId]) {
        focusTaskPanel(prevTaskId, defaultPanelFor(prevTaskId));
      } else {
        const prevGrid = buildGrid(prevTaskId);
        const prevPos = findInGrid(prevGrid, current);
        const targetRow = prevPos ? prevPos.row : pos.row;
        const safeRow = Math.min(targetRow, prevGrid.length - 1);
        const previousRow = prevGrid[safeRow];
        if (!previousRow) return;
        const lastCol = previousRow.length - 1;
        const previousPanel = previousRow[lastCol];
        if (!previousPanel) return;
        focusTaskPanel(prevTaskId, previousPanel);
      }
    }
  } else {
    const nextTaskId = taskOrder[taskIdx + 1];
    if (nextTaskId) {
      if (isCurrentTerminal && store.tasks[nextTaskId]) {
        // Terminal → Task: restore last focused panel
        focusTaskPanel(nextTaskId, getTaskFocusedPanel(nextTaskId));
      } else if (!store.tasks[nextTaskId]) {
        focusTaskPanel(nextTaskId, defaultPanelFor(nextTaskId));
      } else {
        const nextGrid = buildGrid(nextTaskId);
        const nextPos = findInGrid(nextGrid, current);
        const targetRow = nextPos ? nextPos.row : pos.row;
        const safeRow = Math.min(targetRow, nextGrid.length - 1);
        const nextRowPanels = nextGrid[safeRow];
        const nextPanelInRow = nextRowPanels?.[0];
        if (!nextPanelInRow) return;
        focusTaskPanel(nextTaskId, nextPanelInRow);
      }
    } else {
      // Past last task: focus placeholder
      focusPlaceholder('add-task');
    }
  }
}

export function setPendingAction(
  action: { type: 'close' | 'merge' | 'push'; taskId: string } | null,
): void {
  setStore('pendingAction', action);
}

export function clearPendingAction(): void {
  setStore('pendingAction', null);
}

export function toggleHelpDialog(show?: boolean): void {
  setStore('showHelpDialog', show ?? !store.showHelpDialog);
}

export function toggleSettingsDialog(show?: boolean): void {
  setStore('showSettingsDialog', show ?? !store.showSettingsDialog);
}

export function sendActivePrompt(): void {
  const taskId = store.activeTaskId;
  if (!taskId) return;
  triggerAction(`${taskId}:send-prompt`);
}
