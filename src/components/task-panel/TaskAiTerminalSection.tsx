import { Show, createEffect, createMemo, onCleanup, type Accessor, type JSX } from 'solid-js';

import {
  buildAgentSpawnArgs,
  getAgentResumeStrategy,
  shouldResumeAgentOnSpawn,
} from '../../lib/agent-resume';
import { isExitedRemoteAgentStatus } from '../../domain/server-state';
import type { PtyExitData } from '../../ipc/types';
import { sf } from '../../lib/fontScale';
import { getHydraCommandOverride, isHydraAgentDef } from '../../lib/hydra';
import { theme } from '../../lib/theme';
import {
  getFontScale,
  isTaskPanelFocused,
  markAgentExited,
  markAgentOutput,
  registerFocusFn,
  restartAgent,
  setLastPrompt,
  setTaskFocusedPanel,
  store,
  switchAgent,
  unregisterFocusFn,
} from '../../store/store';
import type { Task } from '../../store/types';
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

function createAgentExitHandler(
  agentId: string,
  generation: number,
): (exitInfo: PtyExitData) => void {
  return function handleAgentExit(exitInfo): void {
    markAgentExited(agentId, exitInfo, generation);
  };
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
  const firstAgent = createMemo(() => {
    const firstAgentId = task().agentIds[0];
    return firstAgentId ? store.agents[firstAgentId] : undefined;
  });
  const canResumeCurrentAgent = () => {
    const currentAgent = firstAgent();
    return currentAgent ? getAgentResumeStrategy(currentAgent.def) !== 'none' : false;
  };
  const availableAgents = createMemo(() =>
    store.availableAgents.filter((agentDef) => agentDef.available !== false),
  );

  createEffect(() => {
    const taskId = task().id;
    onCleanup(() => unregisterFocusFn(`${taskId}:ai-terminal`));
  });

  return (
    <ScalablePanel panelId={`${task().id}:ai-terminal`}>
      <div
        class="focusable-panel shell-terminal-container"
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
        </InfoBar>
        <div style={{ flex: '1', position: 'relative', overflow: 'hidden' }}>
          <Show when={firstAgent()}>
            {(agent) => (
              <>
                <Show when={isExitedRemoteAgentStatus(agent().status)}>
                  <div
                    class="exit-badge"
                    title={agent().lastOutput.length ? agent().lastOutput.join('\n') : undefined}
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '12px',
                      'z-index': '10',
                      'font-size': sf(11),
                      color: agent().exitCode === 0 ? theme.success : theme.error,
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
                      {agent().signal === 'spawn_failed'
                        ? 'Failed to start'
                        : `Process exited (${agent().exitCode ?? '?'})`}
                    </span>
                    <AgentSwitchMenu
                      currentAgentDefId={agent().def.id}
                      availableAgents={availableAgents()}
                      onRestartCurrent={() => restartAgent(agent().id, false)}
                      onSelectAgent={(agentDef) => {
                        if (agentDef.id === agent().def.id) {
                          restartAgent(agent().id, false);
                          return;
                        }
                        switchAgent(agent().id, agentDef);
                      }}
                    />
                    <Show when={canResumeCurrentAgent()}>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          restartAgent(agent().id, true);
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

                <Show when={shouldShowAgentStatusBadge(agent().status)}>
                  <div
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '12px',
                      'z-index': '10',
                      'font-size': sf(11),
                      color: getAgentStatusBadgeColor(agent().status),
                      background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
                      padding: '4px 12px',
                      'border-radius': '8px',
                      border: `1px solid ${theme.border}`,
                    }}
                  >
                    {getAgentStatusBadgeText(agent().status)}
                  </div>
                </Show>

                <Show when={`${agent().id}:${agent().generation}`} keyed>
                  {(() => {
                    const currentAgentId = agent().id;
                    const currentGeneration = agent().generation;
                    const currentAgentDef = agent().def;
                    const currentAgentResumed = agent().resumed;

                    return (
                      <TerminalView
                        taskId={task().id}
                        agentId={currentAgentId}
                        isFocused={props.isActive() && isTaskPanelFocused(task().id, 'ai-terminal')}
                        manageTaskSwitchWindowLifecycle={false}
                        args={buildAgentSpawnArgs(currentAgentDef, {
                          resumed: currentAgentResumed,
                          skipPermissions: task().skipPermissions === true,
                        })}
                        command={
                          isHydraAgentDef(currentAgentDef)
                            ? getHydraCommandOverride(currentAgentDef, store.hydraCommand)
                            : currentAgentDef.command
                        }
                        adapter={currentAgentDef.adapter}
                        cwd={task().worktreePath}
                        env={
                          isHydraAgentDef(currentAgentDef)
                            ? { PARALLEL_CODE_HYDRA_STARTUP_MODE: store.hydraStartupMode }
                            : undefined
                        }
                        resumeOnStart={shouldResumeAgentOnSpawn(
                          currentAgentDef,
                          currentAgentResumed,
                        )}
                        onExit={createAgentExitHandler(currentAgentId, currentGeneration)}
                        onData={(data) =>
                          markAgentOutput(
                            currentAgentId,
                            data,
                            task().id,
                            'full',
                            currentGeneration,
                          )
                        }
                        onPromptDetected={(text) => setLastPrompt(task().id, text)}
                        onReady={(focusFn) => registerFocusFn(`${task().id}:ai-terminal`, focusFn)}
                        fontSize={Math.round(13 * getFontScale(`${task().id}:ai-terminal`))}
                      />
                    );
                  })()}
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </ScalablePanel>
  );
}
