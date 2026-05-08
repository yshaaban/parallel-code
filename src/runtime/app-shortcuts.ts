import { closeMarkdownViewer } from '../app/markdown-viewer';
import { openNewTaskDialog } from '../app/new-task-dialog-workflows';
import { initShortcuts, registerShortcut } from '../lib/shortcuts';
import {
  getTaskFocusedPanel,
  navigateColumn,
  navigateRow,
  navigateTask,
  sendActivePrompt,
  setPendingAction,
  toggleHelpDialog,
  toggleSettingsDialog,
} from '../store/focus';
import { jumpToTask, moveActiveTask, toggleNewTaskDialog } from '../store/navigation';
import { store } from '../store/state';
import { closeTerminal, createTerminal } from '../store/terminals';
import { showNotification } from '../store/notification';
import { adjustGlobalScale, resetFontScale, resetGlobalScale, toggleSidebar } from '../store/ui';
import { closeShell, spawnShellForTask } from '../app/task-shell-workflows';
import type { KeybindingActionId } from '../domain/keybindings';

function handleShellShortcutFailure(action: string, error: unknown): void {
  console.warn(`Failed to ${action}:`, error);
  showNotification(`Failed to ${action}`);
}

function getFocusedShellId(): { shellId: string; taskId: string } | null {
  const taskId = store.activeTaskId;
  if (!taskId) {
    return null;
  }

  const panel = getTaskFocusedPanel(taskId);
  if (!panel.startsWith('shell:')) {
    return null;
  }

  const index = Number.parseInt(panel.slice(6), 10);
  const shellId = store.tasks[taskId]?.shellAgentIds[index];
  return shellId ? { shellId, taskId } : null;
}

export function registerAppShortcuts(): () => void {
  const cleanupShortcuts = initShortcuts();

  registerShortcut({ actionId: 'navigation.focus-up', handler: () => navigateRow('up') });
  registerShortcut({
    actionId: 'navigation.focus-down',
    handler: () => navigateRow('down'),
  });
  registerShortcut({
    actionId: 'navigation.focus-left',
    handler: () => navigateColumn('left'),
  });
  registerShortcut({
    actionId: 'navigation.focus-right',
    handler: () => navigateColumn('right'),
  });
  registerShortcut({
    actionId: 'navigation.task-left',
    handler: () => navigateTask('left'),
  });
  registerShortcut({
    actionId: 'navigation.task-right',
    handler: () => navigateTask('right'),
  });

  registerShortcut({
    actionId: 'task.move-left',
    handler: () => moveActiveTask('left'),
  });
  registerShortcut({
    actionId: 'task.move-right',
    handler: () => moveActiveTask('right'),
  });

  for (let index = 0; index < 9; index += 1) {
    registerShortcut({
      actionId: `task.jump-${index + 1}` as KeybindingActionId,
      handler: () => jumpToTask(index),
    });
  }

  registerShortcut({
    actionId: 'task.close-focused-terminal',
    handler: () => {
      const focusedShell = getFocusedShellId();
      if (focusedShell) {
        void closeShell(focusedShell.taskId, focusedShell.shellId).catch((error) => {
          handleShellShortcutFailure('close terminal', error);
        });
      }
    },
  });
  registerShortcut({
    actionId: 'task.close-active',
    handler: () => {
      const taskId = store.activeTaskId;
      if (!taskId) {
        return;
      }

      if (store.terminals[taskId]) {
        closeTerminal(taskId);
        return;
      }

      if (store.tasks[taskId]) {
        setPendingAction({ type: 'close', taskId });
      }
    },
  });
  registerShortcut({
    actionId: 'task.merge',
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId && store.tasks[taskId]) {
        setPendingAction({ type: 'merge', taskId });
      }
    },
  });
  registerShortcut({
    actionId: 'task.push',
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId && store.tasks[taskId]) {
        setPendingAction({ type: 'push', taskId });
      }
    },
  });
  registerShortcut({
    actionId: 'task.new-shell',
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId && store.tasks[taskId]) {
        spawnShellForTask(taskId);
      }
    },
  });
  registerShortcut({
    actionId: 'task.send-prompt',
    handler: () => sendActivePrompt(),
  });

  registerShortcut({
    actionId: 'app.new-terminal',
    handler: (event) => {
      if (!event.repeat) {
        createTerminal();
      }
    },
  });
  registerShortcut({
    actionId: 'app.new-task',
    handler: () => openNewTaskDialog(),
  });
  registerShortcut({
    actionId: 'app.new-task-alt',
    handler: () => openNewTaskDialog(),
  });
  registerShortcut({ actionId: 'app.toggle-sidebar', handler: () => toggleSidebar() });
  registerShortcut({
    actionId: 'app.toggle-help',
    handler: () => toggleHelpDialog(),
  });
  registerShortcut({
    actionId: 'app.open-settings',
    handler: () => toggleSettingsDialog(),
  });
  registerShortcut({
    actionId: 'app.close-dialog',
    handler: () => {
      if (store.showArena) {
        return;
      }

      if (store.markdownViewer) {
        closeMarkdownViewer();
        return;
      }
      if (store.showHelpDialog) {
        toggleHelpDialog(false);
        return;
      }
      if (store.showSettingsDialog) {
        toggleSettingsDialog(false);
        return;
      }
      if (store.showNewTaskDialog) {
        toggleNewTaskDialog(false);
      }
    },
  });
  registerShortcut({
    actionId: 'app.zoom-in',
    handler: () => adjustGlobalScale(1),
  });
  registerShortcut({
    actionId: 'app.zoom-in-alt',
    handler: () => adjustGlobalScale(1),
  });
  registerShortcut({
    actionId: 'app.zoom-out',
    handler: () => adjustGlobalScale(-1),
  });
  registerShortcut({
    actionId: 'app.reset-zoom',
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId) {
        resetFontScale(taskId);
      }

      resetGlobalScale();
    },
  });

  return cleanupShortcuts;
}
