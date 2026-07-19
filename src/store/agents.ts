import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { isRunningRemoteAgentStatus } from '../domain/server-state';
import { isTerminalTask } from '../domain/task-mode';
import type { AgentDef, PtyExitData } from '../ipc/types';
import { clearTaskPromptDispatch } from '../app/task-prompt-dispatch';
import { invoke } from '../lib/ipc';
import { warn as logWarn } from '../lib/log';
import { createRandomId } from '../lib/random-id';
import { isNonNegativeInteger } from '../lib/type-guards';
import { store, setStore } from './core';
import { saveCurrentRuntimeState } from './persistence-save';
import { getSelectedTaskAgentId } from './task-agent-selection';
import { removeAgentScopedStoreState } from './task-state-cleanup';
import type { Agent, AgentStatus, Task } from './types';
import { clearAgentActivity, markAgentSpawned } from './taskStatus';

const closingTaskAgentIds = new Set<string>();

async function persistTaskAgentMembershipBestEffort(
  action: 'add' | 'close',
  taskId: string,
  agentId: string,
): Promise<void> {
  await saveCurrentRuntimeState().catch((error) => {
    logWarn('agents.membership', 'Failed to persist task agent membership change', {
      action,
      agentId,
      error,
      taskId,
    });
  });
}

function getCloseFallbackAgentId(agentIds: string[], closedAgentId: string): string | null {
  const index = agentIds.indexOf(closedAgentId);
  if (index === -1) {
    return null;
  }

  return agentIds[index + 1] ?? agentIds[index - 1] ?? null;
}

function getCloseableTaskAgentCount(task: Pick<Task, 'agentIds'>): number {
  return task.agentIds.filter((candidateAgentId) => !closingTaskAgentIds.has(candidateAgentId))
    .length;
}

function canCloseTaskAgent(task: Pick<Task, 'agentIds'>, agentId: string): boolean {
  return (
    task.agentIds.includes(agentId) &&
    !closingTaskAgentIds.has(agentId) &&
    getCloseableTaskAgentCount(task) > 1
  );
}

export async function addAgentToTask(taskId: string, agentDef: AgentDef): Promise<string | null> {
  const task = store.tasks[taskId];
  if (!task || isTerminalTask(task)) {
    return null;
  }

  const agentId = createRandomId();
  const agent: Agent = {
    id: agentId,
    taskId,
    def: agentDef,
    resumed: false,
    status: 'running',
    exitCode: null,
    signal: null,
    lastOutput: [],
    generation: 0,
    terminalSessionVersion: 0,
  };

  setStore(
    produce((state) => {
      const currentTask = state.tasks[taskId];
      if (!currentTask) {
        return;
      }

      state.agents[agentId] = agent;
      currentTask.agentIds.push(agentId);
      currentTask.selectedAgentId = agentId;
      state.activeAgentId = agentId;
      state.lastAgentId = agentDef.id;
    }),
  );

  // Start the agent as "busy" immediately, before any PTY data arrives.
  markAgentSpawned(agentId);
  void persistTaskAgentMembershipBestEffort('add', taskId, agentId);
  return agentId;
}

export async function closeAgentInTask(taskId: string, agentId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || !canCloseTaskAgent(task, agentId)) {
    return;
  }

  let didClose = false;
  closingTaskAgentIds.add(agentId);
  try {
    await invoke(IPC.KillAgent, { agentId }).catch((error) => {
      logWarn('agents.close', 'KillAgent failed while closing task agent', { agentId, error });
    });
    clearTaskPromptDispatch(agentId);
    clearAgentActivity(agentId);

    setStore(
      produce((state) => {
        const currentTask = state.tasks[taskId];
        if (!currentTask || currentTask.agentIds.length <= 1) {
          return;
        }

        const index = currentTask.agentIds.indexOf(agentId);
        if (index === -1) {
          return;
        }

        const fallbackAgentId = getCloseFallbackAgentId(currentTask.agentIds, agentId);
        currentTask.agentIds.splice(index, 1);
        removeAgentScopedStoreState(state, [agentId]);

        if (currentTask.selectedAgentId === agentId) {
          const selectionReference: Pick<Task, 'agentIds' | 'selectedAgentId'> = {
            agentIds: currentTask.agentIds,
          };
          if (fallbackAgentId) {
            selectionReference.selectedAgentId = fallbackAgentId;
          }

          const selectedAgentId = getSelectedTaskAgentId(selectionReference);
          if (selectedAgentId) {
            currentTask.selectedAgentId = selectedAgentId;
          } else {
            delete currentTask.selectedAgentId;
          }
        }

        if (state.activeAgentId === agentId) {
          state.activeAgentId = getSelectedTaskAgentId(currentTask);
        }

        if (currentTask.agentIds.length <= 1) {
          delete currentTask.terminalLayoutMode;
        }

        didClose = true;
      }),
    );
  } finally {
    closingTaskAgentIds.delete(agentId);
  }

  if (didClose) {
    await persistTaskAgentMembershipBestEffort('close', taskId, agentId);
  }
}

export function markAgentExited(
  agentId: string,
  exitInfo: PtyExitData,
  expectedGeneration?: number,
): void {
  let didMarkExited = false;
  setStore(
    produce((s) => {
      const agent = s.agents[agentId];
      if (!agent) {
        return;
      }
      if (expectedGeneration !== undefined && agent.generation !== expectedGeneration) {
        return;
      }

      agent.status = 'exited';
      agent.exitCode = exitInfo.exit_code;
      agent.signal = exitInfo.signal;
      agent.lastOutput = exitInfo.last_output;
      didMarkExited = true;
    }),
  );
  if (didMarkExited) {
    clearTaskPromptDispatch(agentId);
    clearAgentActivity(agentId);
  }
}

export function markAgentRunning(agentId: string): void {
  setAgentStatus(agentId, 'running');
}

export function setAgentStatus(agentId: string, status: Exclude<AgentStatus, 'exited'>): void {
  const agent = store.agents[agentId];
  if (!agent) return;

  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = status;
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
      }
    }),
  );

  if (isRunningRemoteAgentStatus(status)) {
    markAgentSpawned(agentId);
  }
}

export function hydrateAgentGeneration(agentId: string, generation: number): void {
  if (!isNonNegativeInteger(generation)) {
    return;
  }

  setStore(
    produce((s) => {
      const agent = s.agents[agentId];
      if (!agent) {
        return;
      }

      if (agent.generation >= generation) {
        return;
      }

      agent.generation = generation;
      agent.terminalSessionVersion = getAgentTerminalSessionVersion(agent) + 1;
      delete agent.replaceTerminalSessionOnNextAttach;
    }),
  );
}

export function getAgentTerminalSessionVersion(
  agent: Pick<Agent, 'terminalSessionVersion'>,
): number {
  return agent.terminalSessionVersion ?? 0;
}

export function restartAgent(agentId: string, resumed: boolean): void {
  clearTaskPromptDispatch(agentId);
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = 'running';
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
        s.agents[agentId].lastOutput = [];
        s.agents[agentId].resumed = resumed;
        s.agents[agentId].generation += 1;
        s.agents[agentId].replaceTerminalSessionOnNextAttach = true;
        s.agents[agentId].terminalSessionVersion =
          getAgentTerminalSessionVersion(s.agents[agentId]) + 1;
      }
    }),
  );
  markAgentSpawned(agentId);
}

export function switchAgent(agentId: string, newDef: AgentDef): void {
  clearTaskPromptDispatch(agentId);
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].def = newDef;
        s.agents[agentId].status = 'running';
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
        s.agents[agentId].lastOutput = [];
        s.agents[agentId].resumed = false;
        s.agents[agentId].generation += 1;
        s.agents[agentId].replaceTerminalSessionOnNextAttach = true;
        s.agents[agentId].terminalSessionVersion =
          getAgentTerminalSessionVersion(s.agents[agentId]) + 1;
      }
    }),
  );
  markAgentSpawned(agentId);
}

export function clearAgentTerminalSessionReplacement(
  agentId: string,
  expectedGeneration?: number,
): void {
  setStore(
    produce((s) => {
      const agent = s.agents[agentId];
      if (!agent) {
        return;
      }
      if (expectedGeneration !== undefined && agent.generation !== expectedGeneration) {
        return;
      }
      delete agent.replaceTerminalSessionOnNextAttach;
    }),
  );
}
