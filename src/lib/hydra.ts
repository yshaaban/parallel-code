import type { AgentDef } from '../ipc/types.js';

export const HYDRA_STARTUP_MODES = ['auto', 'dispatch', 'smart', 'council'] as const;
export type HydraStartupMode = (typeof HYDRA_STARTUP_MODES)[number];
const HYDRA_STARTUP_MODE_SET: ReadonlySet<string> = new Set(HYDRA_STARTUP_MODES);

export const HYDRA_FORCE_DISPATCH_PREFIX = '!';

export function isHydraAgentDef(
  agentDef: Pick<AgentDef, 'id' | 'adapter'> | null | undefined,
): boolean {
  return agentDef?.adapter === 'hydra' || agentDef?.id === 'hydra';
}

export function applyHydraCommandOverride(agent: AgentDef, hydraCommand: string): AgentDef {
  if (!isHydraAgentDef(agent)) return { ...agent };
  const normalized = hydraCommand.trim();
  return {
    ...agent,
    command: normalized || 'hydra',
  };
}

export function getHydraCommandOverride(agent: AgentDef, hydraCommand: string): string {
  return applyHydraCommandOverride(agent, hydraCommand).command;
}

export function getHydraPromptPanelText(text: string, forceDispatch = true): string {
  const trimmed = text.trim();
  if (!forceDispatch || !trimmed || trimmed.startsWith(HYDRA_FORCE_DISPATCH_PREFIX)) {
    return text;
  }
  return `${HYDRA_FORCE_DISPATCH_PREFIX}${trimmed}`;
}

export function isHydraCoordinationArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return normalized === 'docs/coordination' || normalized.startsWith('docs/coordination/');
}

export function isHydraStartupMode(value: string | undefined): value is HydraStartupMode {
  return typeof value === 'string' && HYDRA_STARTUP_MODE_SET.has(value);
}
