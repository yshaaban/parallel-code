import {
  For,
  Show,
  createEffect,
  createMemo,
  onCleanup,
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
import { sf } from '../../lib/fontScale';
import { getHydraCommandOverride, isHydraAgentDef } from '../../lib/hydra';
import { theme } from '../../lib/theme';
import {
  getFontScale,
  getAgentTerminalSessionVersion,
  getProject,
  getSelectedTaskAgentId,
  getTaskTerminalLayoutMode,
  getTaskVisibleAiTerminalAgentIds,
  isTaskPanelFocused,
  markAgentExited,
  markAgentOutput,
  registerFocusFn,
  restartAgent,
  setActiveAgent,
  setLastPrompt,
  setTaskFocusedPanel,
  setTaskTerminalLayoutMode,
  store,
  switchAgent,
  unregisterFocusFn,
} from '../../store/store';
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

function getAgentCommand(agentDef: AgentDef): string {
  if (!isHydraAgentDef(agentDef)) {
    return agentDef.command;
  }

  return getHydraCommandOverride(agentDef, store.hydraCommand);
}

function getAgentEnvironment(agentDef: AgentDef): Record<string, string> | undefined {
  if (!isHydraAgentDef(agentDef)) {
    return undefined;
  }

  return { PARALLEL_CODE_HYDRA_STARTUP_MODE: store.hydraStartupMode };
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
      return 'Focus';
    case 'split':
      return 'Split';
    case 'grid':
      return 'Grid';
    case 'stacked':
      return 'Stack';
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

function getTerminalTileBorder(isSelected: boolean): string {
  if (isSelected) {
    return `1px solid color-mix(in srgb, ${theme.accent} 70%, transparent)`;
  }

  return `1px solid ${theme.border}`;
}

function TaskAiTerminalTile(props: TaskAiTerminalTileProps): JSX.Element {
  const canResumeAgent = () => getAgentResumeStrategy(props.agent.def) !== 'none';
  const availableAgents = createMemo(() =>
    store.availableAgents.filter((agentDef) => agentDef.available !== false),
  );
  const panelId = () => `${props.task.id}:ai-terminal`;
  let currentFocusFn: (() => void) | undefined;

  onCleanup(() => props.onDispose(props.agent.id, currentFocusFn));

  function selectTile(): void {
    if (!props.isSelected) {
      setActiveAgent(props.agent.id);
    }
    setTaskFocusedPanel(props.task.id, 'ai-terminal');
  }

  return (
    <div
      data-ai-terminal-pane="true"
      data-ai-terminal-selected={props.isSelected ? 'true' : 'false'}
      data-terminal-agent-pane-id={props.agent.id}
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
            onRestartCurrent={() => restartAgent(props.agent.id, false)}
            onSelectAgent={(agentDef) => {
              if (agentDef.id === props.agent.def.id) {
                restartAgent(props.agent.id, false);
                return;
              }
              switchAgent(props.agent.id, agentDef);
            }}
          />
          <Show when={canResumeAgent()}>
            <button
              onClick={(event) => {
                event.stopPropagation();
                restartAgent(props.agent.id, true);
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

      <Show when={`${props.agent.id}:${getAgentTerminalSessionVersion(props.agent)}`} keyed>
        {(() => {
          const currentAgentId = props.agent.id;
          const currentGeneration = props.agent.generation;
          const currentAgentDef = props.agent.def;
          const currentAgentResumed = props.agent.resumed;
          let mountedFocusFn: (() => void) | undefined;

          onCleanup(() => {
            props.onDispose(currentAgentId, mountedFocusFn);
            if (currentFocusFn === mountedFocusFn) {
              currentFocusFn = undefined;
            }
          });

          return (
            <TerminalView
              taskId={props.task.id}
              agentId={currentAgentId}
              isCommandTarget={props.isSelected}
              isFocused={
                props.isSelected &&
                props.isActive() &&
                isTaskPanelFocused(props.task.id, 'ai-terminal')
              }
              manageTaskSwitchWindowLifecycle={false}
              args={buildAgentSpawnArgs(currentAgentDef, {
                resumed: currentAgentResumed,
                skipPermissions: props.task.skipPermissions === true,
              })}
              command={getAgentCommand(currentAgentDef)}
              adapter={currentAgentDef.adapter}
              baseBranch={props.task.baseBranch}
              cwd={props.task.worktreePath}
              projectMode={props.task.projectMode}
              runnerProfile={props.runnerProfile}
              env={getAgentEnvironment(currentAgentDef)}
              resumeOnStart={shouldResumeAgentOnSpawn(currentAgentDef, currentAgentResumed)}
              onExit={createAgentExitHandler(currentAgentId, currentGeneration)}
              onData={(data) =>
                markAgentOutput(currentAgentId, data, props.task.id, 'full', currentGeneration)
              }
              onPromptDetected={(text) => {
                if (props.isSelected) {
                  setLastPrompt(props.task.id, text);
                }
              }}
              onReady={(focusFn) => {
                if (mountedFocusFn !== undefined && mountedFocusFn !== focusFn) {
                  props.onDispose(currentAgentId, mountedFocusFn);
                }
                mountedFocusFn = focusFn;
                currentFocusFn = focusFn;
                props.onReady(currentAgentId, focusFn);
              }}
              fontSize={Math.round(store.terminalFontSize * getFontScale(panelId()))}
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

  const currentLayoutMode = createMemo(() => getTaskTerminalLayoutMode(task()));
  const layoutStyle = createMemo(() =>
    getTaskTerminalLayoutStyle(currentLayoutMode(), visibleAgentIds().length),
  );

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
          title={
            task().lastPrompt ||
            (task().initialPrompt ? 'Waiting to send prompt...' : 'No prompts sent yet')
          }
          onDblClick={props.onReuseLastPrompt}
        >
          <span style={{ opacity: task().lastPrompt ? 1 : 0.4 }}>
            {getPromptStatusText(task())}
          </span>
          <div style={{ display: 'flex', gap: '4px', 'margin-left': '8px' }}>
            <For each={LAYOUT_MODES}>
              {(mode) => {
                const isSelectedMode = () => currentLayoutMode() === mode;
                return (
                  <button
                    type="button"
                    data-ai-terminal-layout-button={mode}
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
