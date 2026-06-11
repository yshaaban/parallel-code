import type { AgentDef } from '../ipc/types.js';
import { isRecord } from '../lib/type-guards.js';

export type AgentAvailabilityStatus = 'probing' | 'known';

export type AgentAvailabilitySource = NonNullable<AgentDef['availabilitySource']>;

export interface AgentAvailabilitySnapshot {
  agentId: string;
  available?: boolean;
  availabilityReason?: string;
  availabilitySource?: AgentAvailabilitySource;
  probedAt: number | null;
  status: AgentAvailabilityStatus;
}

const AGENT_AVAILABILITY_SOURCES: ReadonlySet<string> = new Set([
  'path',
  'bundled',
  'override',
  'unavailable',
]);

function isAgentAvailabilityStatus(value: unknown): value is AgentAvailabilityStatus {
  return value === 'probing' || value === 'known';
}

function isAgentAvailabilitySource(value: unknown): value is AgentAvailabilitySource {
  return typeof value === 'string' && AGENT_AVAILABILITY_SOURCES.has(value);
}

export function isAgentAvailabilitySnapshot(value: unknown): value is AgentAvailabilitySnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.agentId === 'string' &&
    (value.available === undefined || typeof value.available === 'boolean') &&
    (value.availabilityReason === undefined || typeof value.availabilityReason === 'string') &&
    (value.availabilitySource === undefined ||
      isAgentAvailabilitySource(value.availabilitySource)) &&
    (value.probedAt === null || typeof value.probedAt === 'number') &&
    isAgentAvailabilityStatus(value.status)
  );
}

// Live availability pushes carry the backend state version so the renderer can
// apply the same stale-version guard to events and bootstrap snapshots (state
// that updates through both request/response IPC and pushed events needs a
// backend ordering signal).
export interface AgentAvailabilityChangedEvent {
  snapshots: AgentAvailabilitySnapshot[];
  version: number;
}

export function isAgentAvailabilityChangedEvent(
  value: unknown,
): value is AgentAvailabilityChangedEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version >= 0 &&
    Array.isArray(value.snapshots) &&
    value.snapshots.every(isAgentAvailabilitySnapshot)
  );
}
