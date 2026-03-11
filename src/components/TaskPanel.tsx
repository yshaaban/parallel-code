import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  store,
  retryCloseTask,
  setActiveTask,
  markAgentExited,
  restartAgent,
  switchAgent,
  updateTaskName,
  updateTaskNotes,
  spawnShellForTask,
  runBookmarkInTask,
  closeShell,
  setLastPrompt,
  clearInitialPrompt,
  clearPrefillPrompt,
  getProject,
  reorderTask,
  getFontScale,
  getTaskDotStatus,
  markAgentOutput,
  registerFocusFn,
  unregisterFocusFn,
  setTaskFocusedPanel,
  triggerFocus,
  clearPendingAction,
  collapseTask,
  handlePermissionResponse,
  setReviewPanelOpen,
} from '../store/store';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import type { EditableTextHandle } from './EditableText';
import { InfoBar } from './InfoBar';
import { PromptInput, type PromptInputHandle } from './PromptInput';
import { ChangedFilesList } from './ChangedFilesList';
import { TerminalView } from './TerminalView';
import { ScalablePanel } from './ScalablePanel';
import { Dialog } from './Dialog';
import { CloseTaskDialog } from './CloseTaskDialog';
import { MergeDialog } from './MergeDialog';
import { PushDialog } from './PushDialog';
import { DiffViewerDialog } from './DiffViewerDialog';
import { EditProjectDialog } from './EditProjectDialog';
import { ReviewPanel } from './ReviewPanel';
import { PermissionCard } from './PermissionCard';
import { AgentSwitchMenu } from './AgentSwitchMenu';
import { TaskBranchInfoBar } from './TaskBranchInfoBar';
import { TaskShellToolbar } from './TaskShellToolbar';
import { TaskTitleBar } from './TaskTitleBar';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { mod } from '../lib/platform';
import { isElectronRuntime } from '../lib/ipc';
import { consumePendingShellCommand } from '../lib/bookmarks';
import { handleDragReorder } from '../lib/dragReorder';
import { getHydraCommandOverride, isHydraAgentDef } from '../lib/hydra';
import { marked } from 'marked';
import type { AgentStatus, Task } from '../store/types';
import type { ChangedFile } from '../ipc/types';

interface TaskPanelProps {
  task: Task;
  isActive: boolean;
}

function getPromptStatusText(task: Task): string {
  if (task.lastPrompt) return `> ${task.lastPrompt}`;
  if (task.initialPrompt) return '⏳ Waiting to send prompt…';
  return 'No prompts sent';
}

function getAgentStatusBadgeText(status: AgentStatus): string | null {
  switch (status) {
    case 'paused':
      return 'Paused';
    case 'flow-controlled':
      return 'Flow controlled';
    case 'restoring':
      return 'Restoring';
    default:
      return null;
  }
}

function getAgentStatusBadgeColor(status: AgentStatus): string {
  switch (status) {
    case 'paused':
      return theme.warning;
    case 'restoring':
      return theme.accent;
    default:
      return theme.fgMuted;
  }
}

export function TaskPanel(props: TaskPanelProps): JSX.Element {
  const electronRuntime = isElectronRuntime();
  const [showCloseConfirm, setShowCloseConfirm] = createSignal(false);
  const [notesTab, setNotesTab] = createSignal<'notes' | 'plan'>('notes');
  const [planFullscreen, setPlanFullscreen] = createSignal(false);

  // Auto-switch to plan tab when plan content first appears
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

  const [showMergeConfirm, setShowMergeConfirm] = createSignal(false);
  const [showPushConfirm, setShowPushConfirm] = createSignal(false);
  const [pushSuccess, setPushSuccess] = createSignal(false);
  const [pushing, setPushing] = createSignal(false);
  let pushSuccessTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(pushSuccessTimer));
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null);
  const [shellExits, setShellExits] = createStore<
    Record<string, { exitCode: number | null; signal: string | null }>
  >({});
  let panelRef!: HTMLDivElement;
  let promptRef: HTMLTextAreaElement | undefined;
  let notesRef: HTMLTextAreaElement | undefined;
  let changedFilesRef: HTMLDivElement | undefined;
  let shellToolbarRef: HTMLDivElement | undefined;
  let titleEditHandle: EditableTextHandle | undefined;
  let promptHandle: PromptInputHandle | undefined;
  const [shellToolbarIdx, setShellToolbarIdx] = createSignal(0);
  const [shellToolbarFocused, setShellToolbarFocused] = createSignal(false);
  const projectBookmarks = () => getProject(props.task.projectId)?.terminalBookmarks ?? [];
  const editingProject = () => {
    const id = editingProjectId();
    return id ? (getProject(id) ?? null) : null;
  };

  // Focus registration for this task's panels
  onMount(() => {
    const id = props.task.id;
    registerFocusFn(`${id}:title`, () => titleEditHandle?.startEdit());
    registerFocusFn(`${id}:notes`, () => notesRef?.focus());
    registerFocusFn(`${id}:changed-files`, () => {
      changedFilesRef?.focus();
    });
    registerFocusFn(`${id}:prompt`, () => promptRef?.focus());
    registerFocusFn(`${id}:shell-toolbar`, () => shellToolbarRef?.focus());
    // Individual shell:N and ai-terminal focus fns are registered via TerminalView.onReady

    onCleanup(() => {
      unregisterFocusFn(`${id}:title`);
      unregisterFocusFn(`${id}:notes`);
      unregisterFocusFn(`${id}:changed-files`);
      unregisterFocusFn(`${id}:shell-toolbar`);
      // Individual shell:N focus fns are cleaned up by their own onCleanup
      unregisterFocusFn(`${id}:ai-terminal`);
      unregisterFocusFn(`${id}:prompt`);
    });
  });

  // Respond to focus panel changes from store
  createEffect(() => {
    if (!props.isActive) return;
    const panel = store.focusedPanel[props.task.id];
    if (panel) {
      triggerFocus(`${props.task.id}:${panel}`);
    }
  });

  // Auto-focus prompt when task first becomes active (if no panel set yet)
  let autoFocusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (autoFocusTimer !== undefined) clearTimeout(autoFocusTimer);
  });
  createEffect(() => {
    if (props.isActive && !store.focusedPanel[props.task.id]) {
      const id = props.task.id;
      if (autoFocusTimer !== undefined) clearTimeout(autoFocusTimer);
      autoFocusTimer = setTimeout(() => {
        autoFocusTimer = undefined;
        // Only focus prompt if no panel was set in the meantime
        if (!store.focusedPanel[id] && !panelRef.contains(document.activeElement)) {
          promptRef?.focus();
        }
      }, 0);
    }
  });

  // React to pendingAction from keyboard shortcuts
  createEffect(() => {
    const action = store.pendingAction;
    if (!action || action.taskId !== props.task.id) return;
    clearPendingAction();
    switch (action.type) {
      case 'close':
        setShowCloseConfirm(true);
        break;
      case 'merge':
        if (!props.task.directMode) openMergeConfirm();
        break;
      case 'push':
        if (!props.task.directMode) setShowPushConfirm(true);
        break;
    }
  });

  function openMergeConfirm() {
    setShowMergeConfirm(true);
  }

  const firstAgent = () => {
    const ids = props.task.agentIds;
    return ids.length > 0 ? store.agents[ids[0]] : undefined;
  };

  const isHydraTask = () => {
    const agent = firstAgent();
    return isHydraAgentDef(agent?.def);
  };

  const firstAgentId = () => props.task.agentIds[0] ?? '';
  const firstAgentStatusBadge = () => {
    const status = firstAgent()?.status;
    return status ? getAgentStatusBadgeText(status) : null;
  };
  const availableAgents = () =>
    store.availableAgents.filter((agentDef) => agentDef.available !== false);

  function handleTitleMouseDown(e: MouseEvent) {
    handleDragReorder(e, {
      itemId: props.task.id,
      getTaskOrder: () => store.taskOrder,
      onReorder: reorderTask,
      onTap: () => setActiveTask(props.task.id),
    });
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
          pushing={pushing()}
          pushSuccess={pushSuccess()}
          onMouseDown={handleTitleMouseDown}
          onUpdateTaskName={(value) => updateTaskName(props.task.id, value)}
          onSetTitleEditHandle={(handle) => {
            titleEditHandle = handle;
          }}
          onOpenMerge={openMergeConfirm}
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

  function notesAndFiles(): PanelChild {
    return {
      id: 'notes-files',
      initialSize: 150,
      minSize: 60,
      content: () => (
        <ResizablePanel
          direction="horizontal"
          persistKey={`task:${props.task.id}:notes-split`}
          children={[
            {
              id: 'notes',
              initialSize: 200,
              minSize: 100,
              content: () => (
                <ScalablePanel panelId={`${props.task.id}:notes`}>
                  <div
                    class="focusable-panel"
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      'flex-direction': 'column',
                    }}
                    onClick={() => setTaskFocusedPanel(props.task.id, 'notes')}
                  >
                    <Show when={store.showPlans && props.task.planContent}>
                      <div
                        style={{
                          display: 'flex',
                          'border-bottom': `1px solid ${theme.border}`,
                          'flex-shrink': '0',
                        }}
                      >
                        <button
                          style={{
                            padding: '2px 8px',
                            'font-size': sf(10),
                            background: notesTab() === 'notes' ? theme.taskPanelBg : 'transparent',
                            color: notesTab() === 'notes' ? theme.fg : theme.fgMuted,
                            border: 'none',
                            'border-bottom':
                              notesTab() === 'notes'
                                ? `2px solid ${theme.accent}`
                                : '2px solid transparent',
                            cursor: 'pointer',
                            'font-family': "'JetBrains Mono', monospace",
                          }}
                          onClick={() => setNotesTab('notes')}
                        >
                          Notes
                        </button>
                        <button
                          style={{
                            padding: '2px 8px',
                            'font-size': sf(10),
                            background: notesTab() === 'plan' ? theme.taskPanelBg : 'transparent',
                            color: notesTab() === 'plan' ? theme.fg : theme.fgMuted,
                            border: 'none',
                            'border-bottom':
                              notesTab() === 'plan'
                                ? `2px solid ${theme.accent}`
                                : '2px solid transparent',
                            cursor: 'pointer',
                            'font-family': "'JetBrains Mono', monospace",
                          }}
                          onClick={() => setNotesTab('plan')}
                        >
                          Plan
                        </button>
                        <button
                          style={{
                            'margin-left': 'auto',
                            padding: '2px 6px',
                            'font-size': sf(10),
                            background: 'transparent',
                            color: theme.fgMuted,
                            border: 'none',
                            cursor: 'pointer',
                            'font-family': "'JetBrains Mono', monospace",
                          }}
                          title="Open plan fullscreen"
                          onClick={() => setPlanFullscreen(true)}
                        >
                          {'⤢'}
                        </button>
                      </div>
                    </Show>

                    <Show
                      when={notesTab() === 'notes' || !store.showPlans || !props.task.planContent}
                    >
                      <textarea
                        ref={notesRef}
                        value={props.task.notes}
                        onInput={(e) => updateTaskNotes(props.task.id, e.currentTarget.value)}
                        placeholder="Notes..."
                        style={{
                          width: '100%',
                          flex: '1',
                          background: theme.taskPanelBg,
                          border: 'none',
                          padding: '6px 8px',
                          color: theme.fg,
                          'font-size': sf(11),
                          'font-family': "'JetBrains Mono', monospace",
                          resize: 'none',
                          outline: 'none',
                        }}
                      />
                    </Show>

                    <Show when={notesTab() === 'plan' && store.showPlans && props.task.planContent}>
                      <div
                        class="plan-markdown"
                        style={{
                          flex: '1',
                          overflow: 'auto',
                          padding: '6px 8px',
                          background: theme.taskPanelBg,
                          color: theme.fg,
                          'font-size': sf(11),
                          'font-family': "'JetBrains Mono', monospace",
                        }}
                        // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
                        innerHTML={
                          marked.parse(props.task.planContent ?? '', { async: false }) as string
                        }
                      />
                    </Show>
                  </div>
                </ScalablePanel>
              ),
            },
            {
              id: 'changed-files',
              initialSize: 200,
              minSize: 100,
              content: () => (
                <ScalablePanel panelId={`${props.task.id}:changed-files`}>
                  <div
                    style={{
                      height: '100%',
                      background: theme.taskPanelBg,
                      display: 'flex',
                      'flex-direction': 'column',
                    }}
                    onClick={() => setTaskFocusedPanel(props.task.id, 'changed-files')}
                  >
                    <div
                      style={{
                        padding: '4px 8px',
                        'font-size': sf(10),
                        'font-weight': '600',
                        color: theme.fgMuted,
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.05em',
                        'border-bottom': `1px solid ${theme.border}`,
                        'flex-shrink': '0',
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                      }}
                    >
                      <span>Changed Files</span>
                      <button
                        style={{
                          background: 'transparent',
                          border: `1px solid ${theme.border}`,
                          color: store.reviewPanelOpen[props.task.id]
                            ? theme.accent
                            : theme.fgMuted,
                          'font-size': sf(9),
                          'font-family': "'JetBrains Mono', monospace",
                          padding: '1px 6px',
                          'border-radius': '3px',
                          cursor: 'pointer',
                          'text-transform': 'none',
                          'letter-spacing': 'normal',
                          'font-weight': 'normal',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setReviewPanelOpen(props.task.id, !store.reviewPanelOpen[props.task.id]);
                        }}
                      >
                        {store.reviewPanelOpen[props.task.id] ? '← Files' : 'Review ▸'}
                      </button>
                    </div>
                    <div style={{ flex: '1', overflow: 'hidden' }}>
                      <Show
                        when={store.reviewPanelOpen[props.task.id]}
                        fallback={
                          <ChangedFilesList
                            worktreePath={props.task.worktreePath}
                            projectRoot={getProject(props.task.projectId)?.path}
                            branchName={props.task.branchName}
                            filterHydraArtifacts={isHydraTask()}
                            isActive={props.isActive}
                            onFileClick={setDiffFile}
                            ref={(el) => (changedFilesRef = el)}
                          />
                        }
                      >
                        <ReviewPanel
                          worktreePath={props.task.worktreePath}
                          projectRoot={getProject(props.task.projectId)?.path}
                          branchName={props.task.branchName}
                          isActive={props.isActive}
                        />
                      </Show>
                    </div>
                  </div>
                </ScalablePanel>
              ),
            },
          ]}
        />
      ),
    };
  }

  function shellSection(): PanelChild {
    return {
      id: 'shell-section',
      initialSize: 28,
      minSize: 28,
      get fixed() {
        return props.task.shellAgentIds.length === 0;
      },
      requestSize: () => (props.task.shellAgentIds.length > 0 ? 200 : 28),
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:shell`}>
          <div
            style={{
              height: '100%',
              display: 'flex',
              'flex-direction': 'column',
              background: 'transparent',
            }}
          >
            <TaskShellToolbar
              bookmarks={projectBookmarks()}
              focused={shellToolbarFocused()}
              selectedIndex={shellToolbarIdx()}
              openTerminalTitle={`Open terminal (${mod}+Shift+T)`}
              onToolbarClick={() => setTaskFocusedPanel(props.task.id, 'shell-toolbar')}
              onToolbarFocus={() => setShellToolbarFocused(true)}
              onToolbarBlur={() => setShellToolbarFocused(false)}
              onToolbarKeyDown={(event) => {
                const itemCount = 1 + projectBookmarks().length;
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  setShellToolbarIdx((index) => Math.min(itemCount - 1, index + 1));
                  return;
                }
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  setShellToolbarIdx((index) => Math.max(0, index - 1));
                  return;
                }
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const selectedIndex = shellToolbarIdx();
                if (selectedIndex === 0) {
                  spawnShellForTask(props.task.id);
                  return;
                }
                const bookmark = projectBookmarks()[selectedIndex - 1];
                if (bookmark) {
                  runBookmarkInTask(props.task.id, bookmark.command);
                }
              }}
              onOpenTerminal={(event) => {
                event.stopPropagation();
                spawnShellForTask(props.task.id);
              }}
              onRunBookmark={(command, event) => {
                event.stopPropagation();
                runBookmarkInTask(props.task.id, command);
              }}
              setToolbarRef={(element) => {
                shellToolbarRef = element;
              }}
            />
            <Show when={props.task.shellAgentIds.length > 0}>
              <div
                style={{
                  flex: '1',
                  display: 'flex',
                  overflow: 'hidden',
                  background: theme.taskContainerBg,
                  gap: '6px',
                  'margin-top': '6px',
                }}
              >
                <For each={props.task.shellAgentIds}>
                  {(shellId, i) => {
                    const initialCommand = consumePendingShellCommand(shellId);
                    let shellFocusFn: (() => void) | undefined;
                    let registeredKey: string | undefined;

                    // Re-register focus fn whenever the index changes (e.g. after a sibling is removed)
                    createEffect(() => {
                      const key = `${props.task.id}:shell:${i()}`;
                      if (registeredKey && registeredKey !== key) unregisterFocusFn(registeredKey);
                      if (shellFocusFn) registerFocusFn(key, shellFocusFn);
                      registeredKey = key;
                    });
                    onCleanup(() => {
                      if (registeredKey) unregisterFocusFn(registeredKey);
                    });

                    const isShellFocused = () =>
                      store.focusedPanel[props.task.id] === `shell:${i()}`;

                    return (
                      <div
                        class="focusable-panel shell-terminal-container"
                        data-shell-focused={isShellFocused() ? 'true' : 'false'}
                        style={{
                          flex: '1',
                          overflow: 'hidden',
                          position: 'relative',
                          background: theme.taskPanelBg,
                        }}
                        onClick={() => setTaskFocusedPanel(props.task.id, `shell:${i()}`)}
                      >
                        <button
                          class="shell-terminal-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeShell(props.task.id, shellId);
                          }}
                          title="Close terminal (Ctrl+Shift+Q)"
                          style={{
                            background: 'color-mix(in srgb, var(--island-bg) 85%, transparent)',
                            border: `1px solid ${theme.border}`,
                            color: theme.fgMuted,
                            cursor: 'pointer',
                            'border-radius': '6px',
                            padding: '2px 6px',
                            'line-height': '1',
                            'font-size': '14px',
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                          </svg>
                        </button>
                        <Show when={shellExits[shellId]}>
                          <div
                            class="exit-badge"
                            style={{
                              position: 'absolute',
                              top: '8px',
                              right: '12px',
                              'z-index': '10',
                              'font-size': sf(11),
                              color:
                                shellExits[shellId]?.exitCode === 0 ? theme.success : theme.error,
                              background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
                              padding: '4px 12px',
                              'border-radius': '8px',
                              border: `1px solid ${theme.border}`,
                            }}
                          >
                            Process exited ({shellExits[shellId]?.exitCode ?? '?'})
                          </div>
                        </Show>
                        <TerminalView
                          taskId={props.task.id}
                          agentId={shellId}
                          isShell
                          isFocused={
                            props.isActive && store.focusedPanel[props.task.id] === `shell:${i()}`
                          }
                          command={getShellCommand()}
                          args={['-l']}
                          cwd={props.task.worktreePath}
                          initialCommand={initialCommand}
                          onData={(data) => markAgentOutput(shellId, data, props.task.id)}
                          onExit={(info) =>
                            setShellExits(shellId, {
                              exitCode: info.exit_code,
                              signal: info.signal,
                            })
                          }
                          onReady={(focusFn) => {
                            shellFocusFn = focusFn;
                            if (registeredKey) registerFocusFn(registeredKey, focusFn);
                          }}
                          fontSize={Math.round(11 * getFontScale(`${props.task.id}:shell`))}
                          autoFocus
                        />
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </ScalablePanel>
      ),
    };
  }

  function aiTerminal(): PanelChild {
    return {
      id: 'ai-terminal',
      minSize: 80,
      content: () => (
        <ScalablePanel panelId={`${props.task.id}:ai-terminal`}>
          <div
            class="focusable-panel shell-terminal-container"
            data-shell-focused={
              store.focusedPanel[props.task.id] === 'ai-terminal' ? 'true' : 'false'
            }
            style={{
              height: '100%',
              position: 'relative',
              background: theme.taskPanelBg,
              display: 'flex',
              'flex-direction': 'column',
            }}
            onClick={() => setTaskFocusedPanel(props.task.id, 'ai-terminal')}
          >
            <InfoBar
              title={
                props.task.lastPrompt ||
                (props.task.initialPrompt ? 'Waiting to send prompt…' : 'No prompts sent yet')
              }
              onDblClick={() => {
                if (props.task.lastPrompt && promptHandle && !promptHandle.getText())
                  promptHandle.setText(props.task.lastPrompt);
              }}
            >
              <span style={{ opacity: props.task.lastPrompt ? 1 : 0.4 }}>
                {getPromptStatusText(props.task)}
              </span>
            </InfoBar>
            <div style={{ flex: '1', position: 'relative', overflow: 'hidden' }}>
              <Show when={firstAgent()}>
                {(a) => (
                  <>
                    <Show when={a().status === 'exited'}>
                      <div
                        class="exit-badge"
                        title={a().lastOutput.length ? a().lastOutput.join('\n') : undefined}
                        style={{
                          position: 'absolute',
                          top: '8px',
                          right: '12px',
                          'z-index': '10',
                          'font-size': sf(11),
                          color: a().exitCode === 0 ? theme.success : theme.error,
                          background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
                          padding: '4px 12px',
                          'border-radius': '8px',
                          border: `1px solid ${theme.border}`,
                          display: 'flex',
                          'align-items': 'center',
                          gap: '8px',
                        }}
                      >
                        <span>
                          {a().signal === 'spawn_failed'
                            ? 'Failed to start'
                            : `Process exited (${a().exitCode ?? '?'})`}
                        </span>
                        <AgentSwitchMenu
                          currentAgentDefId={a().def.id}
                          availableAgents={availableAgents()}
                          onRestartCurrent={() => restartAgent(a().id, false)}
                          onSelectAgent={(agentDef) => {
                            if (agentDef.id === a().def.id) {
                              restartAgent(a().id, false);
                              return;
                            }
                            switchAgent(a().id, agentDef);
                          }}
                        />
                        <Show when={a().def.resume_args?.length}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              restartAgent(a().id, true);
                            }}
                            style={{
                              background: theme.bgElevated,
                              border: `1px solid ${theme.border}`,
                              color: theme.fg,
                              padding: '2px 8px',
                              'border-radius': '4px',
                              cursor: 'pointer',
                              'font-size': sf(10),
                            }}
                          >
                            Resume
                          </button>
                        </Show>
                      </div>
                    </Show>
                    <Show when={a().status !== 'running' && a().status !== 'exited'}>
                      <div
                        style={{
                          position: 'absolute',
                          top: '8px',
                          right: '12px',
                          'z-index': '10',
                          'font-size': sf(11),
                          color: getAgentStatusBadgeColor(a().status),
                          background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
                          padding: '4px 12px',
                          'border-radius': '8px',
                          border: `1px solid ${theme.border}`,
                        }}
                      >
                        {getAgentStatusBadgeText(a().status)}
                      </div>
                    </Show>
                    <Show when={`${a().id}:${a().generation}`} keyed>
                      <TerminalView
                        taskId={props.task.id}
                        agentId={a().id}
                        isFocused={
                          props.isActive && store.focusedPanel[props.task.id] === 'ai-terminal'
                        }
                        args={[
                          ...new Set([
                            ...(a().resumed && a().def.resume_args?.length
                              ? (a().def.resume_args ?? [])
                              : a().def.args),
                            ...(props.task.skipPermissions && a().def.skip_permissions_args?.length
                              ? (a().def.skip_permissions_args ?? [])
                              : []),
                          ]),
                        ]}
                        command={
                          isHydraAgentDef(a().def)
                            ? getHydraCommandOverride(a().def, store.hydraCommand)
                            : a().def.command
                        }
                        adapter={a().def.adapter}
                        cwd={props.task.worktreePath}
                        env={
                          isHydraAgentDef(a().def)
                            ? {
                                PARALLEL_CODE_HYDRA_STARTUP_MODE: store.hydraStartupMode,
                              }
                            : undefined
                        }
                        onExit={(code) => markAgentExited(a().id, code)}
                        onData={(data) => markAgentOutput(a().id, data, props.task.id)}
                        onPromptDetected={(text) => setLastPrompt(props.task.id, text)}
                        onReady={(focusFn) =>
                          registerFocusFn(`${props.task.id}:ai-terminal`, focusFn)
                        }
                        fontSize={Math.round(13 * getFontScale(`${props.task.id}:ai-terminal`))}
                      />
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        </ScalablePanel>
      ),
    };
  }

  function pendingPermission() {
    const agentId = firstAgentId();
    if (!agentId) return undefined;
    const requests = store.permissionRequests[agentId];
    if (!requests) return undefined;
    return requests.find((r) => r.status === 'pending');
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
              {(req) => (
                <PermissionCard
                  request={req()}
                  onApprove={(id) => {
                    const agentId = firstAgentId();
                    if (agentId) void handlePermissionResponse(agentId, id, 'approve');
                  }}
                  onDeny={(id) => {
                    const agentId = firstAgentId();
                    if (agentId) void handlePermissionResponse(agentId, id, 'deny');
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
                if (props.task.initialPrompt) clearInitialPrompt(props.task.id);
              }}
              onPrefillConsumed={() => clearPrefillPrompt(props.task.id)}
              ref={(el) => (promptRef = el)}
              handle={(h) => (promptHandle = h)}
            />
          </div>
        </ScalablePanel>
      ),
    };
  }

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
              onClick={(e) => {
                e.stopPropagation();
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
        children={[
          titleBar(),
          branchInfoBar(),
          notesAndFiles(),
          shellSection(),
          aiTerminal(),
          promptInput(),
        ]}
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
        onStart={() => {
          setPushing(true);
          setPushSuccess(false);
          clearTimeout(pushSuccessTimer);
        }}
        onDone={(success) => {
          setShowPushConfirm(false);
          setPushing(false);
          if (success) {
            setPushSuccess(true);
            pushSuccessTimer = setTimeout(() => setPushSuccess(false), 3000);
          }
        }}
      />
      <DiffViewerDialog
        file={diffFile()}
        worktreePath={props.task.worktreePath}
        projectRoot={getProject(props.task.projectId)?.path}
        branchName={props.task.branchName}
        onClose={() => setDiffFile(null)}
      />
      <EditProjectDialog project={editingProject()} onClose={() => setEditingProjectId(null)} />
      <Dialog open={planFullscreen()} onClose={() => setPlanFullscreen(false)} width="800px">
        <div
          class="plan-markdown"
          style={{
            color: theme.fg,
            'font-size': '15px',
            'font-family': "'JetBrains Mono', monospace",
            'max-height': '70vh',
            overflow: 'auto',
          }}
          // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
          innerHTML={marked.parse(props.task.planContent ?? '', { async: false }) as string}
        />
      </Dialog>
    </div>
  );
}

function getShellCommand(): string {
  // Empty string tells the backend to use $SHELL (Unix) or %COMSPEC% (Windows)
  return '';
}
