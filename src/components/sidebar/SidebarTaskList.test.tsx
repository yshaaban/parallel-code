import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore, store } from '../../store/core';
import { computeGroupedTasks } from '../../store/sidebar-order';
import {
  createTestProject,
  createTestTask,
  resetStoreForTest,
} from '../../test/store-test-helpers';
import { SidebarTaskList } from './SidebarTaskList';

const { setActiveTaskMock, setTaskFocusedPanelMock, uncollapseTaskMock, unfocusSidebarMock } =
  vi.hoisted(() => ({
    setActiveTaskMock: vi.fn(),
    setTaskFocusedPanelMock: vi.fn(),
    uncollapseTaskMock: vi.fn(),
    unfocusSidebarMock: vi.fn(),
  }));

vi.mock('../../store/store', async () => {
  const core = await vi.importActual<typeof import('../../store/core')>('../../store/core');
  return {
    getTaskFocusedPanel: vi.fn(() => 'ai-terminal'),
    setActiveTask: setActiveTaskMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    store: core.store,
    uncollapseTask: uncollapseTaskMock,
    unfocusSidebar: unfocusSidebarMock,
  };
});

vi.mock('../SidebarTaskRow', () => ({
  CollapsedSidebarTaskRow: (props: { taskId: string }) => (
    <div data-testid={`collapsed-${props.taskId}`}>collapsed:{props.taskId}</div>
  ),
  SidebarTaskRow: (props: { taskId: string }) => (
    <div data-testid={`active-${props.taskId}`}>active:{props.taskId}</div>
  ),
}));

describe('SidebarTaskList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedTaskId', null);
    setStore('sidebarFocusedProjectId', null);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('groups collapsed tasks inline under their projects and other tasks', () => {
    const project = createTestProject({ id: 'project-1', name: 'Project' });
    setStore('projects', [project]);
    setStore('tasks', {
      'task-1': createTestTask({
        id: 'task-1',
        name: 'Active project task',
        projectId: project.id,
      }),
      'task-2': createTestTask({
        id: 'task-2',
        collapsed: true,
        name: 'Collapsed project task',
        projectId: project.id,
      }),
      'task-3': createTestTask({
        id: 'task-3',
        name: 'Active orphan task',
        projectId: undefined,
      }),
      'task-4': createTestTask({
        id: 'task-4',
        collapsed: true,
        name: 'Collapsed orphan task',
        projectId: undefined,
      }),
    });
    setStore('taskOrder', ['task-1', 'task-3']);
    setStore('collapsedTaskOrder', ['task-2', 'task-4']);

    render(() => (
      <SidebarTaskList
        dragFromIndex={() => null}
        dropTargetIndex={() => null}
        globalIndex={(taskId) => store.taskOrder.indexOf(taskId)}
        groupedTasks={() => computeGroupedTasks()}
        onEditProject={() => undefined}
        setTaskListRef={() => undefined}
      />
    ));

    expect(screen.getByText('Project (2)')).toBeDefined();
    expect(screen.getByText('Other (2)')).toBeDefined();
    expect(screen.getByText('active:task-1')).toBeDefined();
    expect(screen.getByText('collapsed:task-2')).toBeDefined();
    expect(screen.getByText('active:task-3')).toBeDefined();
    expect(screen.getByText('collapsed:task-4')).toBeDefined();

    const projectActive = screen.getByText('active:task-1');
    const projectCollapsed = screen.getByText('collapsed:task-2');
    expect(
      projectActive.compareDocumentPosition(projectCollapsed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const orphanActive = screen.getByText('active:task-3');
    const orphanCollapsed = screen.getByText('collapsed:task-4');
    expect(
      orphanActive.compareDocumentPosition(orphanCollapsed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('restores a collapsed task when enter is pressed while it is focused', () => {
    const project = createTestProject({ id: 'project-1', name: 'Project' });
    setStore('projects', [project]);
    setStore('tasks', {
      'task-1': createTestTask({ id: 'task-1', projectId: project.id }),
      'task-2': createTestTask({
        id: 'task-2',
        collapsed: true,
        projectId: project.id,
      }),
    });
    setStore('taskOrder', ['task-1']);
    setStore('collapsedTaskOrder', ['task-2']);
    setStore('sidebarFocusedTaskId', 'task-2');

    const { container } = render(() => (
      <SidebarTaskList
        dragFromIndex={() => null}
        dropTargetIndex={() => null}
        globalIndex={(taskId) => store.taskOrder.indexOf(taskId)}
        groupedTasks={() => computeGroupedTasks()}
        onEditProject={() => undefined}
        setTaskListRef={() => undefined}
      />
    ));

    fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'Enter' });

    expect(uncollapseTaskMock).toHaveBeenCalledWith('task-2');
    expect(setActiveTaskMock).not.toHaveBeenCalled();
    expect(unfocusSidebarMock).not.toHaveBeenCalled();
  });
});
