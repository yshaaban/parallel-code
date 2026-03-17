import { render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestTask } from '../test/store-test-helpers';

const { getPeerViewerCountForTaskMock, getTaskCommandOwnerStatusMock } = vi.hoisted(() => ({
  getPeerViewerCountForTaskMock: vi.fn(() => 0),
  getTaskCommandOwnerStatusMock: vi.fn(() => null),
}));

vi.mock('../store/store', () => ({
  getPeerViewerCountForTask: getPeerViewerCountForTaskMock,
  getTaskCommandOwnerStatus: getTaskCommandOwnerStatusMock,
}));

import { TaskTitleBar } from './TaskTitleBar';

describe('TaskTitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPeerViewerCountForTaskMock.mockReturnValue(0);
    getTaskCommandOwnerStatusMock.mockReturnValue(null);
  });

  it('labels the preview button as hiding the manager when it is already visible', () => {
    render(() => (
      <TaskTitleBar
        task={createTestTask()}
        isActive
        taskDotStatus="busy"
        firstAgentStatusBadge={null}
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
        taskDotStatus="busy"
        firstAgentStatusBadge={null}
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
});
