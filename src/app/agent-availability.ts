import type {
  AgentAvailabilityChangedEvent,
  AgentAvailabilitySnapshot,
} from '../domain/agent-availability';
import type { AgentDef } from '../ipc/types';
import { setStore, store } from '../store/state';

// Renderer applier for the backend-owned 'agent-availability' server-state
// category. Last-applied snapshots are retained so a later agent-catalog merge
// cannot clobber newer availability truth with stale catalog responses.

let lastAppliedVersion = -1;
const lastAppliedSnapshots = new Map<string, AgentAvailabilitySnapshot>();

export function getAgentAvailabilityHighestAppliedVersion(): number {
  return lastAppliedVersion;
}

function mergeAvailabilityIntoAgent(
  agent: AgentDef,
  snapshot: AgentAvailabilitySnapshot,
): AgentDef {
  if (snapshot.status !== 'known') {
    return agent;
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

export function applyKnownAgentAvailability(agents: AgentDef[]): AgentDef[] {
  if (lastAppliedSnapshots.size === 0) {
    return agents;
  }

  return agents.map((agent) => {
    const snapshot = lastAppliedSnapshots.get(agent.id);
    return snapshot ? mergeAvailabilityIntoAgent(agent, snapshot) : agent;
  });
}

export function applyAgentAvailabilitySnapshots(
  payload: AgentAvailabilitySnapshot[],
  version?: number,
): void {
  if (version !== undefined) {
    if (version < lastAppliedVersion) {
      return;
    }

    lastAppliedVersion = version;
  }

  for (const snapshot of payload) {
    lastAppliedSnapshots.set(snapshot.agentId, snapshot);
  }

  setStore('availableAgents', applyKnownAgentAvailability(store.availableAgents));
}

// Live events carry the backend state version, so the same stale-version guard
// protects both the bootstrap snapshot path and pushed events: an event
// generated before the bootstrap snapshot cannot overwrite it after boot
// buffering replays it.
export function applyAgentAvailabilityEvent(event: AgentAvailabilityChangedEvent): void {
  applyAgentAvailabilitySnapshots(event.snapshots, event.version);
}

// Availability versions are per-boot backend counters; a new server instance
// restarts them, so the resync applier resets the applied-version guard before
// hydrating the new instance's full bootstrap. Last-applied snapshots are kept:
// they are sticky availability truth and the incoming snapshot replaces them.
export function resetAgentAvailabilityVersionTracking(): void {
  lastAppliedVersion = -1;
}

export function resetAgentAvailabilityForTests(): void {
  resetAgentAvailabilityVersionTracking();
  lastAppliedSnapshots.clear();
}
