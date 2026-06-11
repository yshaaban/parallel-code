import type { AgentDef } from '../../src/ipc/types.js';
import type { AgentAvailabilitySnapshot } from '../../src/domain/agent-availability.js';
import {
  getAgentAvailabilitySnapshot,
  requestAgentAvailabilityRevalidation,
  type AgentAvailabilityProbeTarget,
  type AgentAvailabilityRevalidationReason,
} from './agent-availability-state.js';

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

function cloneAgentDef(agent: AgentDef): AgentDef {
  return {
    ...agent,
    args: [...agent.args],
    ...(agent.env !== undefined ? { env: { ...agent.env } } : {}),
    resume_args: [...agent.resume_args],
    skip_permissions_args: [...agent.skip_permissions_args],
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

function withLastKnownAvailability(
  agent: AgentDef,
  snapshot: AgentAvailabilitySnapshot | null,
): AgentDef {
  if (!snapshot || snapshot.status !== 'known') {
    return {
      ...agent,
      availabilityStatus: 'probing',
    };
  }

  return {
    ...agent,
    availabilityStatus: 'known',
    ...(snapshot.available !== undefined ? { available: snapshot.available } : {}),
    ...(snapshot.availabilityReason !== undefined
      ? { availabilityReason: snapshot.availabilityReason }
      : {}),
    ...(snapshot.availabilitySource !== undefined
      ? { availabilitySource: snapshot.availabilitySource }
      : {}),
  };
}

// Pure synchronous read for the cold-bootstrap handler and ListAgents: default
// defs merged with last-known sticky availability, never probing inline.
export function getAgentDefsWithLastKnownAvailability(hydraCommandOverride = ''): AgentDef[] {
  const normalizedHydraCommand = hydraCommandOverride.trim();
  return DEFAULT_AGENTS.map((agent) =>
    withLastKnownAvailability(
      cloneAgentDef(applyHydraCommandOverride(agent, normalizedHydraCommand)),
      getAgentAvailabilitySnapshot(agent.id),
    ),
  );
}

function getAgentAvailabilityProbeTargets(
  hydraCommandOverride = '',
): AgentAvailabilityProbeTarget[] {
  const normalizedHydraCommand = hydraCommandOverride.trim();
  return DEFAULT_AGENTS.map((agent) => {
    const effective = applyHydraCommandOverride(agent, normalizedHydraCommand);
    return {
      agentId: agent.id,
      command: effective.command,
      ...(agent.adapter === 'hydra' ? { adapter: 'hydra' as const } : {}),
    };
  });
}

export function requestAgentCatalogAvailabilityRevalidation(
  reason: AgentAvailabilityRevalidationReason,
  hydraCommandOverride = '',
): void {
  requestAgentAvailabilityRevalidation({
    reason,
    targets: getAgentAvailabilityProbeTargets(hydraCommandOverride),
  });
}

export function listAgents(hydraCommandOverride = ''): AgentDef[] {
  const agents = getAgentDefsWithLastKnownAvailability(hydraCommandOverride);
  // Background revalidation keeps sticky results honest without ever probing on
  // this read path; the state owner throttles repeat requests and bypasses the
  // throttle when the hydra command key changes.
  requestAgentCatalogAvailabilityRevalidation('boot', hydraCommandOverride);
  return agents;
}
