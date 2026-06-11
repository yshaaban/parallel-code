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
  getBackendWorkQueueDiagnostics,
  releaseBackendBackgroundWork,
  resetBackendWorkQueueForTests,
} from './backend-work-queue.js';
import {
  getAgentAvailabilitySnapshot,
  getAgentAvailabilityStateVersion,
  listAgentAvailabilitySnapshots,
  requestAgentAvailabilityRevalidation,
  resetAgentAvailabilityStateForTests,
  subscribeAgentAvailability,
  type AgentAvailabilityProbeTarget,
} from './agent-availability-state.js';

const TARGETS: AgentAvailabilityProbeTarget[] = [
  { agentId: 'claude-code', command: 'claude' },
  { agentId: 'codex', command: 'codex' },
];

async function flushAsyncWork(iterations = 10): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

describe('agent availability state', () => {
  afterEach(() => {
    resetAgentAvailabilityStateForTests();
    resetBackendWorkQueueForTests();
    vi.useRealTimers();
    isCommandAvailableMock.mockReset();
    getHydraRuntimeAvailabilityMock.mockReset();
  });

  it('marks agents known after the first probe round and keeps results sticky', async () => {
    isCommandAvailableMock.mockImplementation(async (command: string) => command !== 'codex');

    expect(getAgentAvailabilitySnapshot('codex')).toBeNull();
    requestAgentAvailabilityRevalidation({ reason: 'dialog-open', targets: TARGETS });
    await flushAsyncWork();

    expect(getAgentAvailabilitySnapshot('codex')).toMatchObject({
      available: false,
      availabilitySource: 'unavailable',
      status: 'known',
    });
    expect(getAgentAvailabilitySnapshot('claude-code')).toMatchObject({
      available: true,
      availabilitySource: 'path',
      status: 'known',
    });

    // Reads never probe: repeated snapshot reads add zero prober calls.
    const probeCalls = isCommandAvailableMock.mock.calls.length;
    listAgentAvailabilitySnapshots();
    getAgentAvailabilitySnapshot('codex');
    await flushAsyncWork();
    expect(isCommandAvailableMock.mock.calls.length).toBe(probeCalls);
  });

  it('throttles repeat revalidation but lets settings-change bypass the throttle', async () => {
    isCommandAvailableMock.mockResolvedValue(true);

    requestAgentAvailabilityRevalidation({ reason: 'dialog-open', targets: TARGETS });
    await flushAsyncWork();
    expect(isCommandAvailableMock).toHaveBeenCalledTimes(TARGETS.length);

    requestAgentAvailabilityRevalidation({ reason: 'dialog-open', targets: TARGETS });
    await flushAsyncWork();
    expect(isCommandAvailableMock).toHaveBeenCalledTimes(TARGETS.length);

    requestAgentAvailabilityRevalidation({ reason: 'settings-change', targets: TARGETS });
    await flushAsyncWork();
    expect(isCommandAvailableMock).toHaveBeenCalledTimes(TARGETS.length * 2);
  });

  it('bypasses the throttle when the probe target key changes', async () => {
    getHydraRuntimeAvailabilityMock.mockResolvedValue({
      available: true,
      detail: 'Using hydra from PATH.',
      resolvedCommand: 'hydra',
      source: 'path',
    });
    const hydraTargets: AgentAvailabilityProbeTarget[] = [
      { adapter: 'hydra', agentId: 'hydra', command: 'hydra' },
    ];

    requestAgentAvailabilityRevalidation({ reason: 'dialog-open', targets: hydraTargets });
    await flushAsyncWork();
    expect(getHydraRuntimeAvailabilityMock).toHaveBeenCalledTimes(1);

    requestAgentAvailabilityRevalidation({
      reason: 'dialog-open',
      targets: [{ adapter: 'hydra', agentId: 'hydra', command: '/custom/hydra' }],
    });
    await flushAsyncWork();
    expect(getHydraRuntimeAvailabilityMock).toHaveBeenCalledTimes(2);
    expect(getHydraRuntimeAvailabilityMock).toHaveBeenLastCalledWith('/custom/hydra', {
      resolveBareCommandPath: true,
    });
  });

  it('bumps the version and notifies subscribers only when results change', async () => {
    isCommandAvailableMock.mockResolvedValue(true);
    const listener = vi.fn();
    subscribeAgentAvailability(listener);

    requestAgentAvailabilityRevalidation({ reason: 'dialog-open', targets: TARGETS });
    await flushAsyncWork();
    const versionAfterFirstRound = getAgentAvailabilityStateVersion();
    expect(versionAfterFirstRound).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(1);
    // The pushed event carries the state version as the backend ordering
    // signal for renderer-side stale-event rejection.
    expect(listener).toHaveBeenCalledWith({
      snapshots: listAgentAvailabilitySnapshots(),
      version: versionAfterFirstRound,
    });

    requestAgentAvailabilityRevalidation({ reason: 'settings-change', targets: TARGETS });
    await flushAsyncWork();
    expect(getAgentAvailabilityStateVersion()).toBe(versionAfterFirstRound);
    expect(listener).toHaveBeenCalledTimes(1);

    isCommandAvailableMock.mockResolvedValue(false);
    requestAgentAvailabilityRevalidation({ reason: 'settings-change', targets: TARGETS });
    await flushAsyncWork();
    expect(getAgentAvailabilityStateVersion()).toBeGreaterThan(versionAfterFirstRound);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('gates boot probes behind releaseBackendBackgroundWork and escalates on dialog-open', async () => {
    isCommandAvailableMock.mockResolvedValue(true);

    requestAgentAvailabilityRevalidation({ reason: 'boot', targets: TARGETS });
    await flushAsyncWork();
    expect(isCommandAvailableMock).not.toHaveBeenCalled();
    expect(getBackendWorkQueueDiagnostics().pendingByClass.background).toBe(1);

    // A dialog-open request escalates the same pending job to interactive
    // instead of registering a second scheduler.
    requestAgentAvailabilityRevalidation({ reason: 'dialog-open', targets: TARGETS });
    await flushAsyncWork();
    expect(isCommandAvailableMock).toHaveBeenCalledTimes(TARGETS.length);
    expect(getAgentAvailabilitySnapshot('codex')?.status).toBe('known');
  });

  it('runs gated boot probes once background work is released', async () => {
    isCommandAvailableMock.mockResolvedValue(true);

    requestAgentAvailabilityRevalidation({ reason: 'boot', targets: TARGETS });
    await flushAsyncWork();
    expect(isCommandAvailableMock).not.toHaveBeenCalled();

    releaseBackendBackgroundWork();
    await flushAsyncWork();
    expect(isCommandAvailableMock).toHaveBeenCalledTimes(TARGETS.length);
  });

  it('swallows per-target probe failures and keeps prior sticky results', async () => {
    isCommandAvailableMock.mockResolvedValue(true);
    requestAgentAvailabilityRevalidation({ reason: 'dialog-open', targets: TARGETS });
    await flushAsyncWork();
    expect(getAgentAvailabilitySnapshot('codex')?.available).toBe(true);

    isCommandAvailableMock.mockRejectedValue(new Error('prober exploded'));
    requestAgentAvailabilityRevalidation({ reason: 'settings-change', targets: TARGETS });
    await flushAsyncWork();
    expect(getAgentAvailabilitySnapshot('codex')?.available).toBe(true);
  });
});
