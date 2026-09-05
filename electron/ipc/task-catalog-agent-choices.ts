import type { RemoteAgentChoice } from '../../src/domain/task-catalog.js';
import type { JsonObject } from './workspace-state-storage.js';

export interface TaskCatalogAgentDefinition {
  adapter?: string;
  id: string;
  name: string;
  skip_permissions_args?: readonly string[];
}

function readCustomDefinitions(sharedState: Readonly<JsonObject>): TaskCatalogAgentDefinition[] {
  if (!Array.isArray(sharedState.customAgents)) return [];
  return sharedState.customAgents.flatMap((value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== 'string' ||
      typeof (value as { name?: unknown }).name !== 'string'
    ) {
      return [];
    }
    const agent = value as Record<string, unknown>;
    return [
      {
        ...(typeof agent.adapter === 'string' ? { adapter: agent.adapter } : {}),
        id: agent.id as string,
        name: agent.name as string,
        ...(Array.isArray(agent.skip_permissions_args) &&
        agent.skip_permissions_args.every((entry) => typeof entry === 'string')
          ? { skip_permissions_args: agent.skip_permissions_args as string[] }
          : {}),
      },
    ];
  });
}

/** Builds only the shell-neutral static fields that may enter the remote catalog. */
export function buildTaskCatalogAgentChoices(
  sharedState: Readonly<JsonObject>,
  defaults: readonly TaskCatalogAgentDefinition[],
): RemoteAgentChoice[] {
  const custom = readCustomDefinitions(sharedState);
  const customIds = new Set(custom.map((agent) => agent.id));
  return [...defaults.filter((agent) => !customIds.has(agent.id)), ...custom].map((agent) => ({
    agentDefId: agent.id,
    displayName: agent.name,
    displayNameTruncated: false,
    glyph: null,
    glyphTruncated: false,
    providerLabel: agent.adapter === 'hydra' ? 'Hydra' : null,
    providerLabelTruncated: false,
    supportsInitialPrompt: true,
    supportsPermissionBypass: (agent.skip_permissions_args?.length ?? 0) > 0,
  }));
}
