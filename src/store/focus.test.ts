import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from './core';
import {
  getSidebarRestoreTaskActionKey,
  getTaskFocusedPanel,
  navigateColumn,
  navigateRow,
  navigateTask,
  registerAction,
  registerFocusFn,
  resetFocusStateForTests,
  setTaskFocusedPanel,
  setTaskFocusedPanelState,
  triggerFocus,
  unregisterAction,
} from './focus';
import { setSidebarSectionCollapsed } from './sidebar-sections';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import type { Task } from './types';

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

function setupTwoTaskNavigationState(
  firstTaskOverrides: Partial<Task> = {},
  secondTaskOverrides: Partial<Task> = {},
): void {
  setStore('tasks', {
    'task-1': createTestTask({ id: 'task-1', ...firstTaskOverrides }),
    'task-2': createTestTask({ id: 'task-2', ...secondTaskOverrides }),
  });
  setStore('taskOrder', ['task-1', 'task-2']);
  setStore('activeTaskId', 'task-1');
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

  it('activates the owning task when focusing one of its panels', () => {
    setupTwoTaskNavigationState();

    setTaskFocusedPanel('task-2', 'prompt');

    expect(store.activeTaskId).toBe('task-2');
    expect(store.focusedPanel['task-2']).toBe('prompt');
    expect(store.sidebarFocused).toBe(false);
    expect(store.placeholderFocused).toBe(false);
  });

  it('clamps shell toolbar columns when moving into narrower rows', () => {
    const { taskId } = setupTaskWithToolbar();

    setTaskFocusedPanel(taskId, 'shell-toolbar:2');
    navigateRow('down');

    expect(store.focusedPanel[taskId]).toBe('shell:0');
  });

  it('routes vertical navigation through the steps row when tracking is enabled', () => {
    const { taskId } = setupTaskWithToolbar();
    setStore('tasks', taskId, 'stepsTracking', true);

    setTaskFocusedPanel(taskId, 'changed-files');
    navigateRow('down');
    expect(store.focusedPanel[taskId]).toBe('steps');

    navigateRow('down');
    expect(store.focusedPanel[taskId]).toBe('shell-toolbar:0');
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

  it('clears focused project when the Projects section collapses', () => {
    setStore('projects', [
      createTestProject({ id: 'project-1' }),
      createTestProject({ id: 'project-2' }),
    ]);
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedProjectId', 'project-2');

    setSidebarSectionCollapsed('projects', true);

    expect(store.sidebarSectionCollapsed.projects).toBe(true);
    expect(store.sidebarFocusedProjectId).toBeNull();
  });

  it('skips restored hidden project focus during sidebar keyboard navigation', () => {
    const project = createTestProject({ id: 'project-1' });
    setStore('projects', [project]);
    setStore('tasks', {
      'task-1': createTestTask({ id: 'task-1', projectId: project.id }),
      'task-2': createTestTask({ id: 'task-2', projectId: project.id }),
    });
    setStore('taskOrder', ['task-1', 'task-2']);
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedProjectId', project.id);
    setStore('sidebarFocusedTaskId', null);
    setStore('sidebarSectionCollapsed', {
      ...store.sidebarSectionCollapsed,
      projects: true,
    });

    navigateRow('down');

    expect(store.sidebarFocusedProjectId).toBeNull();
    expect(store.sidebarFocusedTaskId).toBe('task-1');

    navigateRow('up');

    expect(store.sidebarFocusedProjectId).toBeNull();
    expect(store.sidebarFocusedTaskId).toBe('task-1');
  });

  it('normalizes stale project focus to visible project rows during sidebar navigation', () => {
    setStore('projects', [
      createTestProject({ id: 'project-1' }),
      createTestProject({ id: 'project-2' }),
    ]);
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedProjectId', 'deleted-project');
    setStore('sidebarFocusedTaskId', null);

    navigateRow('up');

    expect(store.sidebarFocusedProjectId).toBe('project-2');
    expect(store.sidebarFocusedTaskId).toBeNull();

    setStore('sidebarFocusedProjectId', 'deleted-project');
    setStore('sidebarFocusedTaskId', null);

    navigateRow('down');

    expect(store.sidebarFocusedProjectId).toBe('project-1');
    expect(store.sidebarFocusedTaskId).toBeNull();
  });

  it('restores a collapsed sidebar task when moving right', () => {
    const project = createTestProject({ id: 'project-1' });
    const restoreCollapsedTaskMock = vi.fn();
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
    registerAction(getSidebarRestoreTaskActionKey('task-2'), restoreCollapsedTaskMock);

    navigateColumn('right');

    expect(restoreCollapsedTaskMock).toHaveBeenCalledTimes(1);
    expect(store.activeTaskId).toBe('task-1');
    unregisterAction(getSidebarRestoreTaskActionKey('task-2'));
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

  it('preserves the focused panel name when switching tasks directly', () => {
    setupTwoTaskNavigationState();
    const focusMock = vi.fn();
    registerFocusFn('task-2:changed-files', focusMock);
    setStore('focusedPanel', { 'task-1': 'changed-files' });

    navigateTask('right');

    expect(store.activeTaskId).toBe('task-2');
    expect(store.focusedPanel['task-2']).toBe('changed-files');
    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default panel when direct task switching cannot preserve the panel', () => {
    setupTwoTaskNavigationState({ stepsTracking: true });
    setStore('focusedPanel', { 'task-1': 'steps' });

    navigateTask('right');

    expect(store.activeTaskId).toBe('task-2');
    expect(store.focusedPanel['task-2']).toBe('ai-terminal');
  });

  it('preserves shell terminal index when moving across task columns', () => {
    setupTwoTaskNavigationState(
      { shellAgentIds: ['shell-1', 'shell-2'], stepsTracking: true },
      { shellAgentIds: ['shell-3', 'shell-4'] },
    );
    setStore('focusedPanel', { 'task-1': 'shell:1' });

    navigateColumn('right');

    expect(store.activeTaskId).toBe('task-2');
    expect(store.focusedPanel['task-2']).toBe('shell:1');
  });

  it('falls back from shell terminal focus to ai terminal when the next task has no shells', () => {
    setupTwoTaskNavigationState({ shellAgentIds: ['shell-1'], stepsTracking: true });
    setStore('focusedPanel', { 'task-1': 'shell:0' });

    navigateColumn('right');

    expect(store.activeTaskId).toBe('task-2');
    expect(store.focusedPanel['task-2']).toBe('ai-terminal');
  });

  it('clamps shell terminal focus when switching directly to a task with fewer shells', () => {
    setupTwoTaskNavigationState(
      { shellAgentIds: ['shell-1', 'shell-2'] },
      { shellAgentIds: ['shell-3'] },
    );
    setStore('focusedPanel', { 'task-1': 'shell:1' });

    navigateTask('right');

    expect(store.activeTaskId).toBe('task-2');
    expect(store.focusedPanel['task-2']).toBe('shell:0');
  });

  it('falls back to terminal focus when direct task switching reaches a terminal panel', () => {
    const focusMock = vi.fn();
    setStore('tasks', {
      'task-1': createTestTask({ id: 'task-1' }),
    });
    setStore('terminals', {
      'terminal-1': {
        agentId: 'terminal-agent-1',
        id: 'terminal-1',
        name: 'Terminal 1',
      },
    });
    setStore('taskOrder', ['task-1', 'terminal-1']);
    setStore('activeTaskId', 'task-1');
    setStore('focusedPanel', { 'task-1': 'changed-files' });
    registerFocusFn('terminal-1:terminal', focusMock);

    navigateTask('right');

    expect(store.activeTaskId).toBe('terminal-1');
    expect(store.focusedPanel['terminal-1']).toBe('terminal');
    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  it('keeps direct task switching inside the task order boundaries', () => {
    setupTwoTaskNavigationState();
    setStore('focusedPanel', { 'task-1': 'changed-files' });

    navigateTask('left');

    expect(store.activeTaskId).toBe('task-1');
    expect(store.focusedPanel['task-1']).toBe('changed-files');
  });

  it('does not switch tasks directly while a blocking dialog is open', () => {
    setupTwoTaskNavigationState();
    setStore('showHelpDialog', true);

    navigateTask('right');

    expect(store.activeTaskId).toBe('task-1');
  });
});
