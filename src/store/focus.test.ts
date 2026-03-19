import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from './core';
import {
  getTaskFocusedPanel,
  navigateColumn,
  navigateRow,
  registerFocusFn,
  resetFocusStateForTests,
  setTaskFocusedPanel,
  setTaskFocusedPanelState,
  triggerFocus,
} from './focus';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { uncollapseTaskMock } = vi.hoisted(() => ({
  uncollapseTaskMock: vi.fn(),
}));

vi.mock('./tasks', () => ({
  uncollapseTask: uncollapseTaskMock,
}));

function setupTaskWithToolbar(): { taskId: string } {
  const project = createTestProject({
    terminalBookmarks: [
      { id: 'bookmark-1', command: 'npm run dev' },
      { id: 'bookmark-2', command: 'npm run test' },
    ],
  });
  const task = createTestTask({
    projectId: project.id,
    shellAgentIds: ['shell-1'],
  });

  setStore('projects', [project]);
  setStore('tasks', { [task.id]: task });
  setStore('taskOrder', [task.id]);
  setStore('activeTaskId', task.id);

  return { taskId: task.id };
}

describe('focus shell toolbar navigation', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetFocusStateForTests();
  });

  it('normalizes legacy shell-toolbar focus to the first toolbar button', () => {
    const { taskId } = setupTaskWithToolbar();

    setStore('focusedPanel', { [taskId]: 'shell-toolbar' });

    expect(getTaskFocusedPanel(taskId)).toBe('shell-toolbar:0');
  });

  it('clamps stale shell-toolbar focus to the last available toolbar button', () => {
    const { taskId } = setupTaskWithToolbar();

    setStore('focusedPanel', { [taskId]: 'shell-toolbar:9' });

    expect(getTaskFocusedPanel(taskId)).toBe('shell-toolbar:2');
  });

  it('moves across shell toolbar buttons with column navigation', () => {
    const { taskId } = setupTaskWithToolbar();

    setTaskFocusedPanel(taskId, 'shell-toolbar:0');
    navigateColumn('right');
    expect(store.focusedPanel[taskId]).toBe('shell-toolbar:1');

    navigateColumn('right');
    expect(store.focusedPanel[taskId]).toBe('shell-toolbar:2');

    navigateColumn('left');
    expect(store.focusedPanel[taskId]).toBe('shell-toolbar:1');
  });

  it('clamps shell toolbar columns when moving into narrower rows', () => {
    const { taskId } = setupTaskWithToolbar();

    setTaskFocusedPanel(taskId, 'shell-toolbar:2');
    navigateRow('down');

    expect(store.focusedPanel[taskId]).toBe('shell:0');
  });

  it('moves through collapsed tasks using the sidebar order projection', () => {
    const project = createTestProject({ id: 'project-1' });
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
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedTaskId', 'task-1');

    navigateRow('down');
    expect(store.sidebarFocusedTaskId).toBe('task-2');

    navigateRow('up');
    expect(store.sidebarFocusedTaskId).toBe('task-1');
  });

  it('restores a collapsed sidebar task when moving right', () => {
    const project = createTestProject({ id: 'project-1' });
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
    setStore('activeTaskId', 'task-1');
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedTaskId', 'task-2');

    navigateColumn('right');

    expect(uncollapseTaskMock).toHaveBeenCalledWith('task-2');
    expect(store.activeTaskId).toBe('task-1');
  });

  it('replays a pending task-panel focus when the callback registers late', async () => {
    const { taskId } = setupTaskWithToolbar();
    const focusMock = vi.fn();

    setTaskFocusedPanelState(taskId, 'shell:0');
    triggerFocus(`${taskId}:shell:0`);
    registerFocusFn(`${taskId}:shell:0`, focusMock);
    await Promise.resolve();

    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  it('does not replay stale pending task-panel focus after the focused panel changes', async () => {
    const { taskId } = setupTaskWithToolbar();
    const focusMock = vi.fn();

    setTaskFocusedPanelState(taskId, 'shell:0');
    triggerFocus(`${taskId}:shell:0`);
    setTaskFocusedPanelState(taskId, 'prompt');
    registerFocusFn(`${taskId}:shell:0`, focusMock);
    await Promise.resolve();

    expect(focusMock).not.toHaveBeenCalled();
  });

  it('does not replay pending task-panel focus while the sidebar owns focus', async () => {
    const { taskId } = setupTaskWithToolbar();
    const focusMock = vi.fn();

    setTaskFocusedPanelState(taskId, 'shell:0');
    triggerFocus(`${taskId}:shell:0`);
    setStore('sidebarFocused', true);
    registerFocusFn(`${taskId}:shell:0`, focusMock);
    await Promise.resolve();

    expect(focusMock).not.toHaveBeenCalled();
  });

  it('does not replay pending task-panel focus while a blocking dialog is open', async () => {
    const { taskId } = setupTaskWithToolbar();
    const focusMock = vi.fn();

    setTaskFocusedPanelState(taskId, 'shell:0');
    triggerFocus(`${taskId}:shell:0`);
    setStore('showHelpDialog', true);
    registerFocusFn(`${taskId}:shell:0`, focusMock);
    await Promise.resolve();

    expect(focusMock).not.toHaveBeenCalled();
  });
});
