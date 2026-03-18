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

  it('renders compact header with session name and agent cards with metadata', () => {
    remoteState.agents = [
      {
        agentId: 'agent-1234567890',
        exitCode: null,
        lastLine: 'tail -f server.log',
        status: 'running',
        taskId: 'task-1',
        taskName: 'Hydra Build Watcher',
        taskMeta: {
          agentDefId: 'hydra',
          agentDefName: 'Hydra CLI',
          branchName: 'feature/auth',
          directMode: false,
          folderName: 'my-project',
          lastPrompt: 'watch the build output',
        },
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

    expect(screen.getByText('Mobile 1234')).toBeDefined();
    expect(screen.getByText('Hydra Build Watcher')).toBeDefined();
    expect(
      screen.getByText('watching for file changes and streaming compile output'),
    ).toBeDefined();
    expect(screen.getByText('Live')).toBeDefined();
    expect(screen.getByText('Live now')).toBeDefined();
    expect(screen.getByText('feature/auth \u00B7 my-project')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Edit mobile session name' }));
    expect(onEditSessionName).toHaveBeenCalledTimes(1);
  });

  it('shows a minimal connected empty state', () => {
    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Mobile 1234" />
    ));

    expect(screen.getByText('No active agents')).toBeDefined();
    expect(screen.getByText('Start an agent from the desktop app to see it here.')).toBeDefined();
  });

  it('keeps direct mode visible when only folder metadata is available', () => {
    remoteState.agents = [
      {
        agentId: 'agent-direct',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-direct',
        taskName: 'Direct Task',
        taskMeta: {
          agentDefId: 'codex',
          agentDefName: 'Codex CLI',
          branchName: null,
          directMode: true,
          folderName: 'my-project',
          lastPrompt: null,
        },
      },
    ];

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('Direct · my-project')).toBeDefined();
  });

  it('uses the last prompt as compact secondary context when branch metadata is unavailable', () => {
    remoteState.agents = [
      {
        agentId: 'agent-prompt',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-3',
        taskName: 'Prompted Task',
        taskMeta: {
          agentDefId: 'codex',
          agentDefName: 'Codex CLI',
          branchName: null,
          directMode: false,
          folderName: null,
          lastPrompt: 'review the failing build',
        },
      },
    ];

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('Prompt: review the failing build')).toBeDefined();
  });

  it('renders cards without metadata gracefully', () => {
    remoteState.agents = [
      {
        agentId: 'agent-abc',
        exitCode: null,
        lastLine: 'npm test',
        status: 'paused',
        taskId: 'task-2',
        taskName: 'Test Runner',
      },
    ];

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('Test Runner')).toBeDefined();
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
  });

  it('displays running/total count in header', () => {
    remoteState.agents = [
      {
        agentId: 'a1',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 't1',
        taskName: 'Task A',
      },
      {
        agentId: 'a2',
        exitCode: 0,
        lastLine: '',
        status: 'exited',
        taskId: 't2',
        taskName: 'Task B',
      },
    ];

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('1/2')).toBeDefined();
  });
});
