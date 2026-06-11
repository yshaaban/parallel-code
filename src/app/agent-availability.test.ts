import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentDef } from '../ipc/types';
import { setStore, store } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';
import {
  applyAgentAvailabilityEvent,
  applyAgentAvailabilitySnapshots,
  applyKnownAgentAvailability,
  resetAgentAvailabilityForTests,
} from './agent-availability';

function createAgentDef(id: string): AgentDef {
  return {
    args: [],
    command: id,
    description: `${id} agent`,
    id,
    name: id,
    resume_args: [],
    skip_permissions_args: [],
  };
}

describe('agent availability applier', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetAgentAvailabilityForTests();
    setStore('availableAgents', [createAgentDef('claude-code'), createAgentDef('codex')]);
  });

  afterEach(() => {
    resetAgentAvailabilityForTests();
  });

  it('merges availability into store agents by id', () => {
    applyAgentAvailabilitySnapshots(
      [
        {
          agentId: 'codex',
          available: false,
          availabilityReason: "Command 'codex' was not found on PATH.",
          availabilitySource: 'unavailable',
          probedAt: 1_000,
          status: 'known',
        },
      ],
      1,
    );

    expect(store.availableAgents.find((agent) => agent.id === 'codex')).toMatchObject({
      availabilityStatus: 'known',
      available: false,
      availabilitySource: 'unavailable',
    });
    expect(store.availableAgents.find((agent) => agent.id === 'claude-code')?.available).toBe(
      undefined,
    );
  });

  it('ignores stale versions at the projection boundary', () => {
    applyAgentAvailabilitySnapshots(
      [{ agentId: 'codex', available: true, probedAt: 2_000, status: 'known' }],
      5,
    );
    applyAgentAvailabilitySnapshots(
      [{ agentId: 'codex', available: false, probedAt: 1_000, status: 'known' }],
      4,
    );

    expect(store.availableAgents.find((agent) => agent.id === 'codex')?.available).toBe(true);
  });

  it('keeps applied availability when the agent catalog is re-merged', () => {
    applyAgentAvailabilitySnapshots(
      [{ agentId: 'codex', available: false, probedAt: 1_000, status: 'known' }],
      2,
    );

    const remerged = applyKnownAgentAvailability([
      createAgentDef('claude-code'),
      createAgentDef('codex'),
    ]);

    expect(remerged.find((agent) => agent.id === 'codex')).toMatchObject({
      availabilityStatus: 'known',
      available: false,
    });
    expect(remerged.find((agent) => agent.id === 'claude-code')?.availabilityStatus).toBe(
      undefined,
    );
  });

  it('applies live events as a probing-to-known transition over the same merge', () => {
    setStore('availableAgents', [{ ...createAgentDef('codex'), availabilityStatus: 'probing' }]);

    applyAgentAvailabilityEvent({
      snapshots: [
        {
          agentId: 'codex',
          available: true,
          availabilityReason: 'Using codex from PATH.',
          availabilitySource: 'path',
          probedAt: 3_000,
          status: 'known',
        },
      ],
      version: 1,
    });

    expect(store.availableAgents.find((agent) => agent.id === 'codex')).toMatchObject({
      availabilityStatus: 'known',
      available: true,
      availabilityReason: 'Using codex from PATH.',
    });
  });

  it('ignores a stale live event that predates the applied bootstrap snapshot version', () => {
    // Startup buffering replays pushed events after the bootstrap snapshot
    // applies; the event version is the backend ordering signal that keeps a
    // pre-snapshot event from overwriting newer snapshot truth.
    applyAgentAvailabilitySnapshots(
      [{ agentId: 'codex', available: true, probedAt: 5_000, status: 'known' }],
      6,
    );

    applyAgentAvailabilityEvent({
      snapshots: [{ agentId: 'codex', available: false, probedAt: 1_000, status: 'known' }],
      version: 3,
    });

    expect(store.availableAgents.find((agent) => agent.id === 'codex')?.available).toBe(true);

    applyAgentAvailabilityEvent({
      snapshots: [{ agentId: 'codex', available: false, probedAt: 9_000, status: 'known' }],
      version: 7,
    });

    expect(store.availableAgents.find((agent) => agent.id === 'codex')?.available).toBe(false);
  });
});
