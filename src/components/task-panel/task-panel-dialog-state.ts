import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import {
  getCurrentTaskGitActionDecision,
  notifyTaskGitActionDenial,
} from '../../app/task-git-action-capability';
import type { ChangedFile } from '../../ipc/types';
import type { PendingAction, Task } from '../../store/types';

interface PushDialogRun {
  branchName: string;
  taskId: string;
}

interface TaskPanelDialogStateOptions {
  clearPendingAction: () => void;
  pendingAction: Accessor<PendingAction | null>;
  showNotification: (message: string) => void;
  task: Accessor<Task>;
}

export function createTaskPanelDialogState(options: TaskPanelDialogStateOptions): {
  diffFile: Accessor<ChangedFile | null>;
  editingProjectId: Accessor<string | null>;
  handlePushFinished: (success: boolean, run?: PushDialogRun) => void;
  handlePushStarted: (run: PushDialogRun) => void;
  openCloseConfirm: () => void;
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
  const [activePushRun, setActivePushRun] = createSignal<PushDialogRun | null>(null);

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
      case 'merge': {
        const decision = getCurrentTaskGitActionDecision('merge', task.id);
        if (decision.allowed) {
          setShowMergeConfirm(true);
        } else {
          notifyTaskGitActionDenial(decision);
        }
        break;
      }
      case 'push': {
        const decision = getCurrentTaskGitActionDecision('push', task.id);
        if (decision.allowed) {
          setShowPushConfirm(true);
        } else {
          notifyTaskGitActionDenial(decision);
        }
        break;
      }
    }
  });

  function getBackgroundPushMessage(success: boolean, run: PushDialogRun): string {
    if (success) {
      return `Push finished for ${run.branchName}`;
    }

    return `Push failed for ${run.branchName}`;
  }

  function getCurrentTaskPushRun(): PushDialogRun {
    const task = options.task();
    return {
      branchName: task.branchName,
      taskId: task.id,
    };
  }

  function isSamePushRun(left: PushDialogRun, right: PushDialogRun): boolean {
    return left.taskId === right.taskId && left.branchName === right.branchName;
  }

  function handlePushStarted(run: PushDialogRun): void {
    setActivePushRun(run);
    setPushing(true);
    setPushSuccess(false);
    clearTimeout(pushSuccessTimer);
  }

  function handlePushFinished(success: boolean, run?: PushDialogRun): void {
    const currentTaskRun = getCurrentTaskPushRun();
    const completedRun = run ?? activePushRun() ?? currentTaskRun;
    const currentRun = activePushRun();
    const isCurrentRun = !currentRun || isSamePushRun(currentRun, completedRun);
    const wasHidden = !showPushConfirm();
    if (isCurrentRun) {
      setShowPushConfirm(false);
      setPushing(false);
      setActivePushRun(null);
    }

    if (success && isSamePushRun(completedRun, currentTaskRun)) {
      setPushSuccess(true);
      pushSuccessTimer = setTimeout(() => setPushSuccess(false), 3000);
    }

    if (wasHidden) {
      options.showNotification(getBackgroundPushMessage(success, completedRun));
    }
  }

  return {
    diffFile,
    editingProjectId,
    handlePushFinished,
    handlePushStarted,
    openCloseConfirm: () => setShowCloseConfirm(true),
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
