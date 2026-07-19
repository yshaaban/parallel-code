import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCommandOwnerStatus } from '../domain/task-command-owner-status';
import type { PeerPresenceSnapshot } from '../domain/server-state';
import { createTestTask } from '../test/store-test-helpers';

const {
  coordinatorRunReactivity,
  coordinatorRunStatusRef,
  getPeerViewerCountForTaskMock,
  getProjectMock,
  getTaskCommandOwnerStatusMock,
  listPeerSessionsMock,
  runCoordinatorOperatorActionMock,
  showNotificationMock,
} = vi.hoisted(() => ({
  coordinatorRunReactivity: {
    bump: () => {},
  },
  coordinatorRunStatusRef: { current: null as string | null, updatedAt: 1_200 },
  getPeerViewerCountForTaskMock: vi.fn(() => 0),
  getProjectMock: vi.fn<() => { baseBranch?: string } | null>(() => null),
  getTaskCommandOwnerStatusMock: vi.fn<() => TaskCommandOwnerStatus | null>(() => null),
  listPeerSessionsMock: vi.fn<() => PeerPresenceSnapshot[]>(() => []),
  runCoordinatorOperatorActionMock: vi.fn(),
  showNotificationMock: vi.fn(),
}));

vi.mock('../store/store', () => ({
  getPeerViewerCountForTask: getPeerViewerCountForTaskMock,
  getProject: getProjectMock,
  getTaskCommandOwnerStatus: getTaskCommandOwnerStatusMock,
  listPeerSessions: listPeerSessionsMock,
}));

vi.mock('../store/coordinator', async () => {
  const { createSignal } = await import('solid-js');
  const [runVersion, setRunVersion] = createSignal(0);
  coordinatorRunReactivity.bump = () => setRunVersion((version) => version + 1);
  return {
    getCoordinatorRunForTask: vi.fn(() => {
      runVersion();
      return coordinatorRunStatusRef.current === null
        ? null
        : {
            id: 'run-1',
            status: coordinatorRunStatusRef.current,
            updatedAt: coordinatorRunStatusRef.updatedAt,
          };
    }),
  };
});

vi.mock('../store/notification', () => ({
  showNotification: showNotificationMock,
}));

vi.mock('../app/coordinator-operator-actions', () => ({
  runCoordinatorOperatorAction: runCoordinatorOperatorActionMock,
}));

import { TaskTitleBar } from './TaskTitleBar';

describe('TaskTitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coordinatorRunStatusRef.current = null;
    coordinatorRunStatusRef.updatedAt = 1_200;
    getPeerViewerCountForTaskMock.mockReturnValue(0);
    getProjectMock.mockReturnValue(null);
    getTaskCommandOwnerStatusMock.mockReturnValue(null);
    listPeerSessionsMock.mockReturnValue([]);
    runCoordinatorOperatorActionMock.mockResolvedValue({ accepted: true });
  });

  it('labels the preview button as hiding the manager when it is already visible', () => {
    render(() => (
      <TaskTitleBar
        task={createTestTask()}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Hide preview')).toBeDefined();
  });

  it('labels the preview button as opening preview and ports when no ports exist yet', () => {
    render(() => (
      <TaskTitleBar
        task={createTestTask()}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Open preview and ports')).toBeDefined();
  });

  it('shows the task base branch in the merge button title when present', () => {
    render(() => (
      <TaskTitleBar
        task={createTestTask({ baseBranch: 'release/main' })}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Merge into release/main')).toBeDefined();
  });

  it('falls back to the project base branch in the merge button title', () => {
    getProjectMock.mockReturnValue({ baseBranch: 'develop' });

    render(() => (
      <TaskTitleBar
        task={createTestTask({ baseBranch: undefined })}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Merge into develop')).toBeDefined();
  });

  it('uses generic merge copy when the target branch is unknown', () => {
    render(() => (
      <TaskTitleBar
        task={createTestTask({ baseBranch: undefined })}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByTitle('Merge')).toBeDefined();
    expect(screen.queryByTitle('Merge into base branch')).toBeNull();
  });

  it('labels project-root terminal tasks without relying on color alone', () => {
    render(() => (
      <TaskTitleBar
        task={createTestTask({
          agentIds: [],
          branchName: 'main',
          gitIsolation: 'current-branch',
          shellAgentIds: ['shell-1'],
          taskMode: 'terminal',
        })}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByText('root · main')).toBeDefined();
    expect(screen.getByTitle('Works directly in the project root on main')).toBeDefined();
    expect(screen.getByText('terminal')).toBeDefined();
    expect(screen.getByTitle('Terminal-only task with no AI agent')).toBeDefined();
    expect(screen.queryByTitle(/Merge/)).toBeNull();
    expect(screen.queryByTitle('Push to remote')).toBeNull();
  });

  it('hides the self ownership chip when no peer sessions are connected', () => {
    getTaskCommandOwnerStatusMock.mockReturnValue({
      action: 'type in the terminal',
      controllerId: 'self-client',
      isSelf: true,
      label: 'You typing',
    });

    render(() => (
      <TaskTitleBar
        task={createTestTask()}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.queryByLabelText('You typing')).toBeNull();
    expect(screen.queryByTitle('You typing')).toBeNull();
  });

  it('shows visible self ownership text when peer sessions are connected', () => {
    getTaskCommandOwnerStatusMock.mockReturnValue({
      action: 'type in the terminal',
      controllerId: 'self-client',
      isSelf: true,
      label: 'You typing',
    });
    listPeerSessionsMock.mockReturnValue([
      {
        clientId: 'peer-session',
        displayName: 'Ivan',
        activeTaskId: null,
        controllingAgentIds: [],
        controllingTaskIds: [],
        focusedSurface: null,
        lastSeenAt: Date.now(),
        visibility: 'hidden',
      },
    ]);

    render(() => (
      <TaskTitleBar
        task={createTestTask()}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByLabelText('You typing')).toBeDefined();
    expect(screen.getByText('You typing')).toBeDefined();
  });

  it('keeps peer ownership text visible', () => {
    getTaskCommandOwnerStatusMock.mockReturnValue({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      isSelf: false,
      label: 'Ivan typing',
    });

    render(() => (
      <TaskTitleBar
        task={createTestTask()}
        isActive
        taskActivityStatus="live"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.getByText('Ivan typing')).toBeDefined();
  });

  function renderCoordinatorTitleBar(): void {
    render(() => (
      <TaskTitleBar
        task={createTestTask({ coordinatorRole: 'coordinator' })}
        isActive
        taskActivityStatus="idle"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));
  }

  it('offers a one-click Resume for stale-after-restore coordinator runs', async () => {
    coordinatorRunStatusRef.current = 'stale-after-restore';

    renderCoordinatorTitleBar();
    const resumeButton = screen.getByLabelText('Resume coordinator run');
    fireEvent.click(resumeButton);

    expect(resumeButton).toHaveProperty('disabled', true);
    await waitFor(() => {
      expect(runCoordinatorOperatorActionMock).toHaveBeenCalledWith({
        request: { toolName: 'resume_run' },
        taskId: 'task-1',
      });
    });

    // The accepted resume keeps the control disabled until a newer run
    // snapshot lands, so a fast double-click cannot send a duplicate
    // resume_run that would surface a spurious failure toast.
    await waitFor(() => {
      expect(resumeButton.querySelector('.inline-spinner')).toBeNull();
    });
    expect(resumeButton).toHaveProperty('disabled', true);
    runCoordinatorOperatorActionMock.mockClear();
    fireEvent.click(resumeButton);
    expect(runCoordinatorOperatorActionMock).not.toHaveBeenCalled();

    // A newer snapshot releases the guard (a successful resume normally
    // removes the button by leaving stale-after-restore entirely).
    coordinatorRunStatusRef.updatedAt = 2_400;
    coordinatorRunReactivity.bump();
    await waitFor(() => {
      expect(resumeButton).toHaveProperty('disabled', false);
    });
    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it('hides the Resume affordance for running coordinator runs', () => {
    coordinatorRunStatusRef.current = 'running';

    renderCoordinatorTitleBar();

    expect(screen.queryByLabelText('Resume coordinator run')).toBeNull();
  });

  it('hides the Resume affordance for non-coordinator tasks', () => {
    coordinatorRunStatusRef.current = 'stale-after-restore';

    render(() => (
      <TaskTitleBar
        task={createTestTask()}
        isActive
        taskActivityStatus="idle"
        hasPreviewPorts={false}
        isPreviewVisible={false}
        pushing={false}
        pushSuccess={false}
        onMouseDown={vi.fn()}
        onPreviewButtonClick={vi.fn()}
        onUpdateTaskName={vi.fn()}
        onSetTitleEditHandle={vi.fn()}
        onOpenMerge={vi.fn()}
        onOpenPush={vi.fn()}
        onCollapse={vi.fn()}
        onClose={vi.fn()}
      />
    ));

    expect(screen.queryByLabelText('Resume coordinator run')).toBeNull();
  });

  it('routes a rejected resume into a persistent error toast carrying the action name', async () => {
    coordinatorRunStatusRef.current = 'stale-after-restore';
    runCoordinatorOperatorActionMock.mockResolvedValue({
      accepted: false,
      message: 'Coordinator task command lease is required',
    });

    renderCoordinatorTitleBar();
    fireEvent.click(screen.getByLabelText('Resume coordinator run'));

    await waitFor(() => {
      expect(showNotificationMock).toHaveBeenCalledWith(
        'Failed to resume coordinator run: Coordinator task command lease is required',
        { kind: 'error' },
      );
    });
  });
});
