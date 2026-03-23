import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDetailHeader } from './AgentDetailHeader';

describe('AgentDetailHeader', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a compact terminal header with status and control actions', () => {
    const onTakeOver = vi.fn();

    render(() => (
      <AgentDetailHeader
        agentId="agent-1"
        agentStatus="running"
        connectionStatus="connected"
        contextLine="feature/remote-ui · projectm"
        lastActivityAt={Date.now() - 3_000}
        onBack={vi.fn()}
        onKill={vi.fn()}
        onTakeOver={onTakeOver}
        ownerIsSelf={false}
        ownerLabel="Ivan typing"
        ownershipNotice="Ivan typing."
        showTakeOver={true}
        statusFlashClass=""
        takeOverBusy={false}
        takeOverLabel="Take Over"
        taskName="Hydra Main Agent"
      />
    ));

    expect(screen.getAllByText('Hydra Main Agent').length).toBeGreaterThan(0);
    expect(screen.getByText('feature/remote-ui · projectm')).toBeDefined();
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.getAllByText('Ivan typing').length).toBeGreaterThan(0);
    expect(screen.queryByText('connected')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take Over' }));
    expect(onTakeOver).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Kill running agent' })).toBeDefined();
  });

  it('omits low-signal preview noise when context already explains the task', () => {
    render(() => (
      <AgentDetailHeader
        agentId="agent-2"
        agentStatus="restoring"
        connectionStatus="connected"
        contextLine="master (direct) · one-tool"
        lastActivityAt={null}
        onBack={vi.fn()}
        onKill={vi.fn()}
        onTakeOver={vi.fn()}
        ownerIsSelf={true}
        ownerLabel="You typing"
        ownershipNotice={null}
        showTakeOver={false}
        statusFlashClass=""
        takeOverBusy={false}
        takeOverLabel="Take Over"
        taskName="port33"
      />
    ));

    expect(screen.getByText('master (direct) · one-tool')).toBeDefined();
    expect(screen.queryByText('k')).toBeNull();
    expect(screen.queryByText('You typing')).toBeNull();
  });
});
