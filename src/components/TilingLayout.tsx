import {
  ErrorBoundary,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { store, closeTerminal, toggleAddProjectDialog } from '../store/store';
import { isAppStartupPresentationPending } from '../app/app-startup-status';
import { listPendingTaskCreations } from '../app/task-creation-optimism';
import { hasUnsavedDesktopTaskNotes } from '../app/task-notes-recovery-channel';
import { closeTask } from '../app/task-workflows';
import { getCachedWorkspaceShape } from '../app/workspace-shape-cache';
import { getProject } from '../store/projects';
import { ResizablePanel, type PanelChild, type ResizablePanelHandle } from './ResizablePanel';
import { PendingTaskColumn } from './PendingTaskColumn';
import { TaskPanel } from './TaskPanel';
import { TerminalPanel } from './TerminalPanel';
import { NewTaskPlaceholder } from './NewTaskPlaceholder';
import { WorkspaceStartupSkeleton } from './WorkspaceStartupSkeleton';
import { isTaskRemoving, isTerminalRemoving } from '../domain/task-closing';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { mod } from '../lib/platform';
import { createCtrlShiftWheelResizeHandler } from '../lib/wheelZoom';
import { confirm } from '../lib/dialog';
import { shouldAnimateTaskAppearance } from '../lib/reduced-motion';
import { getEmergencyTaskCloseMessage } from './task-close-policy';

export function TilingLayout(): JSX.Element {
  let containerRef: HTMLDivElement | undefined;
  let panelHandle: ResizablePanelHandle | undefined;

  onMount(() => {
    if (!containerRef) return;
    const handleWheel = createCtrlShiftWheelResizeHandler((deltaPx) => {
      panelHandle?.resizeAll(deltaPx);
    });
    containerRef.addEventListener('wheel', handleWheel, { passive: false });
    onCleanup(() => containerRef?.removeEventListener('wheel', handleWheel));
  });

  // Scroll the active task panel into view when selection changes
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!activeId || !containerRef) return;
    const el = containerRef.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });
  // Startup skeleton: a returning user (cached workspace shape) never sees
  // first-run onboarding while startup presentation is still pending; the
  // skeleton self-exits the moment real workspace shape lands.
  const startupSkeletonShape = createMemo(() => {
    if (
      !isAppStartupPresentationPending() ||
      store.taskOrder.length > 0 ||
      store.collapsedTaskOrder.length > 0
    ) {
      return null;
    }

    return getCachedWorkspaceShape();
  });

  // Cache PanelChild objects by ID so <For> sees stable references
  // and doesn't unmount/remount panels when taskOrder changes.
  const panelCache = new Map<string, PanelChild>();

  const panelChildren = createMemo((): PanelChild[] => {
    const pendingCreations = listPendingTaskCreations();
    const currentIds = new Set<string>(store.taskOrder);
    for (const pending of pendingCreations) {
      currentIds.add(pending.pendingId);
    }
    currentIds.add('__placeholder');

    // Remove stale entries for deleted tasks
    for (const key of panelCache.keys()) {
      if (!currentIds.has(key)) panelCache.delete(key);
    }

    const panels: PanelChild[] = store.taskOrder.map((panelId) => {
      let cached = panelCache.get(panelId);
      if (!cached) {
        cached = {
          id: panelId,
          initialSize: 520,
          minSize: 300,
          content: () => {
            const [appearancePending, setAppearancePending] = createSignal(
              shouldAnimateTaskAppearance(),
            );
            const task = store.tasks[panelId];
            const terminal = store.terminals[panelId];
            // eslint-disable-next-line solid/components-return-once
            if (!task && !terminal) return <div />;
            return (
              <div
                data-task-id={panelId}
                class={
                  isTaskRemoving(task) || isTerminalRemoving(terminal)
                    ? 'task-removing'
                    : appearancePending()
                      ? 'task-appearing'
                      : undefined
                }
                style={{
                  height: '100%',
                  padding: 'var(--space-xs) var(--space-2xs) var(--space-sm)',
                }}
                onAnimationEnd={(e) => {
                  if (e.currentTarget === e.target && e.animationName === 'taskAppear') {
                    setAppearancePending(false);
                  }
                }}
                onAnimationCancel={(e) => {
                  if (e.currentTarget === e.target && e.animationName === 'taskAppear') {
                    setAppearancePending(false);
                  }
                }}
              >
                <ErrorBoundary
                  fallback={(err, reset) => (
                    <div
                      style={{
                        height: '100%',
                        display: 'flex',
                        'flex-direction': 'column',
                        'align-items': 'center',
                        'justify-content': 'center',
                        gap: 'var(--space-md)',
                        padding: 'var(--space-xl)',
                        background: theme.islandBg,
                        'border-radius': '12px',
                        border: `1px solid ${theme.border}`,
                        color: theme.fgMuted,
                        ...typography.ui,
                      }}
                    >
                      <div style={{ color: theme.error, ...typography.uiStrong }}>
                        Panel crashed
                      </div>
                      <div
                        style={{
                          'text-align': 'center',
                          'word-break': 'break-word',
                          'max-width': '300px',
                        }}
                      >
                        {String(err)}
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                        <button
                          onClick={reset}
                          style={{
                            background: theme.bgElevated,
                            border: `1px solid ${theme.border}`,
                            color: theme.fg,
                            padding: 'var(--space-xs) var(--space-md)',
                            'border-radius': '6px',
                            cursor: 'pointer',
                          }}
                        >
                          Retry
                        </button>
                        <button
                          onClick={async () => {
                            const task = store.tasks[panelId];
                            if (task) {
                              const hasUnsavedTaskNotes = hasUnsavedDesktopTaskNotes(panelId);
                              const closeMessage = getEmergencyTaskCloseMessage(
                                task,
                                getProject(task.projectId),
                              );
                              const message = hasUnsavedTaskNotes
                                ? `${closeMessage}\n\nUnsaved task notes will also be discarded.`
                                : closeMessage;
                              if (await confirm(message)) {
                                void closeTask(panelId, {
                                  taskNotesDiscardConfirmed: hasUnsavedTaskNotes,
                                });
                              }
                            } else if (store.terminals[panelId]) {
                              closeTerminal(panelId);
                            }
                          }}
                          style={{
                            background: theme.bgElevated,
                            border: `1px solid ${theme.border}`,
                            color: theme.error,
                            padding: 'var(--space-xs) var(--space-md)',
                            'border-radius': '6px',
                            cursor: 'pointer',
                          }}
                        >
                          {store.tasks[panelId] ? 'Close Task' : 'Close Terminal'}
                        </button>
                      </div>
                    </div>
                  )}
                >
                  <Show
                    when={store.tasks[panelId]}
                    fallback={
                      <Show when={store.terminals[panelId]}>
                        {(currentTerminal) => (
                          <TerminalPanel
                            terminal={currentTerminal()}
                            isActive={store.activeTaskId === panelId}
                          />
                        )}
                      </Show>
                    }
                  >
                    {(currentTask) => (
                      <TaskPanel task={currentTask()} isActive={store.activeTaskId === panelId} />
                    )}
                  </Show>
                </ErrorBoundary>
              </div>
            );
          },
        };
        panelCache.set(panelId, cached);
      }
      return cached;
    });

    // Provisional creation ghosts render between real tasks and the
    // placeholder; they never enter store.taskOrder.
    for (const pending of pendingCreations) {
      let cached = panelCache.get(pending.pendingId);
      if (!cached) {
        const pendingId = pending.pendingId;
        cached = {
          id: pendingId,
          initialSize: 520,
          minSize: 300,
          // Provisional ids never reach persisted panel sizes.
          transient: true,
          content: () => {
            const currentPending = listPendingTaskCreations().find(
              (entry) => entry.pendingId === pendingId,
            );
            // eslint-disable-next-line solid/components-return-once
            if (!currentPending) return <div />;
            return <PendingTaskColumn pending={currentPending} />;
          },
        };
        panelCache.set(pending.pendingId, cached);
      }
      panels.push(cached);
    }

    let placeholder = panelCache.get('__placeholder');
    if (!placeholder) {
      placeholder = {
        id: '__placeholder',
        initialSize: 54,
        fixed: true,
        content: () => <NewTaskPlaceholder />,
      };
      panelCache.set('__placeholder', placeholder);
    }
    panels.push(placeholder);

    return panels;
  });

  return (
    <div
      ref={containerRef}
      style={{
        flex: '1',
        'overflow-x': 'auto',
        'overflow-y': 'hidden',
        height: '100%',
        padding: 'var(--space-xs) var(--space-sm) var(--space-sm)',
      }}
    >
      <Show
        when={!startupSkeletonShape()}
        fallback={<WorkspaceStartupSkeleton shape={startupSkeletonShape()} />}
      >
        <Show
          when={store.taskOrder.length > 0 || listPendingTaskCreations().length > 0}
          fallback={
            <div
              class="empty-state"
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                width: '100%',
                height: '100%',
                'flex-direction': 'column',
                gap: 'var(--space-xl)',
              }}
            >
              <Show
                when={store.collapsedTaskOrder.length === 0}
                fallback={
                  <div style={{ 'text-align': 'center', display: 'grid', gap: 'var(--space-2xs)' }}>
                    <div
                      style={{
                        color: theme.fgMuted,
                        ...typography.title,
                      }}
                    >
                      All tasks are collapsed
                    </div>
                    <div style={{ color: theme.fgSubtle, ...typography.meta }}>
                      Click a task in the sidebar to restore it
                    </div>
                  </div>
                }
              >
                <Show
                  when={store.projects.length > 0}
                  fallback={
                    <>
                      <div
                        style={{
                          width: '56px',
                          height: '56px',
                          'border-radius': '16px',
                          background: theme.islandBg,
                          border: `1px solid ${theme.border}`,
                          display: 'flex',
                          'align-items': 'center',
                          'justify-content': 'center',
                          color: theme.fgSubtle,
                        }}
                      >
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                        </svg>
                      </div>
                      <div
                        style={{ 'text-align': 'center', display: 'grid', gap: 'var(--space-2xs)' }}
                      >
                        <div
                          style={{
                            color: theme.fgMuted,
                            ...typography.title,
                          }}
                        >
                          Link your first project to get started
                        </div>
                        <div style={{ color: theme.fgSubtle, ...typography.meta }}>
                          A project is a local folder with your code
                        </div>
                      </div>
                      <button
                        onClick={() => toggleAddProjectDialog(true)}
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '8px',
                          padding: 'var(--space-sm) var(--space-lg)',
                          color: theme.fg,
                          cursor: 'pointer',
                          display: 'flex',
                          'align-items': 'center',
                          gap: 'var(--space-xs)',
                          ...typography.uiStrong,
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
                    </>
                  }
                >
                  <div
                    style={{
                      width: '56px',
                      height: '56px',
                      'border-radius': '16px',
                      background: theme.islandBg,
                      border: `1px solid ${theme.border}`,
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'center',
                      'font-size': '24px',
                      color: theme.fgSubtle,
                    }}
                  >
                    +
                  </div>
                  <div style={{ 'text-align': 'center', display: 'grid', gap: 'var(--space-2xs)' }}>
                    <div
                      style={{
                        color: theme.fgMuted,
                        ...typography.title,
                      }}
                    >
                      No tasks yet
                    </div>
                    <div style={{ color: theme.fgSubtle, ...typography.meta }}>
                      Press{' '}
                      <kbd
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '4px',
                          padding: '2px var(--space-xs)',
                          ...typography.monoMeta,
                        }}
                      >
                        {mod}+N
                      </kbd>{' '}
                      to create a new task
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          }
        >
          <ResizablePanel
            direction="horizontal"
            children={panelChildren()}
            fitContent
            persistKey="tiling"
            onHandle={(handle) => {
              panelHandle = handle;
            }}
          />
        </Show>
      </Show>
    </div>
  );
}
