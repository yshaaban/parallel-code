import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { ChangedFile } from '../../ipc/types';
import type { PendingAction, Task } from '../../store/types';

interface TaskPanelDialogStateOptions {
  clearPendingAction: () => void;
  pendingAction: Accessor<PendingAction | null>;
  showNotification: (message: string) => void;
  task: Accessor<Task>;
}

export function createTaskPanelDialogState(options: TaskPanelDialogStateOptions): {
  diffFile: Accessor<ChangedFile | null>;
  editingProjectId: Accessor<string | null>;
  handlePushFinished: (success: boolean) => void;
  handlePushStarted: () => void;
  openCloseConfirm: () => void;
  openMergeConfirm: () => void;
  openPushConfirm: () => void;
  pushSuccess: Accessor<boolean>;
  pushing: Accessor<boolean>;
  setDiffFile: (file: ChangedFile | null) => void;
  setEditingProjectId: (projectId: string | null) => void;
  setShowCloseConfirm: (show: boolean) => void;
  setShowMergeConfirm: (show: boolean) => void;
  setShowPushConfirm: (show: boolean) => void;
  showCloseConfirm: Accessor<boolean>;
  showMergeConfirm: Accessor<boolean>;
  showPushConfirm: Accessor<boolean>;
} {
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [showMergeConfirm, setShowMergeConfirm] = createSignal(false);
  const [showPushConfirm, setShowPushConfirm] = createSignal(false);
  const [pushSuccess, setPushSuccess] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null);

  let pushSuccessTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(pushSuccessTimer));

  createEffect(() => {
    const action = options.pendingAction();
    const task = options.task();
    if (!action || action.taskId !== task.id) {
      return;
    }

    options.clearPendingAction();
    switch (action.type) {
      case 'close':
        setShowCloseConfirm(true);
        break;
      case 'merge':
        if (!task.directMode) {
          setShowMergeConfirm(true);
        }
        break;
      case 'push':
        if (!task.directMode) {
          setShowPushConfirm(true);
        }
        break;
    }
  });

  function getBackgroundPushMessage(success: boolean): string {
    if (success) {
      return `Push finished for ${options.task().branchName}`;
    }

    return `Push failed for ${options.task().branchName}`;
  }

  function handlePushStarted(): void {
    setPushing(true);
    setPushSuccess(false);
    clearTimeout(pushSuccessTimer);
  }

  function handlePushFinished(success: boolean): void {
    const wasHidden = !showPushConfirm();
    setShowPushConfirm(false);
    setPushing(false);

    if (success) {
      setPushSuccess(true);
      pushSuccessTimer = setTimeout(() => setPushSuccess(false), 3000);
    }

    if (wasHidden) {
      options.showNotification(getBackgroundPushMessage(success));
    }
  }

  return {
    diffFile,
    editingProjectId,
    handlePushFinished,
    handlePushStarted,
    openCloseConfirm: () => setShowCloseConfirm(true),
    openMergeConfirm: () => setShowMergeConfirm(true),
    openPushConfirm: () => setShowPushConfirm(true),
    pushSuccess,
    pushing,
    setDiffFile,
    setEditingProjectId,
    setShowCloseConfirm,
    setShowMergeConfirm,
    setShowPushConfirm,
    showCloseConfirm,
    showMergeConfirm,
    showPushConfirm,
  };
}
