import type { AgentDef } from '../../src/ipc/types.js';
import { isCommandAvailable } from './command-resolver.js';
import { getHydraRuntimeAvailability } from './hydra-adapter.js';

const DEFAULT_AGENTS: AgentDef[] = [
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
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    args: ['--dangerously-skip-permissions'],
    resume_args: ['-c'],
    resume_strategy: 'cli-args',
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: "Google's Antigravity CLI agent",
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

let cachedAgents: AgentDef[] | null = null;
let cacheTime = 0;
let cacheKey = '';
const AVAILABLE_AGENT_CACHE_TTL_MS = 30_000;
const UNAVAILABLE_AGENT_CACHE_TTL_MS = 5_000;

function cloneAgentDef(agent: AgentDef): AgentDef {
  return {
    ...agent,
    args: [...agent.args],
    resume_args: [...agent.resume_args],
    skip_permissions_args: [...agent.skip_permissions_args],
  };
}

function getAgentCacheTtlMs(agents: AgentDef[]): number {
  if (agents.some((agent) => agent.available === false)) {
    return UNAVAILABLE_AGENT_CACHE_TTL_MS;
  }

  return AVAILABLE_AGENT_CACHE_TTL_MS;
}

function hasFreshAgentCache(now: number, nextCacheKey: string): boolean {
  if (cachedAgents === null || cacheKey !== nextCacheKey) {
    return false;
  }

  return now - cacheTime < getAgentCacheTtlMs(cachedAgents);
}

function getPathAvailabilityDetails(agent: AgentDef, available: boolean): Partial<AgentDef> {
  const command = agent.command.trim();
  if (!command) {
    return {};
  }

  if (available) {
    return {
      availabilityReason: `Using ${command} from PATH.`,
      availabilitySource: 'path',
    };
  }

  return {
    availabilityReason: `Command '${command}' was not found on PATH.`,
    availabilitySource: 'unavailable',
  };
}

async function withAvailability(agent: AgentDef): Promise<AgentDef> {
  if (agent.adapter === 'hydra') {
    const availability = await getHydraRuntimeAvailability(agent.command, {
      resolveBareCommandPath: true,
    });

    return {
      ...cloneAgentDef(agent),
      available: availability.available,
      availabilityReason: availability.detail,
      availabilitySource: availability.source,
    };
  }

  const available = await isCommandAvailable(agent.command);

  return {
    ...cloneAgentDef(agent),
    available,
    ...getPathAvailabilityDetails(agent, available),
  };
}

function applyHydraCommandOverride(agent: AgentDef, command: string): AgentDef {
  if (agent.adapter !== 'hydra' || !command) {
    return agent;
  }

  return {
    ...agent,
    command,
  };
}

export async function listAgents(hydraCommandOverride = ''): Promise<AgentDef[]> {
  const now = Date.now();
  const normalizedHydraCommand = hydraCommandOverride.trim();
  const nextCacheKey = normalizedHydraCommand || 'hydra';

  if (cachedAgents && hasFreshAgentCache(now, nextCacheKey)) {
    return cachedAgents.map(cloneAgentDef);
  }

  cachedAgents = await Promise.all(
    DEFAULT_AGENTS.map((agent) =>
      withAvailability(applyHydraCommandOverride(agent, normalizedHydraCommand)),
    ),
  );
  cacheKey = nextCacheKey;
  cacheTime = now;
  return cachedAgents.map(cloneAgentDef);
}
