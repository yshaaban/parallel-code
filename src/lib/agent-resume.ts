import type { AgentDef, AgentResumeStrategy } from '../ipc/types.js';
import { isHydraAgentDef } from './hydra.js';

function getAgentArgs(args: unknown): string[] {
  return Array.isArray(args) ? args : [];
}

export function isAgentResumeStrategy(value: unknown): value is AgentResumeStrategy {
  return value === 'none' || value === 'cli-args' || value === 'hydra-session';
}

export function getAgentResumeStrategy(agentDef: AgentDef): AgentResumeStrategy {
  if (isAgentResumeStrategy(agentDef.resume_strategy)) {
    return agentDef.resume_strategy;
  }

  if (isHydraAgentDef(agentDef)) {
    return 'hydra-session';
  }

  return getAgentArgs(agentDef.resume_args).length > 0 ? 'cli-args' : 'none';
}

export function buildAgentSpawnArgs(
  agentDef: AgentDef,
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

export function shouldResumeAgentOnSpawn(agentDef: AgentDef, resumed: boolean): boolean {
  const resumeStrategy = getAgentResumeStrategy(agentDef);
  return resumed && resumeStrategy === 'hydra-session';
}
