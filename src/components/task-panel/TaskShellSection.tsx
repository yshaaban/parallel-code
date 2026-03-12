import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from 'solid-js';
import { createStore } from 'solid-js/store';

import { consumePendingShellCommand } from '../../lib/bookmarks';
import { sf } from '../../lib/fontScale';
import { mod } from '../../lib/platform';
import { theme } from '../../lib/theme';
import {
  closeShell,
  getFontScale,
  markAgentOutput,
  registerFocusFn,
  runBookmarkInTask,
  setTaskFocusedPanel,
  store,
  spawnShellForTask,
  unregisterFocusFn,
} from '../../store/store';
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

  createEffect(() => {
    const taskId = props.taskId();
    registerFocusFn(`${taskId}:shell-toolbar`, () => shellToolbarRef?.focus());
    onCleanup(() => unregisterFocusFn(`${taskId}:shell-toolbar`));
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
          onToolbarClick={() => setTaskFocusedPanel(props.taskId(), 'shell-toolbar')}
          onToolbarFocus={() => setShellToolbarFocused(true)}
          onToolbarBlur={() => setShellToolbarFocused(false)}
          onToolbarKeyDown={(event) => {
            const itemCount = 1 + props.bookmarks().length;
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
              spawnShellForTask(props.taskId());
              return;
            }

            const bookmark = props.bookmarks()[selectedIndex - 1];
            if (bookmark) {
              runBookmarkInTask(props.taskId(), bookmark.command);
            }
          }}
          onOpenTerminal={(event) => {
            event.stopPropagation();
            spawnShellForTask(props.taskId());
          }}
          onRunBookmark={(command, event) => {
            event.stopPropagation();
            runBookmarkInTask(props.taskId(), command);
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

                const isShellFocused = () =>
                  store.focusedPanel[props.taskId()] === `shell:${index()}`;

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
                        closeShell(props.taskId(), shellId);
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
                      isFocused={
                        props.isActive() &&
                        store.focusedPanel[props.taskId()] === `shell:${index()}`
                      }
                      command={getShellCommand()}
                      args={['-l']}
                      cwd={props.worktreePath()}
                      initialCommand={initialCommand}
                      onData={(data) => markAgentOutput(shellId, data, props.taskId())}
                      onExit={(info) =>
                        setShellExits(shellId, {
                          exitCode: info.exit_code,
                          signal: info.signal,
                        })
                      }
                      onReady={(focusFn) => {
                        shellFocusFn = focusFn;
                        if (registeredKey) {
                          registerFocusFn(registeredKey, focusFn);
                        }
                      }}
                      fontSize={Math.round(11 * getFontScale(`${props.taskId()}:shell`))}
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
  );
}
