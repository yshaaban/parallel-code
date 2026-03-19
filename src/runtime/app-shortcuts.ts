import { initShortcuts, registerShortcut } from '../lib/shortcuts';
import {
  closeShell,
  closeTerminal,
  createTerminal,
  getTaskFocusedPanel,
  moveActiveTask,
  navigateColumn,
  navigateRow,
  resetFontScale,
  resetGlobalScale,
  sendActivePrompt,
  setPendingAction,
  spawnShellForTask,
  store,
  toggleHelpDialog,
  toggleNewTaskDialog,
  toggleSettingsDialog,
  toggleSidebar,
} from '../store/store';

export function registerAppShortcuts(): () => void {
  const cleanupShortcuts = initShortcuts();

  registerShortcut({ key: 'ArrowUp', alt: true, global: true, handler: () => navigateRow('up') });
  registerShortcut({
    key: 'ArrowDown',
    alt: true,
    global: true,
    handler: () => navigateRow('down'),
  });
  registerShortcut({
    key: 'ArrowLeft',
    alt: true,
    global: true,
    handler: () => navigateColumn('left'),
  });
  registerShortcut({
    key: 'ArrowRight',
    alt: true,
    global: true,
    handler: () => navigateColumn('right'),
  });

  registerShortcut({
    key: 'ArrowLeft',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: () => moveActiveTask('left'),
  });
  registerShortcut({
    key: 'ArrowRight',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: () => moveActiveTask('right'),
  });

  registerShortcut({
    key: 'w',
    cmdOrCtrl: true,
    global: true,
    handler: () => {
      const taskId = store.activeTaskId;
      if (!taskId) return;
      const panel = getTaskFocusedPanel(taskId);
      if (!panel.startsWith('shell:')) return;

      const index = parseInt(panel.slice(6), 10);
      const shellId = store.tasks[taskId]?.shellAgentIds[index];
      if (shellId) closeShell(taskId, shellId);
    },
  });
  registerShortcut({
    key: 'W',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: () => {
      const taskId = store.activeTaskId;
      if (!taskId) return;
      if (store.terminals[taskId]) {
        closeTerminal(taskId);
        return;
      }
      if (store.tasks[taskId]) setPendingAction({ type: 'close', taskId });
    },
  });
  registerShortcut({
    key: 'M',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId && store.tasks[taskId]) {
        setPendingAction({ type: 'merge', taskId });
      }
    },
  });
  registerShortcut({
    key: 'P',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId && store.tasks[taskId]) {
        setPendingAction({ type: 'push', taskId });
      }
    },
  });
  registerShortcut({
    key: 'T',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId && store.tasks[taskId]) spawnShellForTask(taskId);
    },
  });
  registerShortcut({
    key: 'Enter',
    cmdOrCtrl: true,
    global: true,
    handler: () => sendActivePrompt(),
  });

  registerShortcut({
    key: 'D',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: (event) => {
      if (!event.repeat) createTerminal();
    },
  });
  registerShortcut({
    key: 'n',
    cmdOrCtrl: true,
    global: true,
    handler: () => toggleNewTaskDialog(true),
  });
  registerShortcut({
    key: 'a',
    cmdOrCtrl: true,
    shift: true,
    global: true,
    handler: () => toggleNewTaskDialog(true),
  });
  registerShortcut({ key: 'b', cmdOrCtrl: true, handler: () => toggleSidebar() });
  registerShortcut({
    key: '/',
    cmdOrCtrl: true,
    global: true,
    dialogSafe: true,
    handler: () => toggleHelpDialog(),
  });
  registerShortcut({
    key: ',',
    cmdOrCtrl: true,
    global: true,
    dialogSafe: true,
    handler: () => toggleSettingsDialog(),
  });
  registerShortcut({
    key: 'F1',
    global: true,
    dialogSafe: true,
    handler: () => toggleHelpDialog(),
  });
  registerShortcut({
    key: 'Escape',
    dialogSafe: true,
    handler: () => {
      if (store.showArena) return;
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
    key: '0',
    cmdOrCtrl: true,
    handler: () => {
      const taskId = store.activeTaskId;
      if (taskId) resetFontScale(taskId);
      resetGlobalScale();
    },
  });

  return cleanupShortcuts;
}
