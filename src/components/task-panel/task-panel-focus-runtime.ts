import { createEffect, onCleanup, onMount, type Accessor } from 'solid-js';
import type { EditableTextHandle } from '../EditableText';

interface TaskPanelFocusRuntimeOptions {
  getChangedFilesRef: () => HTMLDivElement | undefined;
  getNotesRef: () => HTMLTextAreaElement | undefined;
  getPanelRef: () => HTMLDivElement | undefined;
  getPlanContent: () => string | undefined;
  getPlanFocusRef: () => HTMLDivElement | undefined;
  getPromptRef: () => HTMLTextAreaElement | undefined;
  getStoredTaskFocusedPanel: (taskId: string) => string | null;
  getTitleEditHandle: () => EditableTextHandle | undefined;
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

  onMount(() => {
    const titleTargetId = getFocusTargetId('title');
    const changedFilesTargetId = getFocusTargetId('changed-files');
    const promptTargetId = getFocusTargetId('prompt');

    options.registerFocusFn(titleTargetId, () => options.getTitleEditHandle()?.startEdit());
    options.registerFocusFn(changedFilesTargetId, () => options.getChangedFilesRef()?.focus());
    options.registerFocusFn(promptTargetId, () => options.getPromptRef()?.focus());

    onCleanup(() => {
      options.unregisterFocusFn(titleTargetId);
      options.unregisterFocusFn(changedFilesTargetId);
      options.unregisterFocusFn(promptTargetId);
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
      return;
    }

    const focusedPanel = options.getStoredTaskFocusedPanel(options.taskId());
    if (focusedPanel) {
      options.triggerFocus(getFocusTargetId(focusedPanel));
    }
  });

  let autoFocusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (autoFocusTimer !== undefined) {
      clearTimeout(autoFocusTimer);
    }
  });

  createEffect(() => {
    if (!options.isActive()) {
      return;
    }

    if (options.getStoredTaskFocusedPanel(options.taskId()) !== null) {
      return;
    }

    if (autoFocusTimer !== undefined) {
      clearTimeout(autoFocusTimer);
    }

    autoFocusTimer = setTimeout(() => {
      autoFocusTimer = undefined;
      const panelRef = options.getPanelRef();
      if (
        options.getStoredTaskFocusedPanel(options.taskId()) === null &&
        (!panelRef || !panelRef.contains(document.activeElement))
      ) {
        options.getPromptRef()?.focus();
      }
    }, 0);
  });
}
