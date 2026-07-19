import { createEffect, onCleanup, onMount, type Accessor } from 'solid-js';
import type { EditableTextHandle } from '../EditableText';

interface TaskPanelFocusRuntimeOptions {
  getChangedFilesRef: () => HTMLDivElement | undefined;
  getNotesRef: () => HTMLTextAreaElement | undefined;
  getDefaultFocusedPanel: (taskId: string) => string;
  getPanelRef: () => HTMLDivElement | undefined;
  getPlanContent: () => string | undefined;
  getPlanFocusRef: () => HTMLDivElement | undefined;
  getPromptRef: () => HTMLTextAreaElement | undefined;
  getStoredTaskFocusedPanel: (taskId: string) => string | null;
  getTitleEditHandle: () => EditableTextHandle | undefined;
  hasPromptPanel: boolean;
  isActive: Accessor<boolean>;
  notesTab: Accessor<'notes' | 'plan'>;
  registerFocusFn: (id: string, focusFn: () => void) => void;
  showPlans: Accessor<boolean>;
  taskId: Accessor<string>;
  triggerFocus: (id: string) => void;
  unregisterFocusFn: (id: string) => void;
}

function shouldFocusPlanNotes(options: TaskPanelFocusRuntimeOptions): boolean {
  return options.notesTab() === 'plan' && options.showPlans() && Boolean(options.getPlanContent());
}

export function createTaskPanelFocusRuntime(options: TaskPanelFocusRuntimeOptions): void {
  function getFocusTargetId(panelId: string): string {
    return `${options.taskId()}:${panelId}`;
  }

  let defaultFocusTimer: ReturnType<typeof setTimeout> | undefined;
  function clearDefaultFocusTimer(): void {
    if (defaultFocusTimer === undefined) {
      return;
    }

    clearTimeout(defaultFocusTimer);
    defaultFocusTimer = undefined;
  }

  onCleanup(clearDefaultFocusTimer);

  onMount(() => {
    const titleTargetId = getFocusTargetId('title');
    const changedFilesTargetId = getFocusTargetId('changed-files');
    const promptTargetId = getFocusTargetId('prompt');

    options.registerFocusFn(titleTargetId, () => options.getTitleEditHandle()?.startEdit());
    options.registerFocusFn(changedFilesTargetId, () => options.getChangedFilesRef()?.focus());
    if (options.hasPromptPanel) {
      options.registerFocusFn(promptTargetId, () => options.getPromptRef()?.focus());
    }

    onCleanup(() => {
      options.unregisterFocusFn(titleTargetId);
      options.unregisterFocusFn(changedFilesTargetId);
      if (options.hasPromptPanel) {
        options.unregisterFocusFn(promptTargetId);
      }
    });
  });

  createEffect(() => {
    const notesTargetId = getFocusTargetId('notes');
    options.registerFocusFn(notesTargetId, () => {
      if (shouldFocusPlanNotes(options)) {
        options.getPlanFocusRef()?.focus();
        return;
      }

      options.getNotesRef()?.focus();
    });

    onCleanup(() => {
      options.unregisterFocusFn(notesTargetId);
    });
  });

  createEffect(() => {
    if (!options.isActive()) {
      clearDefaultFocusTimer();
      return;
    }

    const taskId = options.taskId();
    const storedFocusedPanel = options.getStoredTaskFocusedPanel(taskId);
    if (storedFocusedPanel) {
      clearDefaultFocusTimer();
      options.triggerFocus(getFocusTargetId(storedFocusedPanel));
      return;
    }

    clearDefaultFocusTimer();
    defaultFocusTimer = setTimeout(() => {
      defaultFocusTimer = undefined;
      if (!options.isActive()) {
        return;
      }

      const currentTaskId = options.taskId();
      const currentStoredFocusedPanel = options.getStoredTaskFocusedPanel(currentTaskId);
      if (currentStoredFocusedPanel) {
        options.triggerFocus(getFocusTargetId(currentStoredFocusedPanel));
        return;
      }

      const panelRef = options.getPanelRef();
      if (panelRef?.contains(document.activeElement)) {
        return;
      }

      options.triggerFocus(getFocusTargetId(options.getDefaultFocusedPanel(currentTaskId)));
    }, 0);
  });
}
