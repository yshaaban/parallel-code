import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';

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
import {
  focusSidebar,
  getPanelSize,
  pickAndAddProject,
  registerFocusFn,
  removeProject,
  removeProjectWithTasks,
  reorderTask,
  setActiveTask,
  setPanelSizes,
  store,
  toggleNewTaskDialog,
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
  const [dragFromIndex, setDragFromIndex] = createSignal<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = createSignal<number | null>(null);
  const [resizing, setResizing] = createSignal(false);
  let taskListRef: HTMLDivElement | undefined;

  const sidebarWidth = () => getPanelSize(SIDEBAR_SIZE_KEY) ?? SIDEBAR_DEFAULT_WIDTH;
  const taskIndexById = createMemo(() => {
    const map = new Map<string, number>();
    store.taskOrder.forEach((taskId, index) => map.set(taskId, index));
    return map;
  });
  const groupedTasks = createMemo(() => {
    const grouped: Record<string, string[]> = {};
    const orphaned: string[] = [];
    const projectIds = new Set(store.projects.map((project) => project.id));

    for (const taskId of store.taskOrder) {
      const task = store.tasks[taskId];
      if (!task) continue;

      const projectId = task.projectId;
      if (projectId && projectIds.has(projectId)) {
        (grouped[projectId] ??= []).push(taskId);
      } else {
        orphaned.push(taskId);
      }
    }

    return { grouped, orphaned };
  });
  const collapsedTasks = createMemo(() =>
    store.collapsedTaskOrder.filter((taskId) => store.tasks[taskId]?.collapsed),
  );
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
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-task-index]');
        if (!target) return;
        const index = Number(target.dataset.taskIndex);
        const taskId = store.taskOrder[index];
        if (taskId === undefined || taskId === null) return;
        handleTaskMouseDown(event, taskId, index);
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
    const index = taskIndexById().get(activeTaskId);
    if (index === undefined) return;
    const element = taskListRef.querySelector<HTMLElement>(
      `[data-task-index="${CSS.escape(String(index))}"]`,
    );
    element?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  createEffect(() => {
    const focusedTaskId = store.sidebarFocusedTaskId;
    if (!focusedTaskId || !taskListRef) return;
    const index = taskIndexById().get(focusedTaskId);
    if (index === undefined) return;
    const element = taskListRef.querySelector<HTMLElement>(
      `[data-task-index="${CSS.escape(String(index))}"]`,
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
    const hasTasks =
      store.taskOrder.some((taskId) => store.tasks[taskId]?.projectId === projectId) ||
      store.collapsedTaskOrder.some((taskId) => store.tasks[taskId]?.projectId === projectId);
    if (hasTasks) {
      setConfirmRemove(projectId);
      return;
    }
    removeProject(projectId);
  }

  function computeDropIndex(clientY: number, fromIndex: number): number {
    return computeVerticalDropIndex({
      clientY,
      container: taskListRef,
      fallbackIndex: fromIndex,
      itemSelector: '[data-task-index]',
    });
  }

  function handleTaskMouseDown(event: MouseEvent, taskId: string, index: number): void {
    startMouseDragSession({
      event,
      onDragStart: () => {
        setDragFromIndex(index);
        document.body.classList.add('dragging-task');
      },
      onDragMove: (moveEvent) => {
        setDropTargetIndex(computeDropIndex(moveEvent.clientY, index));
      },
      onDragEnd: (didDrag) => {
        if (!didDrag) {
          setActiveTask(taskId);
          focusSidebar();
          return;
        }

        document.body.classList.remove('dragging-task');
        const from = dragFromIndex();
        const to = dropTargetIndex();
        setDragFromIndex(null);
        setDropTargetIndex(null);

        if (from !== null && to !== null && from !== to) {
          const adjustedTo = to > from ? to - 1 : to;
          reorderTask(from, adjustedTo);
        }
      },
    });
  }

  function globalIndex(taskId: string): number {
    return taskIndexById().get(taskId) ?? -1;
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
            onClick={() => toggleNewTaskDialog(true)}
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
          collapsedTasks={collapsedTasks}
          dragFromIndex={dragFromIndex}
          dropTargetIndex={dropTargetIndex}
          globalIndex={globalIndex}
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
          open={confirmRemove() !== null}
          title="Remove project?"
          message={`This project has ${
            [...store.taskOrder, ...store.collapsedTaskOrder].filter(
              (taskId) => store.tasks[taskId]?.projectId === confirmRemove(),
            ).length
          } open task(s). Removing it will also close all tasks, delete their worktrees and branches.`}
          confirmLabel="Remove all"
          danger
          onConfirm={() => {
            const projectId = confirmRemove();
            if (projectId) {
              removeProjectWithTasks(projectId);
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
