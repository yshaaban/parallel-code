import { produce } from 'solid-js/store';
import { isRunningRemoteAgentStatus } from '../domain/server-state';
import type { AgentDef, PtyExitData } from '../ipc/types';
import { clearTaskPromptDispatch } from '../app/task-prompt-dispatch';
import { store, setStore } from './core';
import type { Agent, AgentStatus } from './types';
import { clearAgentActivity, markAgentSpawned } from './taskStatus';

export async function addAgentToTask(taskId: string, agentDef: AgentDef): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;

  const agentId = crypto.randomUUID();
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
  };

  setStore(
    produce((s) => {
      const currentTask = s.tasks[taskId];
      if (!currentTask) return;
      s.agents[agentId] = agent;
      currentTask.agentIds.push(agentId);
      s.activeAgentId = agentId;
    }),
  );

  // Start the agent as "busy" immediately, before any PTY data arrives.
  markAgentSpawned(agentId);
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
  if (!Number.isInteger(generation) || generation < 0) {
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
    }),
  );
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
      }
    }),
  );
  markAgentSpawned(agentId);
}
