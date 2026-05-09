import type { AgentDef, AgentResumeStrategy } from '../ipc/types.js';
import { isHydraAgentDef } from './hydra.js';
import { isStringMember } from './type-guards.js';

type AgentResumeArgSource = Pick<AgentDef, 'adapter' | 'id' | 'resume_strategy'> & {
  args?: unknown;
  resume_args?: unknown;
  skip_permissions_args?: unknown;
};

const AGENT_RESUME_STRATEGY_VALUES = {
  'cli-args': true,
  'hydra-session': true,
  none: true,
} satisfies Record<AgentResumeStrategy, true>;

function getAgentArgs(args: unknown): string[] {
  if (!Array.isArray(args)) {
    return [];
  }

  return args.filter((arg): arg is string => typeof arg === 'string');
}

export function isAgentResumeStrategy(value: unknown): value is AgentResumeStrategy {
  return isStringMember(value, AGENT_RESUME_STRATEGY_VALUES);
}

export function getAgentResumeStrategy(agentDef: AgentResumeArgSource): AgentResumeStrategy {
  if (isAgentResumeStrategy(agentDef.resume_strategy)) {
    return agentDef.resume_strategy;
  }

  if (isHydraAgentDef(agentDef)) {
    return 'hydra-session';
  }

  return getAgentArgs(agentDef.resume_args).length > 0 ? 'cli-args' : 'none';
}

export function buildAgentSpawnArgs(
  agentDef: AgentResumeArgSource,
  options: {
    resumed: boolean;
    skipPermissions: boolean;
  },
): string[] {
  const resumeStrategy = getAgentResumeStrategy(agentDef);
  const baseArgs =
    options.resumed && resumeStrategy === 'cli-args'
      ? getAgentArgs(agentDef.resume_args)
      : getAgentArgs(agentDef.args);
  const skipPermissionArgs = options.skipPermissions
    ? getAgentArgs(agentDef.skip_permissions_args)
    : [];

  const mergedArgs = [...baseArgs];
  for (const arg of skipPermissionArgs) {
    if (!mergedArgs.includes(arg)) {
      mergedArgs.push(arg);
    }
  }

  return mergedArgs;
}

export function shouldResumeAgentOnSpawn(
  agentDef: AgentResumeArgSource,
  resumed: boolean,
): boolean {
  const resumeStrategy = getAgentResumeStrategy(agentDef);
  return resumed && resumeStrategy === 'hydra-session';
}
