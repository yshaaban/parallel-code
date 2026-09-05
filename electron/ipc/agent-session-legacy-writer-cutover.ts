import { AGENT_SESSION_OWNER_HOOK_SET_VERSION } from '../../src/domain/agent-session-operation.js';
import type { AgentSessionLegacyWriterCutover } from './agent-session-removal-participant.js';
import type { AgentSessionWriterRuntime } from './agent-session-writer-authority.js';
import {
  changed,
  unchanged,
  type WorkspacePrivateMutationAuthority,
} from './workspace-state-mutations.js';
import { cloneJsonObject, type JsonObject } from './workspace-state-storage.js';

const SCHEMA_KEY = 'agentSessionWriterSchema';
const ACTIVE_WRITER = 'agent-session-operation-v1';

interface AgentSessionWriterSchema extends JsonObject {
  activeWriter: typeof ACTIVE_WRITER;
  cutoverEpoch: string;
  hookSetVersion: typeof AGENT_SESSION_OWNER_HOOK_SET_VERSION;
  legacyWritersDisabled: true;
}

function isSchema(value: unknown): value is AgentSessionWriterSchema {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { activeWriter?: unknown }).activeWriter === ACTIVE_WRITER &&
    typeof (value as { cutoverEpoch?: unknown }).cutoverEpoch === 'string' &&
    (value as { hookSetVersion?: unknown }).hookSetVersion ===
      AGENT_SESSION_OWNER_HOOK_SET_VERSION &&
    (value as { legacyWritersDisabled?: unknown }).legacyWritersDisabled === true
  );
}

function schemaFor(cutoverEpoch: string): AgentSessionWriterSchema {
  return {
    activeWriter: ACTIVE_WRITER,
    cutoverEpoch,
    hookSetVersion: AGENT_SESSION_OWNER_HOOK_SET_VERSION,
    legacyWritersDisabled: true,
  };
}

/** Durable cutover paired with the process-local permit gate. */
export class WorkspaceAgentSessionLegacyWriterCutover implements AgentSessionLegacyWriterCutover {
  constructor(
    private readonly authority: WorkspacePrivateMutationAuthority,
    private readonly writer: AgentSessionWriterRuntime,
  ) {}

  async activate(cutoverEpoch: string): Promise<void> {
    if (cutoverEpoch.trim().length === 0 || cutoverEpoch.includes('\u0000')) {
      throw new Error('Agent-session cutover epoch is invalid');
    }
    await this.authority.mutate(
      { operation: 'activate-agent-session-writer-cutover' },
      (slices) => {
        const current = slices.privateState[SCHEMA_KEY];
        if (current !== undefined) {
          if (!isSchema(current) || current.cutoverEpoch !== cutoverEpoch) {
            throw new Error('Agent-session writer cutover conflicts with persisted state');
          }
          return unchanged(undefined);
        }
        const nextPrivateState = cloneJsonObject(slices.privateState);
        nextPrivateState[SCHEMA_KEY] = schemaFor(cutoverEpoch);
        return changed({ nextPrivateState }, undefined);
      },
    );
    this.writer.activate(cutoverEpoch);
    await this.verify(cutoverEpoch);
  }

  async verify(cutoverEpoch: string): Promise<void> {
    await this.authority.mutate({ operation: 'verify-agent-session-writer-cutover' }, (slices) => {
      const current = slices.privateState[SCHEMA_KEY];
      if (!isSchema(current) || current.cutoverEpoch !== cutoverEpoch) {
        throw new Error('Agent-session writer cutover is unavailable or mismatched');
      }
      return unchanged(undefined);
    });
    this.writer.verify(cutoverEpoch);
  }
}
