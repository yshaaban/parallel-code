import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDetailHeader } from './AgentDetailHeader';

describe('AgentDetailHeader', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders status, connection, ownership, and preview summary together', () => {
    const onTakeOver = vi.fn();

    render(() => (
      <AgentDetailHeader
        agentStatus="running"
        connectionStatus="connected"
        lastActivityAt={Date.now() - 3_000}
        onBack={vi.fn()}
        onKill={vi.fn()}
        onTakeOver={onTakeOver}
        ownerIsSelf={false}
        ownerLabel="Ivan typing"
        ownershipNotice="Ivan typing. Take over to type here."
        preview="Hydra is waiting at a prompt after the latest compile finished."
        showTakeOver={true}
        statusFlashClass=""
        takeOverBusy={false}
        takeOverLabel="Take Over"
        taskName="Hydra Main Agent"
      />
    ));

    expect(screen.getAllByText('Hydra Main Agent')).toHaveLength(2);
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.getByText('Connected')).toBeDefined();
    expect(screen.getByText('Ivan typing')).toBeDefined();
    expect(
      screen.getByText('Hydra is waiting at a prompt after the latest compile finished.'),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Take Over' }));
    expect(onTakeOver).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Kill running agent' })).toBeDefined();
  });
});
