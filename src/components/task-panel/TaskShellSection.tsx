import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from 'solid-js';
import { createStore, produce } from 'solid-js/store';

import { consumePendingShellCommand } from '../../lib/bookmarks';
import { sf } from '../../lib/fontScale';
import { mod } from '../../lib/platform';
import { theme } from '../../lib/theme';
import { showNotification } from '../../store/notification';
import {
  clearAgentActivity,
  getFontScale,
  getStoredTaskFocusedPanel,
  isTaskPanelFocused,
  markAgentOutput,
  registerFocusFn,
  setTaskFocusedPanel,
  setTaskFocusedPanelState,
  unregisterFocusFn,
} from '../../store/store';
import { closeShell, runBookmarkInTask, spawnShellForTask } from '../../app/task-workflows';
import type { TerminalBookmark } from '../../store/types';
import type { PanelChild } from '../ResizablePanel';
import { ScalablePanel } from '../ScalablePanel';
import { TaskShellToolbar } from '../TaskShellToolbar';
import { TerminalView } from '../TerminalView';
import { getShellCommand } from './task-panel-helpers';

interface TaskShellSectionProps {
  bookmarks: Accessor<TerminalBookmark[]>;
  isActive: Accessor<boolean>;
  shellAgentIds: Accessor<string[]>;
  taskId: Accessor<string>;
  worktreePath: Accessor<string>;
}

export function createTaskShellSection(props: TaskShellSectionProps): PanelChild {
  return {
    id: 'shell-section',
    initialSize: 28,
    minSize: 28,
    get fixed() {
      return props.shellAgentIds().length === 0;
    },
    requestSize: () => (props.shellAgentIds().length > 0 ? 200 : 28),
    content: () => <TaskShellSection {...props} />,
  };
}

export function TaskShellSection(props: TaskShellSectionProps): JSX.Element {
  const [shellExits, setShellExits] = createStore<
    Record<string, { exitCode: number | null; signal: string | null }>
  >({});
  const [shellToolbarFocused, setShellToolbarFocused] = createSignal(false);
  const [shellToolbarIdx, setShellToolbarIdx] = createSignal(0);
  let shellToolbarRef: HTMLDivElement | undefined;

  function handleShellActionFailure(action: string, error: unknown): void {
    console.warn(`Failed to ${action}:`, error);
    showNotification(`Failed to ${action}`);
  }

  function requestBookmarkRun(command: string): void {
    void runBookmarkInTask(props.taskId(), command).catch((error) => {
      handleShellActionFailure('run shell command', error);
    });
  }

  function requestShellClose(shellId: string): void {
    void closeShell(props.taskId(), shellId).catch((error) => {
      handleShellActionFailure('close terminal', error);
    });
  }

  function clearShellExit(shellId: string): void {
    setShellExits(
      produce((state) => {
        if (!state[shellId]) {
          return;
        }

        const { [shellId]: _omittedShellExit, ...nextState } = state;
        return nextState;
      }),
    );
  }

  createEffect(() => {
    const taskId = props.taskId();
    const toolbarButtonCount = 1 + props.bookmarks().length;
    const maxToolbarIndex = toolbarButtonCount - 1;
    const focusedPanel = getStoredTaskFocusedPanel(taskId) ?? undefined;
    const nextToolbarIndex = getEffectiveShellToolbarIndex(
      focusedPanel,
      shellToolbarIdx(),
      maxToolbarIndex,
    );
    if (nextToolbarIndex !== shellToolbarIdx()) {
      setShellToolbarIdx(nextToolbarIndex);
    }

    const clampedToolbarPanelId = getClampedShellToolbarPanelId(focusedPanel, maxToolbarIndex);
    if (clampedToolbarPanelId) {
      setTaskFocusedPanelState(taskId, clampedToolbarPanelId);
    }

    registerShellToolbarFocusCallbacks(taskId, toolbarButtonCount, setShellToolbarIdx, () =>
      shellToolbarRef?.focus(),
    );

    onCleanup(() => {
      unregisterShellToolbarFocusCallbacks(taskId, toolbarButtonCount);
    });
  });

  return (
    <ScalablePanel panelId={`${props.taskId()}:shell`}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          'flex-direction': 'column',
          background: 'transparent',
        }}
      >
        <TaskShellToolbar
          bookmarks={props.bookmarks()}
          focused={shellToolbarFocused()}
          selectedIndex={shellToolbarIdx()}
          openTerminalTitle={`Open terminal (${mod}+Shift+T)`}
          onToolbarClick={() =>
            setTaskFocusedPanel(props.taskId(), `shell-toolbar:${shellToolbarIdx()}`)
          }
          onToolbarFocus={() => setShellToolbarFocused(true)}
          onToolbarBlur={() => setShellToolbarFocused(false)}
          onToolbarKeyDown={(event) => {
            if (event.altKey) {
              return;
            }

            const itemCount = 1 + props.bookmarks().length;
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              const nextIndex = Math.min(itemCount - 1, shellToolbarIdx() + 1);
              setShellToolbarIdx(nextIndex);
              setTaskFocusedPanel(props.taskId(), `shell-toolbar:${nextIndex}`);
              return;
            }
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              const nextIndex = Math.max(0, shellToolbarIdx() - 1);
              setShellToolbarIdx(nextIndex);
              setTaskFocusedPanel(props.taskId(), `shell-toolbar:${nextIndex}`);
              return;
            }
            if (event.key !== 'Enter') return;

            event.preventDefault();
            const selectedIndex = shellToolbarIdx();
            if (selectedIndex === 0) {
              spawnShellForTask(props.taskId());
              return;
            }

            const bookmark = props.bookmarks()[selectedIndex - 1];
            if (bookmark) {
              requestBookmarkRun(bookmark.command);
            }
          }}
          onOpenTerminal={(event) => {
            event.stopPropagation();
            spawnShellForTask(props.taskId());
          }}
          onRunBookmark={(command, event) => {
            event.stopPropagation();
            requestBookmarkRun(command);
          }}
          setToolbarRef={(element) => {
            shellToolbarRef = element;
          }}
        />

        <Show when={props.shellAgentIds().length > 0}>
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
            <For each={props.shellAgentIds()}>
              {(shellId, index) => {
                const initialCommand = consumePendingShellCommand(shellId);
                let shellFocusFn: (() => void) | undefined;
                let registeredKey: string | undefined;

                createEffect(() => {
                  const key = `${props.taskId()}:shell:${index()}`;
                  if (registeredKey && registeredKey !== key) {
                    unregisterFocusFn(registeredKey);
                  }
                  if (shellFocusFn) {
                    registerFocusFn(key, shellFocusFn);
                  }
                  registeredKey = key;
                });

                onCleanup(() => {
                  if (registeredKey) {
                    unregisterFocusFn(registeredKey);
                  }
                });

                const isShellFocused = () => isTaskPanelFocused(props.taskId(), `shell:${index()}`);

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
                    onClick={() => setTaskFocusedPanel(props.taskId(), `shell:${index()}`)}
                  >
                    <button
                      class="shell-terminal-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        requestShellClose(shellId);
                      }}
                      title="Close terminal (Ctrl+Shift+Q)"
                      style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        'z-index': '10',
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
                          color: shellExits[shellId]?.exitCode === 0 ? theme.success : theme.error,
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
                      taskId={props.taskId()}
                      agentId={shellId}
                      isShell
                      isFocused={props.isActive() && isShellFocused()}
                      manageTaskSwitchWindowLifecycle={false}
                      command={getShellCommand()}
                      args={['-l']}
                      cwd={props.worktreePath()}
                      initialCommand={initialCommand}
                      onData={(data) => {
                        clearShellExit(shellId);
                        markAgentOutput(shellId, data, props.taskId(), 'shell');
                      }}
                      onExit={(info) => {
                        clearAgentActivity(shellId);
                        setShellExits(shellId, {
                          exitCode: info.exit_code,
                          signal: info.signal,
                        });
                      }}
                      onReady={(focusFn) => {
                        clearShellExit(shellId);
                        shellFocusFn = focusFn;
                        if (registeredKey) {
                          registerFocusFn(registeredKey, focusFn);
                        }
                      }}
                      fontSize={Math.round(11 * getFontScale(`${props.taskId()}:shell`))}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </ScalablePanel>
  );
}

function getStoredShellToolbarIndex(panelId: string | undefined): number | null {
  if (panelId === 'shell-toolbar') {
    return 0;
  }

  if (!panelId?.startsWith('shell-toolbar:')) {
    return null;
  }

  const parsedIndex = Number.parseInt(panelId.slice('shell-toolbar:'.length), 10);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return 0;
  }

  return parsedIndex;
}

function getEffectiveShellToolbarIndex(
  panelId: string | undefined,
  currentIndex: number,
  maxToolbarIndex: number,
): number {
  const storedToolbarIndex = getStoredShellToolbarIndex(panelId);
  if (storedToolbarIndex === null) {
    return Math.min(currentIndex, maxToolbarIndex);
  }

  return Math.min(storedToolbarIndex, maxToolbarIndex);
}

function getClampedShellToolbarPanelId(
  panelId: string | undefined,
  maxToolbarIndex: number,
): string | null {
  const storedToolbarIndex = getStoredShellToolbarIndex(panelId);
  if (storedToolbarIndex === null || storedToolbarIndex <= maxToolbarIndex) {
    return null;
  }

  return `shell-toolbar:${maxToolbarIndex}`;
}

function registerShellToolbarFocusCallbacks(
  taskId: string,
  toolbarButtonCount: number,
  setToolbarIndex: (index: number) => number,
  focusToolbar: () => void,
): void {
  registerFocusFn(`${taskId}:shell-toolbar`, () => {
    setToolbarIndex(0);
    focusToolbar();
  });

  for (let index = 0; index < toolbarButtonCount; index++) {
    registerFocusFn(`${taskId}:shell-toolbar:${index}`, () => {
      setToolbarIndex(index);
      focusToolbar();
    });
  }
}

function unregisterShellToolbarFocusCallbacks(taskId: string, toolbarButtonCount: number): void {
  unregisterFocusFn(`${taskId}:shell-toolbar`);
  for (let index = 0; index < toolbarButtonCount; index++) {
    unregisterFocusFn(`${taskId}:shell-toolbar:${index}`);
  }
}
