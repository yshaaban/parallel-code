import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteAgent } from '../../electron/remote/protocol';
import type { AgentSupervisionSnapshot, TaskPortSnapshot } from '../domain/server-state';
import type { TaskCommandOwnerStatus } from '../domain/task-command-owner-status';
import type { TaskReviewSnapshot } from '../domain/task-review';

const remoteState = vi.hoisted(() => ({
  agents: [] as RemoteAgent[],
  controllerOwnerStatusByTaskId: {} as Record<string, TaskCommandOwnerStatus | null>,
  presenceOwnerStatusByTaskId: {} as Record<string, TaskCommandOwnerStatus | null>,
  previews: {} as Record<string, string>,
  status: 'connected' as 'connected' | 'connecting' | 'disconnected' | 'reconnecting',
  supervisionByAgentId: {} as Record<string, AgentSupervisionSnapshot>,
  taskPortsByTaskId: {} as Record<string, TaskPortSnapshot>,
  taskReviewByTaskId: {} as Record<string, TaskReviewSnapshot>,
}));

vi.mock('./ws', () => ({
  agents: () => remoteState.agents,
  getAgentPreview: (agentId: string) => remoteState.previews[agentId] ?? '',
  status: () => remoteState.status,
}));

vi.mock('./remote-collaboration', () => ({
  getRemoteTaskControllerOwnerStatus: (taskId: string) =>
    remoteState.controllerOwnerStatusByTaskId[taskId] ?? null,
  getRemoteTaskPresenceOwnerStatus: (taskId: string) =>
    remoteState.presenceOwnerStatusByTaskId[taskId] ?? null,
}));

vi.mock('./remote-task-state', () => ({
  getRemoteAgentSupervision: (agentId: string) => remoteState.supervisionByAgentId[agentId] ?? null,
  getRemoteTaskPorts: (taskId: string) => remoteState.taskPortsByTaskId[taskId] ?? null,
  getRemoteTaskReview: (taskId: string) => remoteState.taskReviewByTaskId[taskId] ?? null,
}));

import { AgentList } from './AgentList';

describe('AgentList', () => {
  beforeEach(() => {
    remoteState.agents = [];
    remoteState.controllerOwnerStatusByTaskId = {};
    remoteState.presenceOwnerStatusByTaskId = {};
    remoteState.previews = {};
    remoteState.status = 'connected';
    remoteState.supervisionByAgentId = {};
    remoteState.taskPortsByTaskId = {};
    remoteState.taskReviewByTaskId = {};
  });

  afterEach(() => {
    cleanup();
  });

  it('renders actionable summaries from canonical remote state instead of recency fluff', () => {
    remoteState.agents = [
      {
        agentId: 'agent-1',
        exitCode: null,
        lastLine: '',
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
    remoteState.supervisionByAgentId['agent-1'] = {
      agentId: 'agent-1',
      attentionReason: 'waiting-input',
      isShell: false,
      lastOutputAt: 10,
      preview: 'Need your next instruction',
      state: 'awaiting-input',
      taskId: 'task-1',
      updatedAt: 20,
    };
    remoteState.taskReviewByTaskId['task-1'] = {
      branchName: 'feature/auth',
      files: [
        { committed: false, lines_added: 3, lines_removed: 1, path: 'src/one.ts', status: 'M' },
        { committed: false, lines_added: 0, lines_removed: 0, path: 'src/two.ts', status: 'U' },
        { committed: true, lines_added: 5, lines_removed: 0, path: 'src/three.ts', status: 'A' },
      ],
      projectId: 'project-1',
      revisionId: 'rev-1',
      source: 'branch-fallback',
      taskId: 'task-1',
      totalAdded: 8,
      totalRemoved: 1,
      updatedAt: 30,
      worktreePath: '/tmp/task-1',
    };
    remoteState.taskPortsByTaskId['task-1'] = {
      exposed: [
        {
          availability: 'available',
          host: '127.0.0.1',
          label: 'Preview',
          lastVerifiedAt: 40,
          port: 3000,
          protocol: 'http',
          source: 'manual',
          statusMessage: null,
          updatedAt: 40,
          verifiedHost: '127.0.0.1',
        },
      ],
      observed: [],
      taskId: 'task-1',
      updatedAt: 40,
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
    expect(screen.getAllByText('feature/auth \u00B7 my-project').length).toBeGreaterThan(0);
    expect(screen.getByText('Waiting')).toBeDefined();
    expect(screen.getByText('Branch diff')).toBeDefined();
    expect(screen.getByText('1 conflict')).toBeDefined();
    expect(screen.getByText('3 files')).toBeDefined();
    expect(screen.getByText('Port 3000')).toBeDefined();
    expect(screen.getByText('Need your next instruction')).toBeDefined();
    expect(screen.getAllByRole('img', { name: 'Hydra CLI agent' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Hydra CLI')).toBeNull();
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.queryByText('Now')).toBeNull();
    expect(screen.getByText('1 agent')).toBeDefined();
    expect(screen.getByText('1 waiting agent')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Edit mobile session name' }));
    expect(onEditSessionName).toHaveBeenCalledTimes(1);
  });

  it('sorts waiting tasks ahead of busy work', () => {
    remoteState.agents = [
      {
        agentId: 'agent-busy',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-busy',
        taskName: 'Busy Task',
      },
      {
        agentId: 'agent-ready',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-ready',
        taskName: 'Ready Task',
      },
    ];
    remoteState.supervisionByAgentId['agent-busy'] = {
      agentId: 'agent-busy',
      attentionReason: null,
      isShell: false,
      lastOutputAt: 10,
      preview: 'Building',
      state: 'active',
      taskId: 'task-busy',
      updatedAt: 20,
    };
    remoteState.supervisionByAgentId['agent-ready'] = {
      agentId: 'agent-ready',
      attentionReason: 'waiting-input',
      isShell: false,
      lastOutputAt: 10,
      preview: 'Continue?',
      state: 'awaiting-input',
      taskId: 'task-ready',
      updatedAt: 20,
    };

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    const readyCard = screen.getByRole('button', { name: /Open Ready Task/u });
    const busyCard = screen.getByRole('button', { name: /Open Busy Task/u });

    expect(readyCard.compareDocumentPosition(busyCard) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(screen.getByText('1 waiting agent')).toBeDefined();
    expect(screen.getByText('1 busy agent')).toBeDefined();
  });

  it('surfaces quiet tasks separately instead of collapsing them into busy work', () => {
    remoteState.agents = [
      {
        agentId: 'agent-busy',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-busy',
        taskName: 'Busy Task',
      },
      {
        agentId: 'agent-quiet',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-quiet',
        taskName: 'Quiet Task',
      },
    ];
    remoteState.supervisionByAgentId['agent-busy'] = {
      agentId: 'agent-busy',
      attentionReason: null,
      isShell: false,
      lastOutputAt: 10,
      preview: 'Working',
      state: 'active',
      taskId: 'task-busy',
      updatedAt: 20,
    };
    remoteState.supervisionByAgentId['agent-quiet'] = {
      agentId: 'agent-quiet',
      attentionReason: 'quiet-too-long',
      isShell: false,
      lastOutputAt: 10,
      preview: 'Still waiting on a follow-up',
      state: 'quiet',
      taskId: 'task-quiet',
      updatedAt: 20,
    };

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('Quiet')).toBeDefined();
    expect(screen.getByText('1 quiet agent')).toBeDefined();
    expect(screen.getByText('1 busy agent')).toBeDefined();

    const quietCard = screen.getByRole('button', { name: /Open Quiet Task/u });
    const busyCard = screen.getByRole('button', { name: /Open Busy Task/u });
    expect(quietCard.compareDocumentPosition(busyCard) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
  });

  it('shows blocked ownership when another session controls a task', () => {
    remoteState.agents = [
      {
        agentId: 'agent-owned',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-owned',
        taskName: 'Shared Task',
      },
    ];
    remoteState.controllerOwnerStatusByTaskId['task-owned'] = {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    };

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('Ivan typing')).toBeDefined();
    expect(screen.getByText('1 blocked agent')).toBeDefined();
    expect(screen.queryByText('You typing')).toBeNull();
  });

  it('keeps presence-only ownership as a soft cue instead of a blocked state', () => {
    remoteState.agents = [
      {
        agentId: 'agent-presence',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-presence',
        taskName: 'Presence Task',
      },
    ];
    remoteState.presenceOwnerStatusByTaskId['task-presence'] = {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    };

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('Presence: Ivan typing')).toBeDefined();
    expect(screen.queryByText('1 blocked agent')).toBeNull();
    expect(screen.queryByText(/^Ivan typing$/u)).toBeNull();
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

    expect(screen.getAllByText('Direct \u00B7 my-project').length).toBeGreaterThan(0);
  });

  it('uses a meaningful last prompt as compact secondary context when branch metadata is unavailable', () => {
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

    expect(screen.getAllByText('review the failing build').length).toBeGreaterThan(0);
  });

  it('omits junk prompt text when it does not add useful task signal', () => {
    remoteState.agents = [
      {
        agentId: 'agent-noise',
        exitCode: null,
        lastLine: '',
        status: 'running',
        taskId: 'task-noise',
        taskName: 'test444',
        taskMeta: {
          agentDefId: 'codex',
          agentDefName: 'Codex CLI',
          branchName: 'master',
          directMode: true,
          folderName: 'one-tool',
          lastPrompt: 'klkkkkkkkkkkkkkkkkkkkkkkkk',
        },
      },
    ];

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.queryByText(/klkkkk/u)).toBeNull();
  });

  it('omits redundant fallback preview text when the list already has useful task context', () => {
    remoteState.agents = [
      {
        agentId: 'agent-restoring',
        exitCode: null,
        lastLine: '',
        status: 'restoring',
        taskId: 'task-restoring',
        taskName: 'port33',
        taskMeta: {
          agentDefId: 'codex',
          agentDefName: 'Codex CLI',
          branchName: 'master',
          directMode: true,
          folderName: 'one-tool',
          lastPrompt: null,
        },
      },
    ];

    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Session" />
    ));

    expect(screen.getByText('master (direct) \u00B7 one-tool')).toBeDefined();
    expect(screen.queryByText('Restoring the terminal view')).toBeNull();
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

  it('shows a minimal connected empty state', () => {
    render(() => (
      <AgentList onEditSessionName={vi.fn()} onSelect={vi.fn()} sessionName="Mobile 1234" />
    ));

    expect(screen.getByText('No active agents')).toBeDefined();
    expect(screen.getByText('Start an agent on desktop to control it here.')).toBeDefined();
  });
});
