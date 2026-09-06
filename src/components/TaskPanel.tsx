import {
  For,
  Show,
  Suspense,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type JSX,
} from 'solid-js';

import {
  applyTaskPortsEvent,
  exposeTaskPortForTask,
  fetchTaskPortExposureCandidates,
  getTaskPortSnapshot,
  refreshTaskPreviewForTask,
  unexposeTaskPortForTask,
} from '../app/task-ports';
import {
  destroyTaskContainersForTask,
  fetchTaskContainerLogsForTask,
  inspectTaskContainerForTask,
  startTaskContainersForTask,
  stopTaskContainersForTask,
} from '../app/task-containers';
import { useTaskActivityNow } from '../app/task-activity-clock';
import {
  getCurrentTaskGitActionDecision,
  requestTaskGitAction,
} from '../app/task-git-action-capability';
import { cancelTerminalSwitchEchoGrace } from '../app/terminal-switch-echo-grace';
import {
  beginTerminalSwitchWindow,
  cancelTerminalSwitchWindow,
} from '../app/terminal-switch-window';
import { getVisibleTerminalCount } from '../app/terminal-visible-set';
import { isElectronRuntime } from '../lib/ipc';
import {
  getTerminalExperimentSwitchTargetWindowMs,
  getTerminalPerformanceExperimentConfig,
} from '../lib/terminal-performance-experiments';
import { handleDragReorder, type DragSessionCleanup } from '../lib/drag-reorder';
import { isHydraAgentDef } from '../lib/hydra';
import { lazyNamed } from '../lib/lazy-named';
import { theme } from '../lib/theme';
import {
  getTaskCloseError,
  hasTaskClosingState,
  isTaskCloseErrored,
  isTaskClosing,
  isTaskRemoving,
} from '../domain/task-closing';
import { isTerminalTask } from '../domain/task-mode';
import {
  clearPendingAction,
  clearPrefillPrompt,
  getProject,
  getProjectMode,
  getSelectedTaskAgentId,
  getTaskFocusedPanel,
  getTaskActivityStatus,
  getStoredTaskFocusedPanel,
  isTaskPanelFocused,
  registerFocusFn,
  reorderTask,
  setActiveTask,
  setTaskFocusedPanel,
  observeTaskPanelFocus,
  store,
  triggerFocus,
  unregisterFocusFn,
  updateTaskName,
} from '../store/store';
import { showNotification } from '../store/notification';
import type { Task } from '../store/types';
import { collapseTask, retryCloseTask } from '../app/task-workflows';
import type { EditableTextHandle } from './EditableText';
import { PermissionCard } from './PermissionCard';
import { PromptInput, type PromptInputHandle } from './PromptInput';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import { ScalablePanel } from './ScalablePanel';
import { TaskBranchInfoBar } from './TaskBranchInfoBar';
import { TaskTitleBar } from './TaskTitleBar';
import { createTaskAiTerminalSection } from './task-panel/TaskAiTerminalSection';
import { createTaskCoordinatorSection } from './task-panel/TaskCoordinatorSectionEntry';
import { createTaskPanelDialogState } from './task-panel/task-panel-dialog-state';
import { createTaskPanelFocusRuntime } from './task-panel/task-panel-focus-runtime';
import { createTaskPanelPermissionController } from './task-panel/task-panel-permission-controller';
import { createTaskNotesFilesSection } from './task-panel/TaskNotesFilesSectionEntry';
import { createTaskPanelPreviewController } from './task-panel/task-panel-preview-controller';
import { createTaskShellSection } from './task-panel/TaskShellSection';
import { createTaskPanelStepsController } from './task-panel/task-panel-steps-controller';

const CloseTaskDialog = lazyNamed(() => import('./CloseTaskDialog'), 'CloseTaskDialog');
const DiffViewerDialog = lazyNamed(() => import('./DiffViewerDialog'), 'DiffViewerDialog');
const EditProjectDialog = lazyNamed(() => import('./EditProjectDialog'), 'EditProjectDialog');
const MergeDialog = lazyNamed(() => import('./MergeDialog'), 'MergeDialog');
const PushDialog = lazyNamed(() => import('./PushDialog'), 'PushDialog');

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

export function TaskPanel(props: TaskPanelProps): JSX.Element {
  const taskId = untrack(() => props.task.id);
  const terminalTask = untrack(() => isTerminalTask(props.task));
  const electronRuntime = isElectronRuntime();
  const taskActivityNow = useTaskActivityNow();
  const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
  const [initialPromptUnsaved, setInitialPromptUnsaved] = createSignal(false);
  let previouslyActive = false;
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;
  let notesRef: HTMLTextAreaElement | undefined;
  let planFocusRef: HTMLDivElement | undefined;
  let changedFilesRef: HTMLDivElement | undefined;
  let titleEditHandle: EditableTextHandle | undefined;
  let promptHandle: PromptInputHandle | undefined;
  let cleanupTitleDrag: DragSessionCleanup | undefined;

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
  const permissionController = terminalTask
    ? null
    : createTaskPanelPermissionController({
        task: () => props.task,
      });

  function cancelTaskTerminalSwitchState(): void {
    cancelTerminalSwitchEchoGrace(taskId);
    cancelTerminalSwitchWindow(taskId, taskId);
  }

  function clearTitleDrag(): void {
    const cleanup = cleanupTitleDrag;
    cleanupTitleDrag = undefined;
    cleanup?.();
  }

  function startTaskTerminalSwitchWindow(): void {
    const hasTerminalSurface =
      props.task.agentIds.length > 0 || props.task.shellAgentIds.length > 0;
    if (!hasTerminalSurface) {
      return;
    }

    beginTerminalSwitchWindow(
      taskId,
      getTerminalExperimentSwitchTargetWindowMs(getVisibleTerminalCount()),
      getTerminalPerformanceExperimentConfig().switchWindowSettleDelayMs,
      taskId,
      3,
    );
  }

  createEffect(() => {
    const isActive = props.isActive;
    const gainedActive = isActive && !previouslyActive;
    const lostActive = !isActive && previouslyActive;
    previouslyActive = isActive;

    if (gainedActive) {
      startTaskTerminalSwitchWindow();
      return;
    }

    if (lostActive) {
      cancelTaskTerminalSwitchState();
    }
  });

  onCleanup(() => {
    clearTitleDrag();
    if (props.isActive) {
      cancelTaskTerminalSwitchState();
    }
  });

  createTaskPanelFocusRuntime({
    getChangedFilesRef: () => changedFilesRef,
    getDefaultFocusedPanel: getTaskFocusedPanel,
    getNotesRef: () => notesRef,
    getPanelRef: () => panelRef,
    getPlanContent: () => props.task.planContent,
    getPlanFocusRef: () => planFocusRef,
    getPromptRef: () => promptRef,
    getStoredTaskFocusedPanel,
    getTitleEditHandle: () => titleEditHandle,
    hasPromptPanel: !terminalTask,
    isActive: () => props.isActive && !store.sidebarFocused && !store.placeholderFocused,
    notesTab,
    registerFocusFn,
    showPlans: () => store.showPlans,
    taskId: () => taskId,
    triggerFocus,
    unregisterFocusFn,
  });

  function selectedTaskAgentId(): string | null {
    return getSelectedTaskAgentId(
      props.task,
      store.activeTaskId === props.task.id ? store.activeAgentId : null,
    );
  }

  function promptAgentId(): string | null {
    return selectedTaskAgentId() ?? permissionController?.firstAgentId() ?? null;
  }

  function selectedTaskAgent() {
    const agentId = selectedTaskAgentId();
    return agentId ? store.agents[agentId] : undefined;
  }

  function isHydraTask(): boolean {
    return isHydraAgentDef(selectedTaskAgent()?.def);
  }

  function handleApprovePermissionRequest(requestId: string): void {
    void permissionController?.approvePermissionRequest(requestId);
  }

  function handleDenyPermissionRequest(requestId: string): void {
    void permissionController?.denyPermissionRequest(requestId);
  }

  function handleTitleMouseDown(event: MouseEvent): void {
    clearTitleDrag();
    cleanupTitleDrag = handleDragReorder(event, {
      itemId: props.task.id,
      getTaskOrder: () => store.taskOrder,
      onSessionEnd: () => {
        cleanupTitleDrag = undefined;
      },
      onReorder: reorderTask,
      onTap: () => setActiveTask(props.task.id),
    });
  }
  const previewController = createTaskPanelPreviewController({
    applyTaskPortsEvent,
    destroyTaskContainersForTask,
    exposeTaskPortForTask,
    fetchTaskContainerLogsForTask,
    fetchTaskPortExposureCandidates,
    focusedPanel: () => getStoredTaskFocusedPanel(props.task.id),
    inspectTaskContainerForTask,
    getTaskPortSnapshot,
    isTaskPanelFocused,
    projectContainerConfig: () => getProject(props.task.projectId)?.containerConfig,
    projectPath: () => getProject(props.task.projectId)?.path ?? props.task.worktreePath,
    refreshTaskPreviewForTask,
    setTaskFocusedPanel,
    startTaskContainersForTask,
    stopTaskContainersForTask,
    taskId: () => props.task.id,
    unexposeTaskPortForTask,
    worktreePath: () => props.task.worktreePath,
  });
  const stepsController = createTaskPanelStepsController({
    focusedPanel: () => getStoredTaskFocusedPanel(props.task.id),
    isActive: () => props.isActive,
    onDiffFileClick: dialogState.setDiffFile,
    setTaskFocusedPanel,
    task: () => props.task,
  });

  function titleBar(): PanelChild {
    return {
      id: 'title',
      initialSize: 50,
      fixed: true,
      content: () => (
        <TaskTitleBar
          task={props.task}
          mergeAvailable={getCurrentTaskGitActionDecision('merge', props.task.id).allowed}
          pushAvailable={getCurrentTaskGitActionDecision('push', props.task.id).allowed}
          isActive={props.isActive}
          taskActivityStatus={getTaskActivityStatus(props.task.id, taskActivityNow())}
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
          onOpenMerge={() => requestTaskGitAction('merge', props.task.id, 'title-bar')}
          onOpenPush={() => requestTaskGitAction('push', props.task.id, 'title-bar')}
          onCollapse={() => {
            if (initialPromptUnsaved()) {
              showNotification(
                'Wait for the initial prompt draft to finish saving before collapsing.',
              );
              return;
            }
            void collapseTask(props.task.id);
          }}
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

  function promptInput(): PanelChild {
    return {
      id: 'prompt',
      initialSize: props.task.initialPromptDeliveryId ? 150 : 72,
      stable: true,
      minSize: props.task.initialPromptDeliveryId ? 112 : 54,
      maxSize: 300,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:prompt`}>
          <div
            onFocusIn={() => observeTaskPanelFocus(props.task.id, 'prompt')}
            onClick={() => setTaskFocusedPanel(props.task.id, 'prompt')}
            style={{ height: '100%', display: 'flex', 'flex-direction': 'column' }}
          >
            <For each={permissionController?.pendingPermissionEntries() ?? []}>
              {(entry) => (
                <PermissionCard
                  request={entry.request}
                  sourceLabel={entry.sourceLabel}
                  onApprove={handleApprovePermissionRequest}
                  onDeny={handleDenyPermissionRequest}
                />
              )}
            </For>
            <Show when={promptAgentId()} keyed>
              {(agentId) => (
                <PromptInput
                  taskId={props.task.id}
                  agentId={agentId}
                  initialPromptDeliveryId={props.task.initialPromptDeliveryId}
                  onInitialPromptUnsavedChange={setInitialPromptUnsaved}
                  prefillPrompt={props.task.prefillPrompt}
                  onPrefillConsumed={() => clearPrefillPrompt(props.task.id)}
                  setTextareaRef={(element) => {
                    promptRef = element;
                  }}
                  onHandle={(handle) => {
                    promptHandle = handle;
                  }}
                />
              )}
            </Show>
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
    baseBranch: () => props.task.baseBranch,
    bookmarks: projectBookmarks,
    isActive: () => props.isActive,
    projectMode: () => getProjectMode(props.task),
    shellAgentIds: () => props.task.shellAgentIds,
    taskId: () => taskId,
    taskInitialShellOwnership: () => props.task.taskInitialShellOwnership,
    worktreePath: () => props.task.worktreePath,
    primary: terminalTask,
  });
  const agentSections = terminalTask
    ? null
    : {
        aiTerminal: createTaskAiTerminalSection({
          isActive: () => props.isActive,
          onReuseLastPrompt: () => {
            if (props.task.lastPrompt && promptHandle && !promptHandle.getText()) {
              promptHandle.setText(props.task.lastPrompt);
            }
          },
          task: () => props.task,
        }),
        coordinator: createTaskCoordinatorSection({
          task: () => props.task,
        }),
      };

  const panelChildren = () => {
    const children: PanelChild[] = [titleBar(), branchInfoBar()];
    const nextPreviewSection = previewController.previewSection();
    if (nextPreviewSection) {
      children.push(nextPreviewSection);
    }
    children.push(notesAndFilesSection);
    const nextStepsSection = stepsController.stepsSection();
    if (nextStepsSection) {
      children.push(nextStepsSection);
    }
    if (terminalTask) {
      children.push(shellSection);
      return children;
    }
    if (props.task.coordinatorRole === 'coordinator' && agentSections) {
      children.push(agentSections.coordinator);
    }
    if (agentSections) {
      children.push(shellSection, agentSections.aiTerminal, promptInput());
    }
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

      <Suspense>
        <Show when={dialogState.showCloseConfirm()}>
          <CloseTaskDialog
            open
            task={props.task}
            unsavedInitialPrompt={initialPromptUnsaved()}
            onDone={() => dialogState.setShowCloseConfirm(false)}
          />
        </Show>
      </Suspense>
      <Suspense>
        <Show when={dialogState.showMergeConfirm()}>
          <MergeDialog
            open
            task={props.task}
            initialCleanup={getProject(props.task.projectId)?.deleteBranchOnClose ?? true}
            onDone={() => dialogState.setShowMergeConfirm(false)}
            onDiffFileClick={dialogState.setDiffFile}
          />
        </Show>
      </Suspense>
      <Suspense>
        <Show when={dialogState.showPushConfirm()}>
          <PushDialog
            open
            task={props.task}
            onStart={dialogState.handlePushStarted}
            onClose={() => {
              dialogState.setShowPushConfirm(false);
            }}
            onDone={dialogState.handlePushFinished}
          />
        </Show>
      </Suspense>
      <Suspense>
        <Show when={dialogState.diffFile()}>
          {(file) => (
            <DiffViewerDialog
              baseBranch={props.task.baseBranch}
              file={file()}
              worktreePath={props.task.worktreePath}
              projectRoot={getProject(props.task.projectId)?.path}
              branchName={props.task.branchName}
              taskId={props.task.id}
              agentId={selectedTaskAgentId() ?? props.task.agentIds[0]}
              onClose={() => dialogState.setDiffFile(null)}
            />
          )}
        </Show>
      </Suspense>
      <Suspense>
        <Show when={dialogState.editingProjectId()}>
          {(projectId) => (
            <EditProjectDialog
              project={getProject(projectId()) ?? null}
              onClose={() => dialogState.setEditingProjectId(null)}
            />
          )}
        </Show>
      </Suspense>
    </div>
  );
}
