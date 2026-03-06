import { isCommandAvailable } from './command-resolver.js';

interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
  available?: boolean;
}

const DEFAULT_AGENTS: AgentDef[] = [
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

// TTL cache to avoid repeated `which` calls
let cachedAgents: AgentDef[] | null = null;
let cacheTime = 0;
const AGENT_CACHE_TTL = 30_000;

function hasFreshAgentCache(now: number): boolean {
  return cachedAgents !== null && now - cacheTime < AGENT_CACHE_TTL;
}

async function withAvailability(agent: AgentDef): Promise<AgentDef> {
  return {
    ...agent,
    available: await isCommandAvailable(agent.command),
  };
}

export async function listAgents(): Promise<AgentDef[]> {
  const now = Date.now();
  if (cachedAgents && hasFreshAgentCache(now)) {
    return cachedAgents;
  }

  cachedAgents = await Promise.all(DEFAULT_AGENTS.map(withAvailability));
  cacheTime = now;
  return cachedAgents;
}
