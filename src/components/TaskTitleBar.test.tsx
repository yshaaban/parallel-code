import { render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCommandOwnerStatus } from '../domain/task-command-owner-status';
import type { PeerPresenceSnapshot } from '../domain/server-state';
import { createTestTask } from '../test/store-test-helpers';

const {
  getPeerViewerCountForTaskMock,
  getProjectMock,
  getTaskCommandOwnerStatusMock,
  listPeerSessionsMock,
} = vi.hoisted(() => ({
  getPeerViewerCountForTaskMock: vi.fn(() => 0),
  getProjectMock: vi.fn<() => { baseBranch?: string } | null>(() => null),
  getTaskCommandOwnerStatusMock: vi.fn<() => TaskCommandOwnerStatus | null>(() => null),
  listPeerSessionsMock: vi.fn<() => PeerPresenceSnapshot[]>(() => []),
}));

vi.mock('../store/store', () => ({
  getPeerViewerCountForTask: getPeerViewerCountForTaskMock,
  getProject: getProjectMock,
  getTaskCommandOwnerStatus: getTaskCommandOwnerStatusMock,
  listPeerSessions: listPeerSessionsMock,
}));

import { TaskTitleBar } from './TaskTitleBar';

describe('TaskTitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPeerViewerCountForTaskMock.mockReturnValue(0);
    getProjectMock.mockReturnValue(null);
    getTaskCommandOwnerStatusMock.mockReturnValue(null);
    listPeerSessionsMock.mockReturnValue([]);
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
});
