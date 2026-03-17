import { Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js';

import {
  applyTaskPortsEvent,
  exposeTaskPortForTask,
  fetchTaskPortExposureCandidates,
  refreshTaskPreviewForTask,
  getTaskPortSnapshot,
  unexposeTaskPortForTask,
} from '../app/task-ports';
import { isElectronRuntime } from '../lib/ipc';
import { handleDragReorder } from '../lib/drag-reorder';
import { isHydraAgentDef } from '../lib/hydra';
import { theme } from '../lib/theme';
import type { ChangedFile } from '../ipc/types';
import type { TaskPortExposureCandidate, TaskPortSnapshot } from '../domain/server-state';
import {
  clearInitialPrompt,
  clearPendingAction,
  clearPrefillPrompt,
  collapseTask,
  getProject,
  getTaskDotStatus,
  handlePermissionResponse,
  registerFocusFn,
  reorderTask,
  retryCloseTask,
  setActiveTask,
  setTaskFocusedPanel,
  store,
  triggerFocus,
  unregisterFocusFn,
  updateTaskName,
} from '../store/store';
import { showNotification } from '../store/notification';
import type { Task } from '../store/types';
import { CloseTaskDialog } from './CloseTaskDialog';
import { DiffViewerDialog } from './DiffViewerDialog';
import type { EditableTextHandle } from './EditableText';
import { EditProjectDialog } from './EditProjectDialog';
import { MergeDialog } from './MergeDialog';
import { PermissionCard } from './PermissionCard';
import { PromptInput, type PromptInputHandle } from './PromptInput';
import { PushDialog } from './PushDialog';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import { ScalablePanel } from './ScalablePanel';
import { TaskBranchInfoBar } from './TaskBranchInfoBar';
import { TaskTitleBar } from './TaskTitleBar';
import { createTaskAiTerminalSection } from './task-panel/TaskAiTerminalSection';
import { createTaskNotesFilesSection } from './task-panel/TaskNotesFilesSection';
import { createTaskPreviewSection } from './task-panel/TaskPreviewSection';
import { getAgentStatusBadgeText } from './task-panel/task-panel-helpers';
import { createTaskShellSection } from './task-panel/TaskShellSection';

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

function createEmptyTaskPortSnapshot(taskId: string): TaskPortSnapshot {
  return {
    exposed: [],
    observed: [],
    taskId,
    updatedAt: 0,
  };
}

export function TaskPanel(props: TaskPanelProps): JSX.Element {
  const electronRuntime = isElectronRuntime();
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [showMergeConfirm, setShowMergeConfirm] = createSignal(false);
  const [showPushConfirm, setShowPushConfirm] = createSignal(false);
  const [pushSuccess, setPushSuccess] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);
  const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null);
  const [showPreview, setShowPreview] = createSignal(false);
  const [exposePortCandidates, setExposePortCandidates] = createSignal<TaskPortExposureCandidate[]>(
    [],
  );
  const [scanningExposePortCandidates, setScanningExposePortCandidates] = createSignal(false);
  const [exposePortScanError, setExposePortScanError] = createSignal<string | null>(null);

  let pushSuccessTimer: ReturnType<typeof setTimeout> | undefined;
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;
  let notesRef: HTMLTextAreaElement | undefined;
  let planFocusRef: HTMLDivElement | undefined;
  let changedFilesRef: HTMLDivElement | undefined;
  let titleEditHandle: EditableTextHandle | undefined;
  let promptHandle: PromptInputHandle | undefined;
  let exposePortScanRequestId = 0;

  onCleanup(() => clearTimeout(pushSuccessTimer));

  const projectBookmarks = () => getProject(props.task.projectId)?.terminalBookmarks ?? [];
  const editingProject = () => {
    const projectId = editingProjectId();
    return projectId ? (getProject(projectId) ?? null) : null;
  };

  let hadPlan = false;
  createEffect(() => {
    const hasPlan = store.showPlans && !!props.task.planContent;
    if (hasPlan && !hadPlan) {
      setNotesTab('plan');
    } else if (!hasPlan && hadPlan) {
      setNotesTab('notes');
    }
    hadPlan = hasPlan;
  });

  onMount(() => {
    const taskId = props.task.id;
    registerFocusFn(`${taskId}:title`, () => titleEditHandle?.startEdit());
    registerFocusFn(`${taskId}:changed-files`, () => changedFilesRef?.focus());
    registerFocusFn(`${taskId}:prompt`, () => promptRef?.focus());

    onCleanup(() => {
      unregisterFocusFn(`${taskId}:title`);
      unregisterFocusFn(`${taskId}:changed-files`);
      unregisterFocusFn(`${taskId}:prompt`);
    });
  });

  createEffect(() => {
    const taskId = props.task.id;
    registerFocusFn(taskId + ':notes', () => {
      if (shouldFocusPlanNotes()) {
        planFocusRef?.focus();
        return;
      }

      notesRef?.focus();
    });

    onCleanup(() => {
      unregisterFocusFn(taskId + ':notes');
    });
  });

  createEffect(() => {
    if (!props.isActive) return;
    const focusedPanel = store.focusedPanel[props.task.id];
    if (focusedPanel) {
      triggerFocus(`${props.task.id}:${focusedPanel}`);
    }
  });

  let autoFocusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (autoFocusTimer !== undefined) {
      clearTimeout(autoFocusTimer);
    }
  });
  createEffect(() => {
    if (!props.isActive || store.focusedPanel[props.task.id]) return;

    const taskId = props.task.id;
    if (autoFocusTimer !== undefined) {
      clearTimeout(autoFocusTimer);
    }
    autoFocusTimer = setTimeout(() => {
      autoFocusTimer = undefined;
      if (!store.focusedPanel[taskId] && !panelRef.contains(document.activeElement)) {
        promptRef?.focus();
      }
    }, 0);
  });

  createEffect(() => {
    const action = store.pendingAction;
    if (!action || action.taskId !== props.task.id) return;

    clearPendingAction();
    switch (action.type) {
      case 'close':
        setShowCloseConfirm(true);
        break;
      case 'merge':
        if (!props.task.directMode) {
          setShowMergeConfirm(true);
        }
        break;
      case 'push':
        if (!props.task.directMode) {
          setShowPushConfirm(true);
        }
        break;
    }
  });

  const firstAgent = () => {
    const firstAgentId = props.task.agentIds[0];
    return firstAgentId ? store.agents[firstAgentId] : undefined;
  };

  function shouldFocusPlanNotes(): boolean {
    return notesTab() === 'plan' && store.showPlans && Boolean(props.task.planContent);
  }

  const isHydraTask = () => isHydraAgentDef(firstAgent()?.def);
  const firstAgentId = () => props.task.agentIds[0] ?? '';
  const taskPortSnapshot = () => getTaskPortSnapshot(props.task.id);
  const hasPreviewPorts = () => {
    const snapshot = taskPortSnapshot();
    return !!snapshot && (snapshot.exposed.length > 0 || snapshot.observed.length > 0);
  };
  const firstAgentStatusBadge = () => {
    const status = firstAgent()?.status;
    return status ? getAgentStatusBadgeText(status) : null;
  };

  function getBackgroundPushMessage(success: boolean): string {
    if (success) {
      return `Push finished for ${props.task.branchName}`;
    }

    return `Push failed for ${props.task.branchName}`;
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
      showNotification(getBackgroundPushMessage(success));
    }
  }

  function handleTitleMouseDown(event: MouseEvent): void {
    handleDragReorder(event, {
      itemId: props.task.id,
      getTaskOrder: () => store.taskOrder,
      onReorder: reorderTask,
      onTap: () => setActiveTask(props.task.id),
    });
  }

  createEffect(
    on(
      () => store.focusedPanel[props.task.id],
      (focusedPanel) => {
        if (focusedPanel !== 'preview') {
          return;
        }

        setShowPreview(true);
        void refreshExposePortCandidates();
      },
    ),
  );

  function hidePreview(): void {
    setShowPreview(false);

    if (store.focusedPanel[props.task.id] === 'preview') {
      setTaskFocusedPanel(props.task.id, 'prompt');
    }
  }

  function openPreview(taskId: string): void {
    setShowPreview(true);
    setTaskFocusedPanel(taskId, 'preview');
  }

  async function refreshExposePortCandidates(): Promise<void> {
    const requestId = ++exposePortScanRequestId;
    const taskId = props.task.id;
    const worktreePath = props.task.worktreePath;
    setScanningExposePortCandidates(true);
    setExposePortScanError(null);
    try {
      const candidates = await fetchTaskPortExposureCandidates(taskId, worktreePath);
      if (requestId !== exposePortScanRequestId) {
        return;
      }

      setExposePortCandidates(candidates);
    } catch (error) {
      if (requestId !== exposePortScanRequestId) {
        return;
      }

      setExposePortCandidates([]);
      setExposePortScanError(error instanceof Error ? error.message : 'Failed to scan ports');
    } finally {
      if (requestId === exposePortScanRequestId) {
        setScanningExposePortCandidates(false);
      }
    }
  }

  function handlePreviewButtonClick(): void {
    if (showPreview()) {
      hidePreview();
      return;
    }

    openPreview(props.task.id);
  }

  function titleBar(): PanelChild {
    return {
      id: 'title',
      initialSize: 50,
      fixed: true,
      content: () => (
        <TaskTitleBar
          task={props.task}
          isActive={props.isActive}
          taskDotStatus={getTaskDotStatus(props.task.id)}
          firstAgentStatusBadge={firstAgentStatusBadge()}
          hasPreviewPorts={hasPreviewPorts()}
          isPreviewVisible={showPreview()}
          pushing={pushing()}
          pushSuccess={pushSuccess()}
          onMouseDown={handleTitleMouseDown}
          onPreviewButtonClick={handlePreviewButtonClick}
          onUpdateTaskName={(value) => updateTaskName(props.task.id, value)}
          onSetTitleEditHandle={(handle) => {
            titleEditHandle = handle;
          }}
          onOpenMerge={() => setShowMergeConfirm(true)}
          onOpenPush={() => setShowPushConfirm(true)}
          onCollapse={() => collapseTask(props.task.id)}
          onClose={() => setShowCloseConfirm(true)}
        />
      ),
    };
  }

  function branchInfoBar(): PanelChild {
    return {
      id: 'branch',
      initialSize: 28,
      fixed: true,
      content: () => (
        <TaskBranchInfoBar
          task={props.task}
          project={getProject(props.task.projectId) ?? null}
          electronRuntime={electronRuntime}
          editorCommand={store.editorCommand}
          onEditProject={() => setEditingProjectId(props.task.projectId)}
        />
      ),
    };
  }

  function pendingPermission() {
    const agentId = firstAgentId();
    if (!agentId) return undefined;
    const requests = store.permissionRequests[agentId];
    if (!requests) return undefined;
    return requests.find((request) => request.status === 'pending');
  }

  function promptInput(): PanelChild {
    return {
      id: 'prompt',
      initialSize: 72,
      stable: true,
      minSize: 54,
      maxSize: 300,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:prompt`}>
          <div
            onClick={() => setTaskFocusedPanel(props.task.id, 'prompt')}
            style={{ height: '100%', display: 'flex', 'flex-direction': 'column' }}
          >
            <Show when={pendingPermission()}>
              {(request) => (
                <PermissionCard
                  request={request()}
                  onApprove={(requestId) => {
                    const agentId = firstAgentId();
                    if (agentId) {
                      void handlePermissionResponse(agentId, requestId, 'approve');
                    }
                  }}
                  onDeny={(requestId) => {
                    const agentId = firstAgentId();
                    if (agentId) {
                      void handlePermissionResponse(agentId, requestId, 'deny');
                    }
                  }}
                />
              )}
            </Show>
            <PromptInput
              taskId={props.task.id}
              agentId={firstAgentId()}
              initialPrompt={props.task.initialPrompt}
              prefillPrompt={props.task.prefillPrompt}
              onSend={() => {
                if (props.task.initialPrompt) {
                  clearInitialPrompt(props.task.id);
                }
              }}
              onPrefillConsumed={() => clearPrefillPrompt(props.task.id)}
              ref={(element) => {
                promptRef = element;
              }}
              handle={(handle) => {
                promptHandle = handle;
              }}
            />
          </div>
        </ScalablePanel>
      ),
    };
  }

  const notesAndFilesSection = createTaskNotesFilesSection({
    task: () => props.task,
    isActive: () => props.isActive,
    isHydraTask,
    notesTab,
    onFileClick: setDiffFile,
    setChangedFilesRef: (element) => {
      changedFilesRef = element;
    },
    setNotesRef: (element) => {
      notesRef = element;
    },
    setPlanFocusRef: (element) => {
      planFocusRef = element;
    },
    setNotesTab,
  });
  const shellSection = createTaskShellSection({
    bookmarks: projectBookmarks,
    isActive: () => props.isActive,
    shellAgentIds: () => props.task.shellAgentIds,
    taskId: () => props.task.id,
    worktreePath: () => props.task.worktreePath,
  });
  const aiTerminalSection = createTaskAiTerminalSection({
    isActive: () => props.isActive,
    onReuseLastPrompt: () => {
      if (props.task.lastPrompt && promptHandle && !promptHandle.getText()) {
        promptHandle.setText(props.task.lastPrompt);
      }
    },
    task: () => props.task,
  });

  function handleExposePort(port: number, label?: string): Promise<void> {
    const taskId = props.task.id;
    return exposeTaskPortForTask(taskId, port, label).then((snapshot) => {
      applyTaskPortsEvent(snapshot);
      openPreview(taskId);
    });
  }

  const previewSection = () => {
    if (!showPreview()) {
      return null;
    }

    return createTaskPreviewSection({
      availableCandidates: exposePortCandidates,
      availableScanError: exposePortScanError,
      availableScanning: scanningExposePortCandidates,
      taskId: () => props.task.id,
      snapshot: () => taskPortSnapshot() ?? createEmptyTaskPortSnapshot(props.task.id),
      onHide: hidePreview,
      onRefreshAvailablePorts: refreshExposePortCandidates,
      onExposePort: handleExposePort,
      onRefreshPort: async (port) => {
        const nextSnapshot = await refreshTaskPreviewForTask(props.task.id, port);
        if (nextSnapshot) {
          applyTaskPortsEvent(nextSnapshot);
        }
      },
      onUnexposePort: async (port) => {
        const nextSnapshot = await unexposeTaskPortForTask(props.task.id, port);
        if (nextSnapshot) {
          applyTaskPortsEvent(nextSnapshot);
          return;
        }

        applyTaskPortsEvent({
          taskId: props.task.id,
          removed: true,
        });
      },
    });
  };

  const panelChildren = () => {
    const children: PanelChild[] = [titleBar(), branchInfoBar()];
    const nextPreviewSection = previewSection();
    if (nextPreviewSection) {
      children.push(nextPreviewSection);
    }
    children.push(notesAndFilesSection, shellSection, aiTerminalSection, promptInput());
    return children;
  };

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? 'active' : ''}`}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: theme.taskContainerBg,
        'border-radius': '12px',
        border: `1px solid ${theme.border}`,
        overflow: 'clip',
        position: 'relative',
      }}
      onClick={() => setActiveTask(props.task.id)}
    >
      <Show when={props.task.closingStatus && props.task.closingStatus !== 'removing'}>
        <div
          style={{
            position: 'absolute',
            inset: '0',
            'z-index': '50',
            background: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            'flex-direction': 'column',
            'align-items': 'center',
            'justify-content': 'center',
            gap: '12px',
            'border-radius': '12px',
            color: theme.fg,
          }}
        >
          <Show when={props.task.closingStatus === 'closing'}>
            <div style={{ 'font-size': '13px', color: theme.fgMuted }}>Closing task...</div>
          </Show>
          <Show when={props.task.closingStatus === 'error'}>
            <div style={{ 'font-size': '13px', color: theme.error, 'font-weight': '600' }}>
              Close failed
            </div>
            <div
              style={{
                'font-size': '11px',
                color: theme.fgMuted,
                'max-width': '260px',
                'text-align': 'center',
                'word-break': 'break-word',
              }}
            >
              {props.task.closingError}
            </div>
            <button
              onClick={(event) => {
                event.stopPropagation();
                retryCloseTask(props.task.id);
              }}
              style={{
                background: theme.bgElevated,
                border: `1px solid ${theme.border}`,
                color: theme.fg,
                padding: '6px 16px',
                'border-radius': '6px',
                cursor: 'pointer',
                'font-size': '12px',
              }}
            >
              Retry
            </button>
          </Show>
        </div>
      </Show>

      <ResizablePanel
        direction="vertical"
        persistKey={`task:${props.task.id}`}
        children={panelChildren()}
      />

      <CloseTaskDialog
        open={showCloseConfirm()}
        task={props.task}
        onDone={() => setShowCloseConfirm(false)}
      />
      <MergeDialog
        open={showMergeConfirm()}
        task={props.task}
        initialCleanup={getProject(props.task.projectId)?.deleteBranchOnClose ?? true}
        onDone={() => setShowMergeConfirm(false)}
        onDiffFileClick={setDiffFile}
      />
      <PushDialog
        open={showPushConfirm()}
        task={props.task}
        onStart={handlePushStarted}
        onClose={() => {
          setShowPushConfirm(false);
        }}
        onDone={handlePushFinished}
      />
      <DiffViewerDialog
        file={diffFile()}
        worktreePath={props.task.worktreePath}
        projectRoot={getProject(props.task.projectId)?.path}
        branchName={props.task.branchName}
        taskId={props.task.id}
        agentId={props.task.agentIds[0]}
        onClose={() => setDiffFile(null)}
      />
      <EditProjectDialog project={editingProject()} onClose={() => setEditingProjectId(null)} />
    </div>
  );
}
