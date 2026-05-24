import { describe, expect, it, vi } from 'vitest';

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
});
