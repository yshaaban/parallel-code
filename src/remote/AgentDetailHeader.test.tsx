import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDetailHeader } from './AgentDetailHeader';

describe('AgentDetailHeader', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders status, connection, and preview summary together', () => {
    render(() => (
      <AgentDetailHeader
        agentStatus="running"
        connectionStatus="connected"
        lastActivityAt={Date.now() - 3_000}
        onBack={vi.fn()}
        onKill={vi.fn()}
        preview="Hydra is waiting at a prompt after the latest compile finished."
        statusFlashClass=""
        taskName="Hydra Main Agent"
      />
    ));

    expect(screen.getAllByText('Hydra Main Agent')).toHaveLength(2);
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.getByText('Connected')).toBeDefined();
    expect(
      screen.getByText('Hydra is waiting at a prompt after the latest compile finished.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Kill running agent' })).toBeDefined();
  });
});
