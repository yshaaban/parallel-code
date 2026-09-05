import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import type { TaskCommandTakeoverRequestMessage } from '../../electron/remote/protocol';
import type { RemoteTaskSessionRef } from '../domain/task-catalog';
import { REMOTE_TASK_CREATION_CAPABILITY_DARK } from '../domain/task-creation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  clearIncomingRemoteTakeoverRequestMock,
  connectMock,
  createRemotePresenceRuntimeMock,
  getDefaultRemoteSessionNameMock,
  getIncomingRemoteTakeoverRequestsMock,
  getRemoteControllingTaskIdsMock,
  getStoredDisplayNameMock,
  applyRemoteTaskNotesCatalogLifecycleMock,
  hasUnsavedRemoteTaskNotesMock,
  respondToRemoteTaskCommandTakeoverMock,
  setStoredDisplayNameMock,
} = vi.hoisted(() => ({
  clearIncomingRemoteTakeoverRequestMock: vi.fn(),
  connectMock: vi.fn(),
  createRemotePresenceRuntimeMock: vi.fn(),
  getDefaultRemoteSessionNameMock: vi.fn(() => 'Mobile 1234'),
  getIncomingRemoteTakeoverRequestsMock: vi.fn<() => TaskCommandTakeoverRequestMessage[]>(() => []),
  getRemoteControllingTaskIdsMock: vi.fn(() => []),
  getStoredDisplayNameMock: vi.fn<() => string | null>(() => null),
  applyRemoteTaskNotesCatalogLifecycleMock: vi.fn(),
  hasUnsavedRemoteTaskNotesMock: vi.fn((_taskId?: string) => false),
  respondToRemoteTaskCommandTakeoverMock: vi.fn(async () => true),
  setStoredDisplayNameMock: vi.fn((value: string) => value.trim()),
}));

vi.mock('../lib/display-name', () => ({
  getStoredDisplayName: getStoredDisplayNameMock,
  setStoredDisplayName: setStoredDisplayNameMock,
}));

vi.mock('./remote-presence', () => ({
  createRemotePresenceRuntime: createRemotePresenceRuntimeMock,
  getDefaultRemoteSessionName: getDefaultRemoteSessionNameMock,
}));

vi.mock('./remote-collaboration', () => ({
  clearIncomingRemoteTakeoverRequest: clearIncomingRemoteTakeoverRequestMock,
  getIncomingRemoteTakeoverRequests: getIncomingRemoteTakeoverRequestsMock,
  getRemoteControllingTaskIds: getRemoteControllingTaskIdsMock,
}));

vi.mock('./remote-task-command', () => ({
  respondToRemoteTaskCommandTakeover: respondToRemoteTaskCommandTakeoverMock,
}));

vi.mock('./task-notes-lifecycle-channel', () => ({
  reconcileRemoteTaskNotesCatalogLifecycle: (taskId: string, lifecycle: unknown): boolean => {
    applyRemoteTaskNotesCatalogLifecycleMock(taskId, lifecycle);
    return hasUnsavedRemoteTaskNotesMock(taskId);
  },
}));

vi.mock('./auth', () => ({
  remoteSessionAllows: vi.fn(() => true),
}));

vi.mock('./ws', () => ({
  agents: () => [],
  authRequired: () => false,
  connect: connectMock,
  getRemoteClientId: () => 'remote-client-1234',
  status: () => 'connected',
}));

vi.mock('./AgentList', () => ({
  AgentList: (props: { onEditSessionName: () => void; sessionName: string }) => (
    <div>
      <span>{props.sessionName}</span>
      <button type="button" onClick={() => props.onEditSessionName()}>
        Rename session
      </button>
    </div>
  ),
}));

vi.mock('./AgentDetail', () => ({
  AgentDetail: (props: { agentId: string; taskSession?: RemoteTaskSessionRef }) => (
    <div>
      Agent detail {props.agentId} {props.taskSession?.kind}
    </div>
  ),
}));

import { App } from './App';

describe('remote App session naming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStoredDisplayNameMock.mockReturnValue(null);
    getIncomingRemoteTakeoverRequestsMock.mockReturnValue([]);
    hasUnsavedRemoteTaskNotesMock.mockReturnValue(false);
    setStoredDisplayNameMock.mockImplementation((value: string) => value.trim());
    respondToRemoteTaskCommandTakeoverMock.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('prompts for a mobile session name on first launch and saves it', () => {
    render(() => <App />);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Name this mobile session' })).toBeDefined();

    const input = screen.getByLabelText('Session name') as HTMLInputElement;
    expect(input.value).toBe('Mobile 1234');

    fireEvent.input(input, { target: { value: 'Ivan phone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(setStoredDisplayNameMock).toHaveBeenCalledWith('Ivan phone');
    expect(screen.queryByRole('dialog', { name: 'Name this mobile session' })).toBeNull();
    expect(screen.getByText('Ivan phone')).toBeDefined();
  });

  it('skips the prompt when a stored display name already exists', () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');

    render(() => <App />);

    expect(screen.queryByRole('dialog', { name: 'Name this mobile session' })).toBeNull();
    expect(screen.getByText('Already Named')).toBeDefined();
  });

  it('keeps takeover actions disabled until the matching request is cleared', async () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');
    getIncomingRemoteTakeoverRequestsMock.mockReturnValue([
      {
        action: 'type in the terminal',
        expiresAt: Date.now() + 10_000,
        requestId: 'request-1',
        requesterClientId: 'desktop-observer',
        requesterDisplayName: 'Desktop Observer',
        taskId: 'task-1',
        type: 'task-command-takeover-request',
      },
    ]);

    render(() => <App />);

    const allowButton = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement;
    fireEvent.click(allowButton);

    await waitFor(() => {
      expect(respondToRemoteTaskCommandTakeoverMock).toHaveBeenCalledWith('request-1', true);
      expect(allowButton.disabled).toBe(true);
    });
  });

  it('re-enables takeover actions when the response cannot be sent', async () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');
    respondToRemoteTaskCommandTakeoverMock.mockResolvedValueOnce(false);
    getIncomingRemoteTakeoverRequestsMock.mockReturnValue([
      {
        action: 'type in the terminal',
        expiresAt: Date.now() + 10_000,
        requestId: 'request-1',
        requesterClientId: 'desktop-observer',
        requesterDisplayName: 'Desktop Observer',
        taskId: 'task-1',
        type: 'task-command-takeover-request',
      },
    ]);

    render(() => <App />);

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => {
      expect(respondToRemoteTaskCommandTakeoverMock).toHaveBeenCalledWith('request-1', true);
    });
    await waitFor(() => {
      const allowButton = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement;
      expect(allowButton.disabled).toBe(false);
    });
  });

  it('renders the full queued takeover request list and responds per request', async () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');
    getIncomingRemoteTakeoverRequestsMock.mockReturnValue([
      {
        action: 'type in the terminal',
        expiresAt: Date.now() + 10_000,
        requestId: 'request-1',
        requesterClientId: 'desktop-observer',
        requesterDisplayName: 'Desktop Observer',
        taskId: 'task-1',
        type: 'task-command-takeover-request',
      },
      {
        action: 'approve the patch',
        expiresAt: Date.now() + 15_000,
        requestId: 'request-2',
        requesterClientId: 'desktop-reviewer',
        requesterDisplayName: 'Desktop Reviewer',
        taskId: 'task-2',
        type: 'task-command-takeover-request',
      },
    ]);

    render(() => <App />);

    expect(screen.getByText('2 takeover requests pending')).toBeDefined();

    const firstCard = document.querySelector('[data-request-id="request-1"]');
    const secondCard = document.querySelector('[data-request-id="request-2"]');
    expect(firstCard).toBeTruthy();
    expect(secondCard).toBeTruthy();
    if (!firstCard || !secondCard) {
      return;
    }

    expect(within(firstCard as HTMLElement).getByText(/Desktop Observer/)).toBeDefined();
    expect(within(secondCard as HTMLElement).getByText(/Desktop Reviewer/)).toBeDefined();

    fireEvent.click(within(secondCard as HTMLElement).getByRole('button', { name: 'Allow' }));

    await waitFor(() => {
      expect(respondToRemoteTaskCommandTakeoverMock).toHaveBeenCalledWith('request-2', true);
      expect(
        within(secondCard as HTMLElement).getAllByRole('button', { name: 'Sending…' }).length,
      ).toBe(2);
    });
  });

  it('opens a catalog shell by its session id without an agent-list entry', async () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');
    const shellSession: RemoteTaskSessionRef = {
      generation: 1,
      kind: 'shell',
      orderKey: '0001',
      sessionId: 'shell-session-1',
      state: 'running',
      taskId: 'task-1',
    };
    const snapshot = {
      projection: {
        agents: new Map(),
        catalogVersion: 1,
        projects: new Map([
          [
            'project-1',
            {
              baseBranchChoiceCount: 0,
              baseBranchChoicesTruncated: false,
              id: 'project-1',
              label: 'Project',
              labelTruncated: false,
              locations: {
                'existing-worktree': { enabled: true as const },
                'managed-worktree': { enabled: true as const },
                'project-root': { enabled: true as const },
              },
              projectMode: 'git' as const,
              worktreeChoiceCount: 0,
              worktreeChoicesTruncated: false,
            },
          ],
        ]),
        serverInstanceId: 'server-1',
        sessions: new Map([['shell-session-1', shellSession]]),
        sessionsByTask: new Map([['task-1', [shellSession]]]),
        tasks: new Map([
          [
            'task-1',
            {
              branchLabel: null,
              branchLabelTruncated: false,
              creationStatus: 'ready' as const,
              lifecycle: 'active' as const,
              location: 'project-root' as const,
              name: 'Terminal-only task',
              nameTruncated: false,
              ownership: 'shared' as const,
              primarySessionId: 'shell-session-1',
              projectId: 'project-1',
              sessionCount: 1,
              taskId: 'task-1',
              taskMode: 'terminal' as const,
            },
          ],
        ]),
      },
      revision: 1,
      staleReason: null,
      status: 'ready' as const,
    };
    const taskExperience = {
      catalogRuntime: {
        dispose: vi.fn(),
        handleConnectionLoss: vi.fn(),
        requestResync: vi.fn(async () => {}),
        store: {
          getSnapshot: () => snapshot,
          subscribe: vi.fn(() => () => {}),
        },
      },
      creationCapabilities: {
        getCapabilities: vi.fn(async () => REMOTE_TASK_CREATION_CAPABILITY_DARK),
      },
      taskNotesCapability: { read: true, write: true },
    };

    render(() => <App taskExperience={taskExperience as never} />);
    await fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Terminal-only task. Running. Terminal-only task.',
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Open Terminal. Running.' }));

    expect(screen.getByText('Agent detail shell-session-1 shell')).toBeDefined();
  });

  it('keeps a removed task detail reachable while its notes runtime reports an unsafe draft', async () => {
    getStoredDisplayNameMock.mockReturnValue('Already Named');
    const task = {
      branchLabel: null,
      branchLabelTruncated: false,
      creationStatus: 'ready' as const,
      lifecycle: 'active' as const,
      location: 'project-root' as const,
      name: 'Draft recovery task',
      nameTruncated: false,
      ownership: 'shared' as const,
      projectId: 'project-1',
      sessionCount: 0,
      taskId: 'task-1',
      taskMode: 'agent' as const,
    };
    const project = {
      baseBranchChoiceCount: 0,
      baseBranchChoicesTruncated: false,
      id: 'project-1',
      label: 'Project',
      labelTruncated: false,
      locations: {
        'existing-worktree': { enabled: true as const },
        'managed-worktree': { enabled: true as const },
        'project-root': { enabled: true as const },
      },
      projectMode: 'git' as const,
      worktreeChoiceCount: 0,
      worktreeChoicesTruncated: false,
    };
    const initialSnapshot = {
      projection: {
        agents: new Map(),
        catalogVersion: 1,
        projects: new Map([['project-1', project]]),
        serverInstanceId: 'server-1',
        sessions: new Map(),
        sessionsByTask: new Map(),
        tasks: new Map([['task-1', task]]),
      },
      revision: 1,
      staleReason: null,
      status: 'ready' as const,
    };
    let catalogListener: ((snapshot: typeof initialSnapshot) => void) | undefined;
    const taskExperience = {
      catalogRuntime: {
        dispose: vi.fn(),
        handleConnectionLoss: vi.fn(),
        requestResync: vi.fn(async () => {}),
        store: {
          getSnapshot: () => initialSnapshot,
          subscribe: vi.fn((listener: (snapshot: typeof initialSnapshot) => void) => {
            catalogListener = listener;
            return () => {};
          }),
        },
      },
      creationCapabilities: {
        getCapabilities: vi.fn(async () => REMOTE_TASK_CREATION_CAPABILITY_DARK),
      },
      taskNotesCapability: { read: true, write: true },
    };
    hasUnsavedRemoteTaskNotesMock.mockReturnValue(true);

    render(() => <App taskExperience={taskExperience as never} />);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open Draft recovery task. No session. Agent task.',
      }),
    );
    expect(screen.getByRole('heading', { name: 'Draft recovery task' })).toBeDefined();

    catalogListener?.({
      ...initialSnapshot,
      projection: {
        ...initialSnapshot.projection,
        catalogVersion: 2,
        tasks: new Map(),
      },
      revision: 2,
    });

    await waitFor(() => {
      expect(applyRemoteTaskNotesCatalogLifecycleMock).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ catalogVersion: 2, taskState: 'removed' }),
      );
      expect(screen.getByRole('heading', { name: 'Draft recovery task' })).toBeDefined();
    });
  });
});
