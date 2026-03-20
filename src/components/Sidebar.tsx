import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';

import { OPEN_DISPLAY_NAME_DIALOG_ACTION } from '../app/app-action-keys';
import { openNewTaskDialog } from '../app/new-task-dialog-workflows';
import { pickAndAddProject, removeProjectWithTasks } from '../app/project-workflows';
import { ConnectPhoneModal } from './ConnectPhoneModal';
import { ConfirmDialog } from './ConfirmDialog';
import { EditProjectDialog } from './EditProjectDialog';
import { IconButton } from './IconButton';
import { SidebarFooter } from './SidebarFooter';
import { SidebarProjectsSection } from './sidebar/SidebarProjectsSection';
import { SidebarRemoteAccessButton } from './sidebar/SidebarRemoteAccessButton';
import { SidebarTaskList } from './sidebar/SidebarTaskList';
import { computeVerticalDropIndex, startMouseDragSession } from '../lib/drag-reorder';
import { sf } from '../lib/fontScale';
import { isElectronRuntime } from '../lib/ipc';
import { mod } from '../lib/platform';
import { theme } from '../lib/theme';
import { computeGroupedTasks, SIDEBAR_ORPHANED_ACTIVE_GROUP_ID } from '../store/sidebar-order';
import {
  focusSidebar,
  getPanelSize,
  registerFocusFn,
  removeProject,
  reorderTaskWithinSidebarGroup,
  setActiveTask,
  setPanelSizes,
  store,
  triggerAction,
  toggleSettingsDialog,
  toggleSidebar,
  unregisterFocusFn,
} from '../store/store';
import type { Project } from '../store/types';

const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_SIZE_KEY = 'sidebar:width';

export function Sidebar(): JSX.Element {
  const electronRuntime = isElectronRuntime();
  const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
  const [editingProject, setEditingProject] = createSignal<Project | null>(null);
  const [showConnectPhone, setShowConnectPhone] = createSignal(false);
  const [dragState, setDragState] = createSignal<{ groupId: string; taskId: string } | null>(null);
  const [dropTarget, setDropTarget] = createSignal<{ groupId: string; index: number } | null>(null);
  const [resizing, setResizing] = createSignal(false);
  let taskListRef: HTMLDivElement | undefined;

  const sidebarWidth = () => getPanelSize(SIDEBAR_SIZE_KEY) ?? SIDEBAR_DEFAULT_WIDTH;
  const groupedTasks = createMemo(() => computeGroupedTasks());
  const confirmRemoveProjectState = createMemo(() => {
    const projectId = confirmRemove();
    if (!projectId) {
      return { projectId: null as string | null, taskCount: 0 };
    }

    const group = groupedTasks().grouped[projectId];
    return {
      projectId,
      taskCount: (group?.active.length ?? 0) + (group?.collapsed.length ?? 0),
    };
  });
  const remotePeerClients = () =>
    electronRuntime ? store.remoteAccess.connectedClients : store.remoteAccess.peerClients;
  const remoteAccessConnected = () => store.remoteAccess.enabled && remotePeerClients() > 0;

  function handleResizeMouseDown(event: MouseEvent): void {
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = sidebarWidth();

    function onMove(moveEvent: MouseEvent): void {
      const nextWidth = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      setPanelSizes({ [SIDEBAR_SIZE_KEY]: nextWidth });
    }

    function onUp(): void {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  onMount(() => {
    const taskListElement = taskListRef;
    if (taskListElement) {
      const handler = (event: MouseEvent) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-sidebar-draggable-task="true"]',
        );
        if (!target) return;
        const taskId = target.dataset.sidebarTaskId;
        const groupId = target.dataset.sidebarGroup;
        if (!taskId || !groupId) return;
        handleTaskMouseDown(event, taskId, groupId);
      };
      taskListElement.addEventListener('mousedown', handler);
      onCleanup(() => taskListElement.removeEventListener('mousedown', handler));
    }

    registerFocusFn('sidebar', () => taskListRef?.focus());
    onCleanup(() => unregisterFocusFn('sidebar'));
  });

  createEffect(() => {
    if (store.sidebarFocused) {
      taskListRef?.focus();
    }
  });

  createEffect(() => {
    const activeTaskId = store.activeTaskId;
    if (!activeTaskId || !taskListRef) return;
    const element = taskListRef.querySelector<HTMLElement>(
      `[data-sidebar-task-id="${CSS.escape(activeTaskId)}"]`,
    );
    element?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  createEffect(() => {
    const focusedTaskId = store.sidebarFocusedTaskId;
    if (!focusedTaskId || !taskListRef) return;
    const element = taskListRef.querySelector<HTMLElement>(
      `[data-sidebar-task-id="${CSS.escape(focusedTaskId)}"]`,
    );
    element?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  createEffect(() => {
    const projectId = store.sidebarFocusedProjectId;
    if (!projectId) return;
    requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-project-id="${CSS.escape(projectId)}"]`,
      );
      element?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  });

  async function handleAddProject(): Promise<void> {
    await pickAndAddProject();
  }

  function handleRemoveProject(projectId: string): void {
    setConfirmRemove(projectId);
  }

  function getSidebarGroupTaskIds(groupId: string): string[] {
    if (groupId === SIDEBAR_ORPHANED_ACTIVE_GROUP_ID) {
      return groupedTasks().orphanedActive;
    }

    return groupedTasks().grouped[groupId]?.active ?? [];
  }

  function computeDropIndex(clientY: number, groupId: string, fallbackIndex: number): number {
    const escapedGroupId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(groupId)
        : groupId.replace(/["\\]/g, '\\$&');
    return computeVerticalDropIndex({
      clientY,
      container: taskListRef,
      fallbackIndex,
      itemSelector: `[data-sidebar-draggable-task="true"][data-sidebar-group="${escapedGroupId}"]`,
    });
  }

  function handleTaskMouseDown(event: MouseEvent, taskId: string, groupId: string): void {
    startMouseDragSession({
      event,
      onDragStart: () => {
        setDragState({ groupId, taskId });
        document.body.classList.add('dragging-task');
      },
      onDragMove: (moveEvent) => {
        const initialIndex = getSidebarGroupTaskIds(groupId).indexOf(taskId);
        if (initialIndex === -1) {
          setDropTarget(null);
          return;
        }

        setDropTarget({
          groupId,
          index: computeDropIndex(moveEvent.clientY, groupId, initialIndex),
        });
      },
      onDragEnd: (didDrag) => {
        const currentDragState = dragState();
        const currentDropTarget = dropTarget();
        setDragState(null);
        setDropTarget(null);
        document.body.classList.remove('dragging-task');

        if (!didDrag) {
          setActiveTask(taskId);
          focusSidebar();
          return;
        }

        if (
          currentDragState &&
          currentDropTarget &&
          currentDragState.groupId === currentDropTarget.groupId
        ) {
          reorderTaskWithinSidebarGroup(
            currentDragState.taskId,
            currentDropTarget.groupId,
            currentDropTarget.index,
          );
        }
      },
    });
  }

  return (
    <div
      style={{
        width: `${sidebarWidth()}px`,
        'min-width': `${SIDEBAR_MIN_WIDTH}px`,
        'max-width': `${SIDEBAR_MAX_WIDTH}px`,
        display: 'flex',
        'flex-shrink': '0',
        'user-select': resizing() ? 'none' : undefined,
      }}
    >
      <div
        style={{
          flex: '1',
          'min-width': '0',
          display: 'flex',
          'flex-direction': 'column',
          padding: '16px',
          gap: '16px',
          'user-select': 'none',
        }}
      >
        <div
          style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}
        >
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '0 2px' }}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 56 56"
              fill="none"
              stroke={theme.fg}
              stroke-width="4"
              style={{ 'flex-shrink': '0' }}
            >
              <line x1="10" y1="6" x2="10" y2="50" />
              <line x1="22" y1="6" x2="22" y2="50" />
              <path d="M30 8 H47 V24 H30" />
              <path d="M49 32 H32 V48 H49" />
            </svg>
            <span
              style={{
                'font-size': sf(14),
                'font-weight': '600',
                color: theme.fg,
                'font-family': "'JetBrains Mono', monospace",
              }}
            >
              ParallelCode
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <Show when={!electronRuntime}>
              <IconButton
                icon={
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.75 2A1.75 1.75 0 0 0 2 3.75v8.5C2 13.22 2.78 14 3.75 14h8.5A1.75 1.75 0 0 0 14 12.25v-8.5A1.75 1.75 0 0 0 12.25 2h-8.5Zm1.5 3a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5H6A.75.75 0 0 1 5.25 5Zm0 3a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5H6A.75.75 0 0 1 5.25 8Zm.75 2.25a.75.75 0 0 0 0 1.5h2a.75.75 0 0 0 0-1.5H6Z" />
                  </svg>
                }
                onClick={() => triggerAction(OPEN_DISPLAY_NAME_DIALOG_ACTION)}
                title="Edit session name"
              />
            </Show>
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 2.25a.75.75 0 0 1 .73.56l.2.72a4.48 4.48 0 0 1 1.04.43l.66-.37a.75.75 0 0 1 .9.13l.75.75a.75.75 0 0 1 .13.9l-.37.66c.17.33.31.68.43 1.04l.72.2a.75.75 0 0 1 .56.73v1.06a.75.75 0 0 1-.56.73l-.72.2a4.48 4.48 0 0 1-.43 1.04l.37.66a.75.75 0 0 1-.13.9l-.75.75a.75.75 0 0 1-.9.13l-.66-.37a4.48 4.48 0 0 1-1.04.43l-.2.72a.75.75 0 0 1-.73.56H6.94a.75.75 0 0 1-.73-.56l-.2-.72a4.48 4.48 0 0 1-1.04-.43l-.66.37a.75.75 0 0 1-.9-.13l-.75-.75a.75.75 0 0 1-.13-.9l.37-.66a4.48 4.48 0 0 1-.43-1.04l-.72-.2a.75.75 0 0 1-.56-.73V7.47a.75.75 0 0 1 .56-.73l.72-.2c.11-.36.26-.71.43-1.04l-.37-.66a.75.75 0 0 1 .13-.9l.75-.75a.75.75 0 0 1 .9-.13l.66.37c.33-.17.68-.31 1.04-.43l.2-.72a.75.75 0 0 1 .73-.56H8Zm-.53 3.22a2.5 2.5 0 1 0 1.06 4.88 2.5 2.5 0 0 0-1.06-4.88Z" />
                </svg>
              }
              onClick={() => toggleSettingsDialog(true)}
              title={`Settings (${mod}+,)`}
            />
            <IconButton
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
                </svg>
              }
              onClick={() => toggleSidebar()}
              title={`Collapse sidebar (${mod}+B)`}
            />
          </div>
        </div>

        <SidebarProjectsSection
          onAddProject={handleAddProject}
          onEditProject={setEditingProject}
          onRemoveProject={handleRemoveProject}
        />

        <div style={{ height: '1px', background: theme.border }} />

        <Show
          when={store.projects.length > 0}
          fallback={
            <button
              class="icon-btn"
              onClick={() => pickAndAddProject()}
              style={{
                background: 'transparent',
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '8px 14px',
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': sf(12),
                'font-weight': '500',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                gap: '6px',
                width: '100%',
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
              </svg>
              Link Project
            </button>
          }
        >
          <button
            class="icon-btn"
            onClick={() => openNewTaskDialog()}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '8px 14px',
              color: theme.fgMuted,
              cursor: 'pointer',
              'font-size': sf(12),
              'font-weight': '500',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              gap: '6px',
              width: '100%',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
            </svg>
            New Task
          </button>
        </Show>

        <SidebarTaskList
          dragState={dragState}
          dropTarget={dropTarget}
          groupedTasks={groupedTasks}
          onEditProject={setEditingProject}
          setTaskListRef={(element) => {
            taskListRef = element;
          }}
        />

        <SidebarRemoteAccessButton
          connected={remoteAccessConnected()}
          electronRuntime={electronRuntime}
          onClick={() => setShowConnectPhone(true)}
        />

        <SidebarFooter />

        <ConnectPhoneModal open={showConnectPhone()} onClose={() => setShowConnectPhone(false)} />
        <EditProjectDialog project={editingProject()} onClose={() => setEditingProject(null)} />
        <ConfirmDialog
          open={confirmRemoveProjectState().projectId !== null}
          title="Remove project?"
          message={
            confirmRemoveProjectState().taskCount > 0
              ? `This project has ${confirmRemoveProjectState().taskCount} open task(s). Removing it will also close all tasks, delete their worktrees and branches.`
              : 'Are you sure you want to remove this project?'
          }
          confirmLabel={confirmRemoveProjectState().taskCount > 0 ? 'Remove all' : 'Remove'}
          danger
          onConfirm={() => {
            const { projectId, taskCount } = confirmRemoveProjectState();
            if (projectId) {
              if (taskCount > 0) {
                removeProjectWithTasks(projectId);
              } else {
                removeProject(projectId);
              }
            }
            setConfirmRemove(null);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      </div>

      <div
        class={`resize-handle resize-handle-h${resizing() ? ' dragging' : ''}`}
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );
}
