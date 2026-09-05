import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import type { AgentSessionRemovalOwnerHooks } from './agent-session-workflow.js';
import type { TaskRemovalOwnerParticipant } from './task-removal-owner.js';

export interface AgentSessionLegacyWriterCutover {
  activate(cutoverEpoch: string): Promise<void>;
  verify(cutoverEpoch: string): Promise<void>;
}

/**
 * C5 adapter for D11's dark hooks. The legacy writer proof is a required,
 * separately owned dependency; omitting it cannot be represented as success.
 */
export function createAgentSessionRemovalParticipant(args: {
  hooks: AgentSessionRemovalOwnerHooks;
  legacyWriterCutover: AgentSessionLegacyWriterCutover;
}): TaskRemovalOwnerParticipant {
  return {
    activateLegacyEffectCutover: (cutoverEpoch) => args.legacyWriterCutover.activate(cutoverEpoch),
    drainTaskForRemoval: (request) => args.hooks.drainTaskAgentSessionsForRemoval(request),
    finalizeRemovedTaskState: (request) => args.hooks.finalizeRemovedTaskAgentSessionState(request),
    hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
    id: 'agent-session',
    probe: () => args.hooks.probe(),
    verifyLegacyEffectCutover: (cutoverEpoch) => args.legacyWriterCutover.verify(cutoverEpoch),
  };
}
