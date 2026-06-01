import type { AgentDef } from '../ipc/types.js';
import { getHydraCommandOverride, isHydraAgentDef, type HydraStartupMode } from './hydra.js';

export function getAgentSpawnCommand(agentDef: AgentDef, hydraCommand: string): string {
  if (!isHydraAgentDef(agentDef)) {
    return agentDef.command;
  }

  return getHydraCommandOverride(agentDef, hydraCommand);
}

export function getAgentSpawnEnvironment(
  agentDef: AgentDef,
  hydraStartupMode: HydraStartupMode,
): Record<string, string> | undefined {
  const baseEnv = agentDef.env;
  if (!isHydraAgentDef(agentDef)) {
    return baseEnv;
  }

  return { ...(baseEnv ?? {}), PARALLEL_CODE_HYDRA_STARTUP_MODE: hydraStartupMode };
}
