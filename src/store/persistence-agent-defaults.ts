import type { AgentDef } from '../ipc/types';
import { getAgentResumeStrategy } from '../lib/agent-resume';
import { applyHydraCommandOverride } from '../lib/hydra';
import { isNonEmptyString } from '../lib/type-guards';
import type { LegacyPersistedState } from './persistence-legacy-state';

function normalizeAgentArgList(value: unknown): string[] {
  return Array.isArray(value) ? [...value] : [];
}

function normalizePersistedAgentDef(agentDef: AgentDef, hydraCommand: string): AgentDef {
  const normalizedAgent: AgentDef = {
    ...agentDef,
    args: normalizeAgentArgList(agentDef.args),
    description: typeof agentDef.description === 'string' ? agentDef.description : agentDef.name,
    resume_args: normalizeAgentArgList(agentDef.resume_args),
    skip_permissions_args: normalizeAgentArgList(agentDef.skip_permissions_args),
  };
  normalizedAgent.resume_strategy = getAgentResumeStrategy(normalizedAgent);
  return applyHydraCommandOverride(normalizedAgent, hydraCommand);
}

export function resolvePersistedAgentId(agentId: unknown): string {
  return isNonEmptyString(agentId) ? agentId : crypto.randomUUID();
}

export function getRestoredHydraCommand(raw: LegacyPersistedState): string {
  return typeof raw.hydraCommand === 'string' ? raw.hydraCommand.trim() : '';
}

export function hydratePersistedAgentDef(
  agentDef: AgentDef | null | undefined,
  availableAgents: AgentDef[],
  hydraCommand: string,
): void {
  if (!agentDef) {
    return;
  }

  agentDef.args = normalizeAgentArgList(agentDef.args);
  agentDef.description =
    typeof agentDef.description === 'string' ? agentDef.description : agentDef.name;
  agentDef.resume_args = normalizeAgentArgList(agentDef.resume_args);
  agentDef.skip_permissions_args = normalizeAgentArgList(agentDef.skip_permissions_args);
  const fresh = availableAgents.find((agent) => agent.id === agentDef.id);
  if (!agentDef.adapter && agentDef.id === 'hydra') {
    agentDef.adapter = 'hydra';
  }
  if (!agentDef.adapter && fresh?.adapter) {
    agentDef.adapter = fresh.adapter;
  }
  agentDef.resume_strategy = getAgentResumeStrategy(fresh ?? agentDef);
  if (fresh) {
    if (!Array.isArray(agentDef.args) || (agentDef.args.length === 0 && fresh.args.length > 0)) {
      agentDef.args = [...fresh.args];
    }
    if (
      !Array.isArray(agentDef.resume_args) ||
      (agentDef.resume_args.length === 0 && fresh.resume_args.length > 0)
    ) {
      agentDef.resume_args = [...fresh.resume_args];
    }
    if (
      !Array.isArray(agentDef.skip_permissions_args) ||
      (agentDef.skip_permissions_args.length === 0 && fresh.skip_permissions_args.length > 0)
    ) {
      agentDef.skip_permissions_args = [...fresh.skip_permissions_args];
    }
  }
  agentDef.command = applyHydraCommandOverride(agentDef, hydraCommand).command;
}

export function createWorkspaceStateBaseAgents(
  raw: LegacyPersistedState,
  restoredHydraCommand: string,
  currentAvailableAgents: ReadonlyArray<AgentDef>,
  currentCustomAgents: ReadonlyArray<AgentDef>,
): {
  availableAgents: AgentDef[];
  customAgents: AgentDef[];
} {
  const defaultAvailableAgents = currentAvailableAgents.filter(
    (agent) => !currentCustomAgents.some((custom) => custom.id === agent.id),
  );
  const customAgents = Array.isArray(raw.customAgents)
    ? raw.customAgents
        .filter(
          (agent: unknown): agent is AgentDef =>
            typeof agent === 'object' &&
            agent !== null &&
            typeof (agent as AgentDef).id === 'string' &&
            typeof (agent as AgentDef).name === 'string' &&
            typeof (agent as AgentDef).command === 'string',
        )
        .map((agent) => normalizePersistedAgentDef(agent, restoredHydraCommand))
    : [];
  const availableAgents = defaultAvailableAgents.map((agent) =>
    applyHydraCommandOverride(agent, restoredHydraCommand),
  );

  for (const customAgent of customAgents) {
    if (!availableAgents.some((agent) => agent.id === customAgent.id)) {
      availableAgents.push(applyHydraCommandOverride(customAgent, restoredHydraCommand));
    }
  }

  return {
    availableAgents,
    customAgents,
  };
}
