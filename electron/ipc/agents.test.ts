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

import { listAgents } from './agents.js';

describe('listAgents', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns defensive copies of default skip-permission args', async () => {
    isCommandAvailableMock.mockResolvedValue(true);
    getHydraRuntimeAvailabilityMock.mockResolvedValue({
      available: true,
      detail: 'Using hydra from PATH.',
      source: 'path',
    });

    const firstAgents = await listAgents();
    firstAgents[0]?.skip_permissions_args.push('--mutated');
    firstAgents[1]?.args.push('--mutated');

    const secondAgents = await listAgents();

    expect(secondAgents.find((agent) => agent.id === 'claude-code')?.skip_permissions_args).toEqual(
      ['--dangerously-skip-permissions'],
    );
    expect(secondAgents.find((agent) => agent.id === 'codex')?.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    expect(secondAgents[0]?.skip_permissions_args).not.toBe(firstAgents[0]?.skip_permissions_args);
  });

  it('includes Antigravity as a CLI-args built-in agent', async () => {
    isCommandAvailableMock.mockResolvedValue(true);
    getHydraRuntimeAvailabilityMock.mockResolvedValue({
      available: true,
      detail: 'Using hydra from PATH.',
      source: 'path',
    });

    const agents = await listAgents('antigravity-catalog-test');

    expect(agents.find((agent) => agent.id === 'antigravity')).toMatchObject({
      available: true,
      command: 'agy',
      resume_args: ['-c'],
      resume_strategy: 'cli-args',
      skip_permissions_args: ['--dangerously-skip-permissions'],
    });
    expect(isCommandAvailableMock).toHaveBeenCalledWith('agy');
  });

  it('briefly caches unavailable agents before rechecking newly installed CLIs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    isCommandAvailableMock.mockClear();
    getHydraRuntimeAvailabilityMock.mockClear();
    isCommandAvailableMock.mockImplementation(async (command: string) => command !== 'codex');
    getHydraRuntimeAvailabilityMock.mockResolvedValue({
      available: true,
      detail: 'Using hydra from PATH.',
      source: 'path',
    });

    const firstAgents = await listAgents('hydra-cache-test');

    expect(firstAgents.find((agent) => agent.id === 'codex')?.available).toBe(false);

    isCommandAvailableMock.mockResolvedValue(true);
    const secondAgents = await listAgents('hydra-cache-test');

    expect(secondAgents.find((agent) => agent.id === 'codex')?.available).toBe(false);
    expect(
      isCommandAvailableMock.mock.calls.filter(([command]) => command === 'codex'),
    ).toHaveLength(1);

    vi.setSystemTime(5_001);
    const thirdAgents = await listAgents('hydra-cache-test');

    expect(thirdAgents.find((agent) => agent.id === 'codex')?.available).toBe(true);
    expect(isCommandAvailableMock).toHaveBeenCalledWith('codex');
    expect(
      isCommandAvailableMock.mock.calls.filter(([command]) => command === 'codex'),
    ).toHaveLength(2);
  });

  it('keeps fully available agent catalogs cached longer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    isCommandAvailableMock.mockClear();
    getHydraRuntimeAvailabilityMock.mockClear();
    isCommandAvailableMock.mockResolvedValue(true);
    getHydraRuntimeAvailabilityMock.mockResolvedValue({
      available: true,
      detail: 'Using hydra from PATH.',
      source: 'path',
    });

    await listAgents('available-cache-test');
    vi.setSystemTime(5_001);
    const secondAgents = await listAgents('available-cache-test');

    expect(secondAgents.find((agent) => agent.id === 'codex')?.available).toBe(true);
    expect(isCommandAvailableMock).toHaveBeenCalledWith('codex');
    expect(
      isCommandAvailableMock.mock.calls.filter(([command]) => command === 'codex'),
    ).toHaveLength(1);
  });
});
