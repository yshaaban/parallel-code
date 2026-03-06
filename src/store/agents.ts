import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import type { AgentDef } from '../ipc/types';
import type { Agent } from './types';
import { refreshTaskStatus, clearAgentActivity, markAgentSpawned } from './taskStatus';

const FALLBACK_AGENT_DEFS: AgentDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: "Anthropic's Claude Code CLI agent",
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    args: [],
    resume_args: ['resume', '--last'],
    skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
    description: "OpenAI's Codex CLI agent",
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: [],
    resume_args: ['--resume', 'latest'],
    skip_permissions_args: ['--yolo'],
    description: "Google's Gemini CLI agent",
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: 'Open source AI coding agent (opencode.ai)',
  },
];

function isAgentDef(value: unknown): value is AgentDef {
  if (!value || typeof value !== 'object') return false;
  const agent = value as AgentDef;
  return (
    typeof agent.id === 'string' &&
    typeof agent.name === 'string' &&
    typeof agent.command === 'string' &&
    Array.isArray(agent.args) &&
    Array.isArray(agent.resume_args) &&
    Array.isArray(agent.skip_permissions_args) &&
    typeof agent.description === 'string'
  );
}

function cloneAgents(agents: AgentDef[]): AgentDef[] {
  return agents.map((agent) => ({ ...agent }));
}

function mergeAvailableAgents(defaults: AgentDef[]): AgentDef[] {
  const custom = store.customAgents;
  const customIds = new Set(custom.map((a) => a.id));
  const merged = [...defaults.filter((d) => !customIds.has(d.id)), ...custom];
  setStore('availableAgents', merged);
  return merged;
}

function normalizeLoadedAgents(value: unknown): AgentDef[] {
  if (!Array.isArray(value)) return cloneAgents(FALLBACK_AGENT_DEFS);
  const agents = value.filter(isAgentDef);
  return agents.length > 0 ? agents : cloneAgents(FALLBACK_AGENT_DEFS);
}

export async function loadAgents(): Promise<AgentDef[]> {
  try {
    const defaults = normalizeLoadedAgents(await invoke<unknown>(IPC.ListAgents));
    return mergeAvailableAgents(defaults);
  } catch (error) {
    console.warn('Failed to load agent catalog from IPC, using builtin defaults:', error);
    return mergeAvailableAgents(cloneAgents(FALLBACK_AGENT_DEFS));
  }
}

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
      s.agents[agentId] = agent;
      s.tasks[taskId].agentIds.push(agentId);
      s.activeAgentId = agentId;
    }),
  );

  // Start the agent as "busy" immediately, before any PTY data arrives.
  markAgentSpawned(agentId);
}

export function markAgentExited(
  agentId: string,
  exitInfo: { exit_code: number | null; signal: string | null; last_output: string[] },
): void {
  const agent = store.agents[agentId];
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = 'exited';
        s.agents[agentId].exitCode = exitInfo.exit_code;
        s.agents[agentId].signal = exitInfo.signal;
        s.agents[agentId].lastOutput = exitInfo.last_output;
      }
    }),
  );
  if (agent) {
    clearAgentActivity(agentId);
    refreshTaskStatus(agent.taskId);
  }
}

export function markAgentRunning(agentId: string): void {
  const agent = store.agents[agentId];
  if (!agent) return;

  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = 'running';
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
      }
    }),
  );

  markAgentSpawned(agentId);
  refreshTaskStatus(agent.taskId);
}

export function restartAgent(agentId: string, useResumeArgs: boolean): void {
  setStore(
    produce((s) => {
      if (s.agents[agentId]) {
        s.agents[agentId].status = 'running';
        s.agents[agentId].exitCode = null;
        s.agents[agentId].signal = null;
        s.agents[agentId].lastOutput = [];
        s.agents[agentId].resumed = useResumeArgs;
        s.agents[agentId].generation += 1;
      }
    }),
  );
  markAgentSpawned(agentId);
}

export function addCustomAgent(agent: AgentDef): void {
  setStore(
    produce((s) => {
      s.customAgents.push(agent);
    }),
  );
  refreshAvailableAgents();
}

export function removeCustomAgent(agentId: string): void {
  setStore(
    produce((s) => {
      s.customAgents = s.customAgents.filter((a) => a.id !== agentId);
    }),
  );
  refreshAvailableAgents();
}

export function updateCustomAgent(agentId: string, updated: AgentDef): void {
  setStore(
    produce((s) => {
      const idx = s.customAgents.findIndex((a) => a.id === agentId);
      if (idx >= 0) s.customAgents[idx] = updated;
    }),
  );
  refreshAvailableAgents();
}

function refreshAvailableAgents(): void {
  void loadAgents();
}
