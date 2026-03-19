import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { isAgentResumeStrategy } from '../lib/agent-resume';
import { applyHydraCommandOverride } from '../lib/hydra';
import type { AgentDef } from '../ipc/types';
import { setStore, store } from '../store/state';

const FALLBACK_AGENT_DEFS: AgentDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
    resume_args: ['--continue'],
    resume_strategy: 'cli-args',
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: "Anthropic's Claude Code CLI agent",
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    args: ['--dangerously-bypass-approvals-and-sandbox'],
    resume_args: ['resume', '--last'],
    resume_strategy: 'cli-args',
    skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
    description: "OpenAI's Codex CLI agent",
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--yolo'],
    resume_args: ['--resume', 'latest'],
    resume_strategy: 'cli-args',
    skip_permissions_args: ['--yolo'],
    description: "Google's Gemini CLI agent",
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: [],
    resume_args: [],
    resume_strategy: 'none',
    skip_permissions_args: [],
    description: 'Open source AI coding agent (opencode.ai)',
  },
  {
    id: 'hydra',
    name: 'Hydra',
    command: 'hydra',
    args: [],
    resume_args: [],
    resume_strategy: 'hydra-session',
    skip_permissions_args: [],
    description:
      'Hydra orchestrates Claude, Gemini, and Codex behind one operator console with its own daemon, workers, and routing logic.',
    adapter: 'hydra',
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
    (agent.resume_strategy === undefined || isAgentResumeStrategy(agent.resume_strategy)) &&
    Array.isArray(agent.skip_permissions_args) &&
    (agent.adapter === undefined || agent.adapter === 'hydra') &&
    typeof agent.description === 'string'
  );
}

function cloneAgents(agents: AgentDef[]): AgentDef[] {
  return agents.map((agent) => applyHydraCommandOverride(agent, store.hydraCommand));
}

function mergeAvailableAgents(defaults: AgentDef[]): AgentDef[] {
  const customAgents = store.customAgents;
  const customIds = new Set(customAgents.map((agent) => agent.id));
  const merged = [...defaults.filter((agent) => !customIds.has(agent.id)), ...customAgents].map(
    (agent) => applyHydraCommandOverride(agent, store.hydraCommand),
  );
  setStore('availableAgents', merged);
  return merged;
}

function normalizeLoadedAgents(value: unknown): AgentDef[] {
  if (!Array.isArray(value)) return cloneAgents(FALLBACK_AGENT_DEFS);
  const agents = value.filter(isAgentDef);
  return agents.length > 0 ? agents : cloneAgents(FALLBACK_AGENT_DEFS);
}

function refreshAvailableAgents(): void {
  void loadAgents();
}

export async function loadAgents(): Promise<AgentDef[]> {
  try {
    const hydraCommand = store.hydraCommand.trim();
    const defaults = normalizeLoadedAgents(
      hydraCommand ? await invoke(IPC.ListAgents, { hydraCommand }) : await invoke(IPC.ListAgents),
    );
    return mergeAvailableAgents(defaults);
  } catch (error) {
    console.warn('Failed to load agent catalog from IPC, using builtin defaults:', error);
    return mergeAvailableAgents(cloneAgents(FALLBACK_AGENT_DEFS));
  }
}

export function addCustomAgent(agent: AgentDef): void {
  setStore('customAgents', (agents) => [...agents, agent]);
  refreshAvailableAgents();
}

export function removeCustomAgent(agentId: string): void {
  setStore('customAgents', (agents) => agents.filter((agent) => agent.id !== agentId));
  refreshAvailableAgents();
}

export function updateCustomAgent(agentId: string, updated: AgentDef): void {
  setStore('customAgents', (agents) =>
    agents.map((agent) => (agent.id === agentId ? updated : agent)),
  );
  refreshAvailableAgents();
}
