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

// TTL cache to avoid repeated `which` calls
let cachedAgents: AgentDef[] | null = null;
let cacheTime = 0;
let cacheKey = '';
const AGENT_CACHE_TTL = 30_000;

function hasFreshAgentCache(now: number, nextCacheKey: string): boolean {
  return cachedAgents !== null && cacheKey === nextCacheKey && now - cacheTime < AGENT_CACHE_TTL;
}

async function withAvailability(agent: AgentDef): Promise<AgentDef> {
  if (agent.adapter === 'hydra') {
    const availability = await getHydraRuntimeAvailability(agent.command, {
      resolveBareCommandPath: true,
    });

    return {
      ...agent,
      available: availability.available,
      availabilityReason: availability.detail,
      availabilitySource: availability.source,
    };
  }

  const available = await isCommandAvailable(agent.command);

  return {
    ...agent,
    available,
    ...(agent.command.trim()
      ? available
        ? {
            availabilityReason: `Using ${agent.command.trim()} from PATH.`,
            availabilitySource: 'path' as const,
          }
        : {
            availabilityReason: `Command '${agent.command.trim()}' was not found on PATH.`,
            availabilitySource: 'unavailable' as const,
          }
      : {}),
  };
}

export async function listAgents(hydraCommandOverride = ''): Promise<AgentDef[]> {
  const now = Date.now();
  const normalizedHydraCommand = hydraCommandOverride.trim();
  const nextCacheKey = normalizedHydraCommand || 'hydra';

  if (cachedAgents && hasFreshAgentCache(now, nextCacheKey)) {
    return cachedAgents;
  }

  cachedAgents = await Promise.all(
    DEFAULT_AGENTS.map((agent) =>
      withAvailability(
        agent.adapter === 'hydra' && normalizedHydraCommand
          ? {
              ...agent,
              command: normalizedHydraCommand,
            }
          : agent,
      ),
    ),
  );
  cacheKey = nextCacheKey;
  cacheTime = now;
  return cachedAgents;
}
