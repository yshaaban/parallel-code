import { afterEach, describe, expect, it, vi } from 'vitest';

const { getHydraRuntimeAvailabilityMock, isCommandAvailableMock } = vi.hoisted(() => ({
  getHydraRuntimeAvailabilityMock: vi.fn(),
  isCommandAvailableMock: vi.fn(),
}));

vi.mock('./command-resolver.js', () => ({
  isCommandAvailable: isCommandAvailableMock,
}));

vi.mock('./hydra-adapter.js', () => ({
  getHydraRuntimeAvailability: getHydraRuntimeAvailabilityMock,
}));

import {
  releaseBackendBackgroundWork,
  resetBackendWorkQueueForTests,
} from './backend-work-queue.js';
import { resetAgentAvailabilityStateForTests } from './agent-availability-state.js';
import {
  getAgentDefsWithLastKnownAvailability,
  listAgents,
  requestAgentCatalogAvailabilityRevalidation,
} from './agents.js';

async function flushAsyncWork(iterations = 10): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

async function runProbeRound(): Promise<void> {
  requestAgentCatalogAvailabilityRevalidation('settings-change');
  releaseBackendBackgroundWork();
  await flushAsyncWork();
}

describe('listAgents', () => {
  afterEach(() => {
    resetAgentAvailabilityStateForTests();
    resetBackendWorkQueueForTests();
    vi.useRealTimers();
    isCommandAvailableMock.mockReset();
    getHydraRuntimeAvailabilityMock.mockReset();
  });

  it('returns defensive copies of default skip-permission args', () => {
    const firstAgents = listAgents();
    firstAgents[0]?.skip_permissions_args.push('--mutated');
    firstAgents[1]?.args.push('--mutated');

    const secondAgents = listAgents();

    expect(secondAgents.find((agent) => agent.id === 'claude-code')?.skip_permissions_args).toEqual(
      ['--dangerously-skip-permissions'],
    );
    expect(secondAgents.find((agent) => agent.id === 'codex')?.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(secondAgents[0]?.skip_permissions_args).not.toBe(firstAgents[0]?.skip_permissions_args);
  });

  it('includes Antigravity as a CLI-args built-in agent', () => {
    const agents = listAgents();

    expect(agents.find((agent) => agent.id === 'antigravity')).toMatchObject({
      command: 'agy',
      resume_args: ['-c'],
      resume_strategy: 'cli-args',
      skip_permissions_args: ['--dangerously-skip-permissions'],
    });
  });

  it('returns synchronously with probing status before any probe completes', () => {
    isCommandAvailableMock.mockReturnValue(new Promise<boolean>(() => {}));
    getHydraRuntimeAvailabilityMock.mockReturnValue(new Promise(() => {}));

    const agents = listAgents();

    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((agent) => agent.availabilityStatus === 'probing')).toBe(true);
    expect(agents.every((agent) => agent.available === undefined)).toBe(true);
  });

  it('merges last-known sticky availability after a probe round completes', async () => {
    isCommandAvailableMock.mockImplementation(async (command: string) => command !== 'codex');
    getHydraRuntimeAvailabilityMock.mockResolvedValue({
      available: true,
      detail: 'Using hydra from PATH.',
      resolvedCommand: 'hydra',
      source: 'path',
    });

    await runProbeRound();

    const agents = listAgents();
    expect(agents.find((agent) => agent.id === 'codex')).toMatchObject({
      availabilityStatus: 'known',
      available: false,
      availabilitySource: 'unavailable',
    });
    expect(agents.find((agent) => agent.id === 'claude-code')).toMatchObject({
      availabilityStatus: 'known',
      available: true,
      availabilitySource: 'path',
    });
    expect(agents.find((agent) => agent.id === 'hydra')).toMatchObject({
      availabilityStatus: 'known',
      available: true,
      availabilityReason: 'Using hydra from PATH.',
    });
  });

  it('keeps unavailable results sticky on repeated reads instead of re-probing', async () => {
    isCommandAvailableMock.mockImplementation(async (command: string) => command !== 'codex');
    getHydraRuntimeAvailabilityMock.mockResolvedValue({
      available: true,
      detail: 'Using hydra from PATH.',
      resolvedCommand: 'hydra',
      source: 'path',
    });

    await runProbeRound();
    const probeCallsAfterRound = isCommandAvailableMock.mock.calls.length;

    isCommandAvailableMock.mockResolvedValue(true);
    for (let index = 0; index < 5; index += 1) {
      const agents = listAgents();
      expect(agents.find((agent) => agent.id === 'codex')?.available).toBe(false);
      expect(
        getAgentDefsWithLastKnownAvailability().find((agent) => agent.id === 'codex')?.available,
      ).toBe(false);
    }
    await flushAsyncWork();

    expect(isCommandAvailableMock.mock.calls.length).toBe(probeCallsAfterRound);
  });
});
