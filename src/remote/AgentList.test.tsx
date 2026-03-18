import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteAgent } from '../../electron/remote/protocol';

const remoteState = vi.hoisted(() => ({
  activity: {} as Record<string, number>,
  agents: [] as RemoteAgent[],
  previews: {} as Record<string, string>,
  status: 'connected' as 'connected' | 'connecting' | 'disconnected' | 'reconnecting',
}));

vi.mock('./ws', () => ({
  agents: () => remoteState.agents,
  getAgentLastActivityAt: (agentId: string) => remoteState.activity[agentId] ?? null,
  getAgentPreview: (agentId: string) => remoteState.previews[agentId] ?? '',
  status: () => remoteState.status,
}));

import { AgentList } from './AgentList';

describe('AgentList', () => {
  beforeEach(() => {
    remoteState.activity = {};
    remoteState.agents = [];
    remoteState.previews = {};
    remoteState.status = 'connected';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders richer live cards with preview, activity timing, and session naming controls', () => {
    remoteState.agents = [
      {
        agentId: 'agent-1234567890',
        exitCode: null,
        lastLine: 'tail -f server.log',
        status: 'running',
        taskId: 'task-1',
        taskName: 'Hydra Build Watcher',
      },
    ];
    remoteState.previews = {
      'agent-1234567890': 'watching for file changes and streaming compile output',
    };
    remoteState.activity = {
      'agent-1234567890': Date.now() - 4_000,
    };

    const onEditSessionName = vi.fn();
    render(() => (
      <AgentList
        onEditSessionName={onEditSessionName}
        onSelect={vi.fn()}
        sessionName="Mobile 1234"
      />
    ));

    expect(screen.getByText('Live agents on your phone')).toBeDefined();
    expect(screen.getByText('Keep important work within thumb reach')).toBeDefined();
    expect(screen.getByText('Session name')).toBeDefined();
    expect(screen.getByText('Mobile 1234')).toBeDefined();
    expect(screen.getByText('Hydra Build Watcher')).toBeDefined();
    expect(
      screen.getByText('watching for file changes and streaming compile output'),
    ).toBeDefined();
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.getByText('Live now')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Edit mobile session name' }));
    expect(onEditSessionName).toHaveBeenCalledTimes(1);
  });

  it('shows the richer connected empty state', () => {
    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Mobile 1234" />
    ));

    expect(screen.getByText('Your live agent inbox is ready')).toBeDefined();
    expect(screen.getByText(/Watch live terminal output without opening a laptop\./)).toBeDefined();
    expect(
      screen.getByText(/Send terminal input, navigation keys, and kill signals from your phone\./),
    ).toBeDefined();
  });
});
