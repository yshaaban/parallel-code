import { Show, createEffect, createSignal, type JSX } from 'solid-js';

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
import {
  getTaskCloseError,
  hasTaskClosingState,
  isTaskCloseErrored,
  isTaskClosing,
  isTaskRemoving,
} from '../domain/task-closing';
import {
  clearInitialPrompt,
  clearPendingAction,
  clearPrefillPrompt,
  collapseTask,
  getProject,
  getTaskDotStatus,
  getStoredTaskFocusedPanel,
  handlePermissionResponse,
  isTaskPanelFocused,
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
import { createTaskPanelDialogState } from './task-panel/task-panel-dialog-state';
import { createTaskPanelFocusRuntime } from './task-panel/task-panel-focus-runtime';
import { createTaskNotesFilesSection } from './task-panel/TaskNotesFilesSection';
import { createTaskPanelPreviewController } from './task-panel/task-panel-preview-controller';
import { getAgentStatusBadgeText } from './task-panel/task-panel-helpers';
import { createTaskShellSection } from './task-panel/TaskShellSection';

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps): JSX.Element {
  const electronRuntime = isElectronRuntime();
  const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;
  let notesRef: HTMLTextAreaElement | undefined;
  let planFocusRef: HTMLDivElement | undefined;
  let changedFilesRef: HTMLDivElement | undefined;
  let titleEditHandle: EditableTextHandle | undefined;
  let promptHandle: PromptInputHandle | undefined;

  const projectBookmarks = () => getProject(props.task.projectId)?.terminalBookmarks ?? [];

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

  const dialogState = createTaskPanelDialogState({
    clearPendingAction,
    pendingAction: () => store.pendingAction,
    showNotification,
    task: () => props.task,
  });

  createTaskPanelFocusRuntime({
    getChangedFilesRef: () => changedFilesRef,
    getNotesRef: () => notesRef,
    getPanelRef: () => panelRef,
    getPlanContent: () => props.task.planContent,
    getPlanFocusRef: () => planFocusRef,
    getPromptRef: () => promptRef,
    getStoredTaskFocusedPanel,
    getTitleEditHandle: () => titleEditHandle,
    isActive: () => props.isActive,
    notesTab,
    registerFocusFn,
    showPlans: () => store.showPlans,
    taskId: () => props.task.id,
    triggerFocus,
    unregisterFocusFn,
  });

  const firstAgent = () => {
    const firstAgentId = props.task.agentIds[0];
    return firstAgentId ? store.agents[firstAgentId] : undefined;
  };

  const isHydraTask = () => isHydraAgentDef(firstAgent()?.def);
  const firstAgentId = () => props.task.agentIds[0] ?? '';
  const firstAgentStatusBadge = () => {
    const status = firstAgent()?.status;
    return status ? getAgentStatusBadgeText(status) : null;
  };

  function handleTitleMouseDown(event: MouseEvent): void {
    handleDragReorder(event, {
      itemId: props.task.id,
      getTaskOrder: () => store.taskOrder,
      onReorder: reorderTask,
      onTap: () => setActiveTask(props.task.id),
    });
  }
  const previewController = createTaskPanelPreviewController({
    applyTaskPortsEvent,
    exposeTaskPortForTask,
    fetchTaskPortExposureCandidates,
    focusedPanel: () => getStoredTaskFocusedPanel(props.task.id),
    getTaskPortSnapshot,
    isTaskPanelFocused,
    refreshTaskPreviewForTask,
    setTaskFocusedPanel,
    taskId: () => props.task.id,
    unexposeTaskPortForTask,
    worktreePath: () => props.task.worktreePath,
  });

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
          hasPreviewPorts={previewController.hasPreviewPorts()}
          isPreviewVisible={previewController.showPreview()}
          pushing={dialogState.pushing()}
          pushSuccess={dialogState.pushSuccess()}
          onMouseDown={handleTitleMouseDown}
          onPreviewButtonClick={previewController.handlePreviewButtonClick}
          onUpdateTaskName={(value) => updateTaskName(props.task.id, value)}
          onSetTitleEditHandle={(handle) => {
            titleEditHandle = handle;
          }}
          onOpenMerge={dialogState.openMergeConfirm}
          onOpenPush={dialogState.openPushConfirm}
          onCollapse={() => collapseTask(props.task.id)}
          onClose={dialogState.openCloseConfirm}
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
          onEditProject={() => dialogState.setEditingProjectId(props.task.projectId)}
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
    onFileClick: dialogState.setDiffFile,
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

  const panelChildren = () => {
    const children: PanelChild[] = [titleBar(), branchInfoBar()];
    const nextPreviewSection = previewController.previewSection();
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
      <Show when={hasTaskClosingState(props.task) && !isTaskRemoving(props.task)}>
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
          <Show when={isTaskClosing(props.task)}>
            <div style={{ 'font-size': '13px', color: theme.fgMuted }}>Closing task...</div>
          </Show>
          <Show when={isTaskCloseErrored(props.task)}>
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
              {getTaskCloseError(props.task)}
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
        open={dialogState.showCloseConfirm()}
        task={props.task}
        onDone={() => dialogState.setShowCloseConfirm(false)}
      />
      <MergeDialog
        open={dialogState.showMergeConfirm()}
        task={props.task}
        initialCleanup={getProject(props.task.projectId)?.deleteBranchOnClose ?? true}
        onDone={() => dialogState.setShowMergeConfirm(false)}
        onDiffFileClick={dialogState.setDiffFile}
      />
      <PushDialog
        open={dialogState.showPushConfirm()}
        task={props.task}
        onStart={dialogState.handlePushStarted}
        onClose={() => {
          dialogState.setShowPushConfirm(false);
        }}
        onDone={dialogState.handlePushFinished}
      />
      <DiffViewerDialog
        file={dialogState.diffFile()}
        worktreePath={props.task.worktreePath}
        projectRoot={getProject(props.task.projectId)?.path}
        branchName={props.task.branchName}
        taskId={props.task.id}
        agentId={props.task.agentIds[0]}
        onClose={() => dialogState.setDiffFile(null)}
      />
      <EditProjectDialog
        project={(() => {
          const projectId = dialogState.editingProjectId();
          return projectId ? (getProject(projectId) ?? null) : null;
        })()}
        onClose={() => dialogState.setEditingProjectId(null)}
      />
    </div>
  );
}
