import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
  type JSX,
} from 'solid-js';

import {
  resolveAgentRunnerProfile,
  type AgentRunnerProfileConfig,
} from '../../domain/agent-runners.js';
import { isExitedRemoteAgentStatus } from '../../domain/server-state';
import type { AgentDef, PtyExitData } from '../../ipc/types';
import {
  buildAgentSpawnArgs,
  getAgentResumeStrategy,
  shouldResumeAgentOnSpawn,
} from '../../lib/agent-resume';
import { getAgentSpawnCommand, getAgentSpawnEnvironment } from '../../lib/agent-spawn-config';
import { sf } from '../../lib/fontScale';
import { warn as logWarn } from '../../lib/log';
import { theme } from '../../lib/theme';
import type { ManualAgentSessionAction } from '../../app/agent-session-action';
import {
  getFontScale,
  getAgentTerminalSessionVersion,
  getProject,
  getSelectedTaskAgentId,
  getTaskTerminalLayoutMode,
  getTaskVisibleAiTerminalAgentIds,
  isTaskPanelFocused,
  addAgentToTask,
  closeAgentInTask,
  markAgentExited,
  markAgentOutput,
  registerFocusFn,
  setActiveTask,
  setActiveAgent,
  setLastPrompt,
  setTaskFocusedPanel,
  setTaskTerminalLayoutMode,
  store,
  unregisterFocusFn,
} from '../../store/store';
import { showNotification } from '../../store/notification';
import type { Agent, Task, TaskTerminalLayoutMode } from '../../store/types';
import { AgentSwitchMenu } from '../AgentSwitchMenu';
import { InfoBar } from '../InfoBar';
import type { PanelChild } from '../ResizablePanel';
import { ScalablePanel } from '../ScalablePanel';
import { TerminalView } from '../TerminalView';
import {
  getAgentStatusBadgeColor,
  getAgentStatusBadgeText,
  getPromptStatusText,
  shouldShowAgentStatusBadge,
} from './task-panel-helpers';

interface TaskAiTerminalSectionProps {
  isActive: Accessor<boolean>;
  onReuseLastPrompt: () => void;
  task: Accessor<Task>;
}

interface TaskAiTerminalTileProps {
  agent: Agent;
  isActive: Accessor<boolean>;
  isSelected: boolean;
  onDispose: (agentId: string, focusFn: (() => void) | undefined) => void;
  onReady: (agentId: string, focusFn: () => void) => void;
  runnerProfile?: AgentRunnerProfileConfig;
  task: Task;
}

const LAYOUT_MODES: TaskTerminalLayoutMode[] = ['focused', 'split', 'grid', 'stacked'];

function createAgentExitHandler(
  agentId: string,
  generation: number,
): (exitInfo: PtyExitData) => void {
  return function handleAgentExit(exitInfo): void {
    markAgentExited(agentId, exitInfo, generation);
  };
}

function getRunnerProfileForTask(task: Task): AgentRunnerProfileConfig | undefined {
  const project = getProject(task.projectId);
  const resolution = resolveAgentRunnerProfile(
    project?.agentRunnerConfig,
    project?.containerConfig,
  );

  return resolution.configuredProfile ?? undefined;
}

function getCoordinatorAgentEnvironment(agentDef: AgentDef, task: Task): Record<string, string> {
  const env = getAgentSpawnEnvironment(agentDef, store.hydraStartupMode) ?? {};
  if (!task.coordinatorCredentialPath) {
    return env;
  }

  return {
    ...env,
    PARALLEL_CODE_COORDINATOR_CREDENTIAL: task.coordinatorCredentialPath,
    ...(task.coordinatorRunId !== undefined
      ? { PARALLEL_CODE_COORDINATOR_RUN_ID: task.coordinatorRunId }
      : {}),
    ...(task.coordinatorToolCommand !== undefined
      ? { PARALLEL_CODE_COORDINATOR_TOOL: task.coordinatorToolCommand }
      : {}),
  };
}

function getAgentExitStatusText(agent: Pick<Agent, 'exitCode' | 'signal'>): string {
  if (agent.signal === 'spawn_failed') {
    return 'Failed to start';
  }

  return `Process exited (${agent.exitCode ?? '?'})`;
}

function getLayoutButtonLabel(mode: TaskTerminalLayoutMode): string {
  switch (mode) {
    case 'focused':
      return 'Solo';
    case 'split':
      return 'Split';
    case 'grid':
      return 'Grid';
    case 'stacked':
      return 'Stack';
  }
}

function getLayoutButtonTitle(mode: TaskTerminalLayoutMode): string {
  switch (mode) {
    case 'focused':
      return 'Show the selected agent only';
    case 'split':
      return 'Show the selected agent and one other agent';
    case 'grid':
      return 'Show up to four agents in a grid';
    case 'stacked':
      return 'Show all agents stacked vertically';
  }
}

function getTwoColumnTemplate(visibleAgentCount: number): string {
  return visibleAgentCount > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr';
}

function getTaskTerminalLayoutStyle(
  mode: TaskTerminalLayoutMode,
  visibleAgentCount: number,
): JSX.CSSProperties {
  switch (mode) {
    case 'grid':
      return {
        display: 'grid',
        'grid-template-columns': getTwoColumnTemplate(visibleAgentCount),
        'grid-auto-rows': 'minmax(0, 1fr)',
        gap: '6px',
        height: '100%',
      };
    case 'split':
      return {
        display: 'grid',
        'grid-template-columns': getTwoColumnTemplate(visibleAgentCount),
        gap: '6px',
        height: '100%',
      };
    case 'stacked':
      return {
        display: 'grid',
        'grid-template-columns': '1fr',
        'grid-template-rows': `repeat(${Math.max(visibleAgentCount, 1)}, minmax(0, 1fr))`,
        gap: '6px',
        height: '100%',
      };
    case 'focused':
      return {
        display: 'grid',
        'grid-template-columns': '1fr',
        height: '100%',
      };
  }
}

function getLayoutButtonStyle(isSelected: boolean): JSX.CSSProperties {
  return {
    padding: '2px 7px',
    border: `1px solid ${isSelected ? theme.accent : theme.border}`,
    background: isSelected ? theme.bgInput : 'transparent',
    color: isSelected ? theme.fg : theme.fgSubtle,
    'border-radius': '5px',
    cursor: 'pointer',
    'font-size': sf(10),
  };
}

function getAgentTabBackground(isSelected: boolean): string {
  return isSelected ? theme.bgSelected : theme.bgInput;
}

function getAgentTabBorder(isSelected: boolean): string {
  return isSelected ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`;
}

function getAgentTabButtonStyle(isSelected: boolean, canClose: boolean): JSX.CSSProperties {
  const border = getAgentTabBorder(isSelected);
  return {
    display: 'inline-flex',
    'align-items': 'center',
    gap: '4px',
    height: '20px',
    'min-width': '0',
    'max-width': '132px',
    padding: '0 7px',
    background: getAgentTabBackground(isSelected),
    border,
    'border-right': canClose ? 'none' : border,
    color: isSelected ? theme.fg : theme.fgMuted,
    'border-radius': canClose ? '5px 0 0 5px' : '5px',
    cursor: 'pointer',
    'font-family': "'JetBrains Mono', monospace",
    'font-size': sf(11),
  };
}

function getAgentTabLabelStyle(): JSX.CSSProperties {
  return {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'min-width': '0',
  };
}

function getAgentTabCloseButtonStyle(isSelected: boolean): JSX.CSSProperties {
  return {
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    width: '20px',
    height: '20px',
    background: getAgentTabBackground(isSelected),
    border: getAgentTabBorder(isSelected),
    color: theme.fgMuted,
    'border-radius': '0 5px 5px 0',
    cursor: 'pointer',
    padding: '0',
  };
}

function getAddAgentMenuItemStyle(isAdding: boolean): JSX.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    background: isAdding ? theme.bgSelected : 'transparent',
    border: 'none',
    color: theme.fg,
    padding: '5px 10px',
    cursor: isAdding ? 'default' : 'pointer',
    'font-size': sf(11),
    'text-align': 'left',
  };
}

function getTerminalTileBorder(isSelected: boolean): string {
  if (isSelected) {
    return `1px solid color-mix(in srgb, ${theme.accent} 70%, transparent)`;
  }

  return `1px solid ${theme.border}`;
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function PlusIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 2.75a.75.75 0 0 1 .75.75v3.75h3.75a.75.75 0 0 1 0 1.5H8.75v3.75a.75.75 0 0 1-1.5 0V8.75H3.5a.75.75 0 0 1 0-1.5h3.75V3.5A.75.75 0 0 1 8 2.75Z" />
    </svg>
  );
}

interface AddAgentMenuProps {
  onAgentAdded: (agentId: string) => void;
  taskId: string;
}

function AddAgentMenu(props: AddAgentMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [addingAgentDefId, setAddingAgentDefId] = createSignal<string | null>(null);
  const availableAgents = createMemo(() =>
    store.availableAgents.filter((agentDef) => agentDef.available !== false),
  );
  let menuRef: HTMLSpanElement | undefined;

  function closeMenuOnOutsideClick(event: MouseEvent): void {
    if (!menuRef || menuRef.contains(event.target as Node)) {
      return;
    }

    setOpen(false);
  }

  onMount(() => {
    document.addEventListener('mousedown', closeMenuOnOutsideClick);
  });
  onCleanup(() => {
    document.removeEventListener('mousedown', closeMenuOnOutsideClick);
  });

  async function handleAddAgent(agentDef: AgentDef): Promise<void> {
    if (addingAgentDefId() !== null) {
      return;
    }

    setAddingAgentDefId(agentDef.id);
    try {
      const agentId = await addAgentToTask(props.taskId, agentDef);
      if (!agentId) {
        setOpen(false);
        return;
      }

      setActiveTask(props.taskId);
      setActiveAgent(agentId);
      setTaskFocusedPanel(props.taskId, 'ai-terminal');
      props.onAgentAdded(agentId);
      setOpen(false);
    } catch (error) {
      logWarn('task-ai-terminal.add-agent', 'Failed to add task agent', {
        agentDefId: agentDef.id,
        error,
        taskId: props.taskId,
      });
    } finally {
      setAddingAgentDefId(null);
    }
  }

  return (
    <Show when={availableAgents().length > 0}>
      <span
        data-ai-terminal-add-agent-menu="true"
        ref={(element) => {
          menuRef = element;
        }}
        style={{ position: 'relative', display: 'inline-flex' }}
      >
        <button
          type="button"
          aria-expanded={open()}
          aria-haspopup="menu"
          aria-label="Add agent"
          data-ai-terminal-add-agent-button="true"
          title="Add agent"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
          style={{
            display: 'inline-flex',
            'align-items': 'center',
            'justify-content': 'center',
            width: '22px',
            height: '20px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'border-radius': '5px',
            cursor: 'pointer',
            padding: '0',
          }}
        >
          <PlusIcon />
        </button>
        <Show when={open()}>
          <div
            role="menu"
            aria-label="Add agent"
            style={{
              position: 'absolute',
              top: '100%',
              right: '0',
              'margin-top': '4px',
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': '6px',
              padding: '4px 0',
              'z-index': '30',
              'min-width': '180px',
              'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ padding: '4px 10px', 'font-size': sf(10), color: theme.fgMuted }}>
              Add agent
            </div>
            <For each={availableAgents()}>
              {(agentDef) => {
                const isAdding = () => addingAgentDefId() === agentDef.id;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    data-ai-terminal-add-agent-option={agentDef.id}
                    title={agentDef.description}
                    disabled={addingAgentDefId() !== null}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleAddAgent(agentDef);
                    }}
                    style={getAddAgentMenuItemStyle(isAdding())}
                  >
                    {agentDef.name}
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </span>
    </Show>
  );
}

interface AgentTabProps {
  agent: Agent;
  canClose: boolean;
  index: number;
  isSelected: boolean;
  onClose: (agentId: string) => void;
  onSelect: (agentId: string) => void;
}

function AgentTab(props: AgentTabProps): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', 'align-items': 'center', height: '20px' }}>
      <button
        type="button"
        aria-pressed={props.isSelected}
        data-ai-terminal-agent-tab={props.agent.id}
        aria-label={`Select ${props.agent.def.name} agent`}
        title={props.agent.def.description || props.agent.def.name}
        onClick={(event) => {
          event.stopPropagation();
          props.onSelect(props.agent.id);
        }}
        style={getAgentTabButtonStyle(props.isSelected, props.canClose)}
      >
        <span style={getAgentTabLabelStyle()}>{props.agent.def.name}</span>
        <Show when={props.canClose}>
          <span style={{ opacity: 0.55, 'flex-shrink': '0' }}>#{props.index + 1}</span>
        </Show>
      </button>
      <Show when={props.canClose}>
        <button
          type="button"
          aria-label={`Close ${props.agent.def.name} agent`}
          data-ai-terminal-agent-close={props.agent.id}
          title="Close agent"
          onClick={(event) => {
            event.stopPropagation();
            props.onClose(props.agent.id);
          }}
          style={getAgentTabCloseButtonStyle(props.isSelected)}
        >
          <CloseIcon />
        </button>
      </Show>
    </span>
  );
}

function TaskAiTerminalTile(props: TaskAiTerminalTileProps): JSX.Element {
  const taskId = untrack(() => props.task.id);
  const agentId = untrack(() => props.agent.id);
  const canResumeAgent = () => getAgentResumeStrategy(props.agent.def) !== 'none';
  const availableAgents = createMemo(() =>
    store.availableAgents.filter((agentDef) => agentDef.available !== false),
  );
  const panelId = `${taskId}:ai-terminal`;
  const [sessionActionPending, setSessionActionPending] = createSignal(false);
  let currentFocusFn: (() => void) | undefined;

  onCleanup(() => props.onDispose(agentId, currentFocusFn));

  function selectTile(): void {
    if (!props.isSelected) {
      setActiveAgent(agentId);
    }
    setTaskFocusedPanel(taskId, 'ai-terminal');
  }

  function runSessionAction(action: ManualAgentSessionAction): void {
    if (sessionActionPending()) return;
    setSessionActionPending(true);
    void import('../../app/agent-session-workflows')
      .then(({ runManualAgentSessionAction }) => runManualAgentSessionAction(agentId, action))
      .then((started) => {
        if (!started) {
          showNotification(
            'The agent session was not changed because this task is controlled elsewhere.',
          );
        }
      })
      .catch((error: unknown) => {
        logWarn('task-ai-terminal.session-action', 'Managed agent session action failed', {
          action: action.kind,
          agentId,
          error,
          taskId,
        });
        showNotification(
          error instanceof Error ? error.message : 'Failed to change agent session',
          {
            kind: 'error',
          },
        );
      })
      .finally(() => setSessionActionPending(false));
  }

  return (
    <div
      data-ai-terminal-pane="true"
      data-ai-terminal-selected={props.isSelected ? 'true' : 'false'}
      data-terminal-agent-pane-id={agentId}
      style={{
        position: 'relative',
        display: 'flex',
        'flex-direction': 'column',
        'min-height': '0',
        overflow: 'hidden',
        border: getTerminalTileBorder(props.isSelected),
        'border-radius': '6px',
        background: theme.bg,
      }}
      onClick={selectTile}
    >
      <Show when={!props.isSelected}>
        <div
          style={{
            position: 'absolute',
            top: '8px',
            left: '10px',
            'z-index': '11',
            color: theme.fgMuted,
            background: 'color-mix(in srgb, var(--island-bg) 82%, transparent)',
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            padding: '3px 8px',
            'font-size': sf(10),
          }}
        >
          {props.agent.def.name}
        </div>
      </Show>

      <Show when={isExitedRemoteAgentStatus(props.agent.status)}>
        <div
          class="exit-badge"
          title={props.agent.lastOutput.length ? props.agent.lastOutput.join('\n') : undefined}
          style={{
            position: 'absolute',
            top: '8px',
            right: '12px',
            'z-index': '10',
            'font-size': sf(11),
            color: props.agent.exitCode === 0 ? theme.success : theme.error,
            background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
            padding: '4px 12px',
            'border-radius': '8px',
            border: `1px solid ${theme.border}`,
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <span>{getAgentExitStatusText(props.agent)}</span>
          <AgentSwitchMenu
            currentAgentDefId={props.agent.def.id}
            availableAgents={availableAgents()}
            disabled={sessionActionPending()}
            onRestartCurrent={() => runSessionAction({ kind: 'restart' })}
            onSelectAgent={(agentDef) => {
              if (agentDef.id === props.agent.def.id) {
                runSessionAction({ kind: 'restart' });
                return;
              }
              runSessionAction({ agentDef, kind: 'switch' });
            }}
          />
          <Show when={canResumeAgent()}>
            <button
              onClick={(event) => {
                event.stopPropagation();
                runSessionAction({ kind: 'resume' });
              }}
              disabled={sessionActionPending()}
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

      <Show when={shouldShowAgentStatusBadge(props.agent.status)}>
        <div
          style={{
            position: 'absolute',
            top: '8px',
            right: '12px',
            'z-index': '10',
            'font-size': sf(11),
            color: getAgentStatusBadgeColor(props.agent.status),
            background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
            padding: '4px 12px',
            'border-radius': '8px',
            border: `1px solid ${theme.border}`,
          }}
        >
          {getAgentStatusBadgeText(props.agent.status)}
        </div>
      </Show>

      <Show when={`${agentId}:${getAgentTerminalSessionVersion(props.agent)}`} keyed>
        {(() => {
          const sessionAgentId = agentId;
          const sessionGeneration = props.agent.generation;
          const sessionAgentDef = props.agent.def;
          const sessionAgentResumed = props.agent.resumed;
          const sessionTask = props.task;
          const sessionPanelId = panelId;
          let mountedFocusFn: (() => void) | undefined;

          onCleanup(() => {
            props.onDispose(sessionAgentId, mountedFocusFn);
            if (currentFocusFn === mountedFocusFn) {
              currentFocusFn = undefined;
            }
          });

          return (
            <TerminalView
              taskId={taskId}
              agentId={sessionAgentId}
              isCommandTarget={props.isSelected}
              isFocused={
                props.isSelected && props.isActive() && isTaskPanelFocused(taskId, 'ai-terminal')
              }
              manageTaskSwitchWindowLifecycle={false}
              args={buildAgentSpawnArgs(sessionAgentDef, {
                resumed: sessionAgentResumed,
                skipPermissions: sessionTask.skipPermissions === true,
              })}
              command={getAgentSpawnCommand(sessionAgentDef, store.hydraCommand)}
              adapter={sessionAgentDef.adapter}
              baseBranch={sessionTask.baseBranch}
              cwd={sessionTask.worktreePath}
              focusPanelId="ai-terminal"
              projectMode={sessionTask.projectMode}
              runnerProfile={props.runnerProfile}
              sessionOwner="managed-agent"
              env={getCoordinatorAgentEnvironment(sessionAgentDef, sessionTask)}
              resumeOnStart={shouldResumeAgentOnSpawn(sessionAgentDef, sessionAgentResumed)}
              onExit={createAgentExitHandler(sessionAgentId, sessionGeneration)}
              onData={(data) =>
                markAgentOutput(sessionAgentId, data, taskId, 'full', sessionGeneration)
              }
              onPromptDetected={(text) => {
                if (props.isSelected) {
                  setLastPrompt(taskId, text);
                }
              }}
              onReady={(focusFn) => {
                if (mountedFocusFn !== undefined && mountedFocusFn !== focusFn) {
                  props.onDispose(sessionAgentId, mountedFocusFn);
                }
                mountedFocusFn = focusFn;
                currentFocusFn = focusFn;
                props.onReady(sessionAgentId, focusFn);
              }}
              fontSize={Math.round(store.terminalFontSize * getFontScale(sessionPanelId))}
            />
          );
        })()}
      </Show>
    </div>
  );
}

export function createTaskAiTerminalSection(props: TaskAiTerminalSectionProps): PanelChild {
  return {
    id: 'ai-terminal',
    minSize: 80,
    content: () => <TaskAiTerminalSection {...props} />,
  };
}

export function TaskAiTerminalSection(props: TaskAiTerminalSectionProps): JSX.Element {
  const task = () => props.task();
  const availableTaskAgentIds = createMemo(() =>
    task().agentIds.filter((agentId) => store.agents[agentId] !== undefined),
  );
  const selectedAgentId = createMemo(() => {
    const currentTask = task();
    return getSelectedTaskAgentId(
      {
        agentIds: availableTaskAgentIds(),
        selectedAgentId: currentTask.selectedAgentId,
      },
      store.activeTaskId === currentTask.id ? store.activeAgentId : null,
    );
  });
  const visibleAgentIds = createMemo(() => {
    const currentTask = task();
    return getTaskVisibleAiTerminalAgentIds(
      {
        ...currentTask,
        agentIds: availableTaskAgentIds(),
      },
      store.activeTaskId === currentTask.id ? store.activeAgentId : null,
    );
  });
  const runnerProfile = createMemo(() => getRunnerProfileForTask(task()));
  const terminalFocusFns = new Map<string, () => void>();
  let pendingFocusAgentId: string | null = null;

  createEffect(() => {
    const taskId = task().id;
    registerFocusFn(`${taskId}:ai-terminal`, () => {
      const agentId = untrack(selectedAgentId);
      if (!agentId) {
        return;
      }
      const focusFn = terminalFocusFns.get(agentId);
      if (!focusFn) {
        pendingFocusAgentId = agentId;
        return;
      }

      pendingFocusAgentId = null;
      focusFn();
    });
    onCleanup(() => unregisterFocusFn(`${taskId}:ai-terminal`));
  });

  function handleTerminalReady(agentId: string, focusFn: () => void): void {
    terminalFocusFns.set(agentId, focusFn);
    if (pendingFocusAgentId !== agentId) {
      return;
    }

    pendingFocusAgentId = null;
    focusFn();
  }

  function handleTerminalDispose(agentId: string, focusFn: (() => void) | undefined): void {
    if (focusFn === undefined || terminalFocusFns.get(agentId) !== focusFn) {
      return;
    }

    terminalFocusFns.delete(agentId);
  }

  function focusAgentWhenReady(agentId: string): void {
    const focusFn = terminalFocusFns.get(agentId);
    if (!focusFn) {
      pendingFocusAgentId = agentId;
      return;
    }

    pendingFocusAgentId = null;
    focusFn();
  }

  function selectAgent(agentId: string): void {
    setActiveTask(task().id);
    setActiveAgent(agentId);
    setTaskFocusedPanel(task().id, 'ai-terminal');
    focusAgentWhenReady(agentId);
  }

  async function closeAgent(agentId: string): Promise<void> {
    const wasSelected = selectedAgentId() === agentId;

    await closeAgentInTask(task().id, agentId);

    const nextSelectedAgentId = selectedAgentId();
    if (wasSelected && nextSelectedAgentId) {
      selectAgent(nextSelectedAgentId);
    }
  }

  const currentLayoutMode = createMemo(() => getTaskTerminalLayoutMode(task()));
  const layoutStyle = createMemo(() =>
    getTaskTerminalLayoutStyle(currentLayoutMode(), visibleAgentIds().length),
  );
  const hasLayoutChoices = createMemo(() => availableTaskAgentIds().length > 1);

  return (
    <ScalablePanel panelId={`${task().id}:ai-terminal`}>
      <div
        class="focusable-panel shell-terminal-container"
        data-ai-terminal-layout={currentLayoutMode()}
        data-ai-terminal-visible-count={String(visibleAgentIds().length)}
        data-shell-focused={isTaskPanelFocused(task().id, 'ai-terminal') ? 'true' : 'false'}
        style={{
          height: '100%',
          position: 'relative',
          background: theme.taskPanelBg,
          display: 'flex',
          'flex-direction': 'column',
        }}
        onClick={() => setTaskFocusedPanel(task().id, 'ai-terminal')}
      >
        <InfoBar
          allowOverflow
          title={
            task().lastPrompt ||
            (task().initialPrompt ? 'Waiting to send prompt...' : 'No prompts sent yet')
          }
          onDblClick={props.onReuseLastPrompt}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              width: '100%',
              'min-width': '0',
            }}
          >
            <span
              style={{
                opacity: task().lastPrompt ? 1 : 0.4,
                flex: '1',
                'min-width': '0',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
              }}
            >
              {getPromptStatusText(task())}
            </span>
            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
                'min-width': '0',
                'flex-shrink': '0',
                'max-width': '72%',
              }}
            >
              <Show when={hasLayoutChoices()}>
                <div
                  aria-label="Task agents"
                  data-ai-terminal-agent-tabs="true"
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '4px',
                    'min-width': '0',
                    overflow: 'hidden',
                  }}
                >
                  <For each={availableTaskAgentIds()}>
                    {(agentId, index) => (
                      <Show when={store.agents[agentId]}>
                        {(agent) => (
                          <AgentTab
                            agent={agent()}
                            canClose={hasLayoutChoices()}
                            index={index()}
                            isSelected={agentId === selectedAgentId()}
                            onClose={(nextAgentId) => {
                              const currentTaskId = task().id;
                              void closeAgent(nextAgentId).catch((error) => {
                                logWarn(
                                  'task-ai-terminal.close-agent',
                                  'Failed to close task agent',
                                  {
                                    agentId: nextAgentId,
                                    error,
                                    taskId: currentTaskId,
                                  },
                                );
                              });
                            }}
                            onSelect={selectAgent}
                          />
                        )}
                      </Show>
                    )}
                  </For>
                </div>
                <div
                  aria-label="AI terminal layout"
                  data-ai-terminal-layout-controls="true"
                  style={{ display: 'flex', gap: '4px', 'flex-shrink': '0' }}
                >
                  <For each={LAYOUT_MODES}>
                    {(mode) => {
                      const isSelectedMode = () => currentLayoutMode() === mode;
                      return (
                        <button
                          type="button"
                          aria-label={getLayoutButtonTitle(mode)}
                          aria-pressed={isSelectedMode()}
                          data-ai-terminal-layout-button={mode}
                          title={getLayoutButtonTitle(mode)}
                          onClick={(event) => {
                            event.stopPropagation();
                            setTaskTerminalLayoutMode(task().id, mode);
                          }}
                          style={getLayoutButtonStyle(isSelectedMode())}
                        >
                          {getLayoutButtonLabel(mode)}
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <AddAgentMenu onAgentAdded={focusAgentWhenReady} taskId={task().id} />
            </div>
          </div>
        </InfoBar>
        <div style={{ flex: '1', position: 'relative', overflow: 'hidden', padding: '6px' }}>
          <Show when={visibleAgentIds().length > 0}>
            <div style={layoutStyle()}>
              <For each={visibleAgentIds()}>
                {(agentId) => (
                  <Show when={store.agents[agentId]}>
                    {(agent) => (
                      <TaskAiTerminalTile
                        agent={agent()}
                        isActive={props.isActive}
                        isSelected={agentId === selectedAgentId()}
                        onDispose={handleTerminalDispose}
                        onReady={handleTerminalReady}
                        runnerProfile={runnerProfile()}
                        task={task()}
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </ScalablePanel>
  );
}
