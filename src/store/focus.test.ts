import { beforeEach, describe, expect, it } from 'vitest';
import { setStore, store } from './core';
import { getTaskFocusedPanel, navigateColumn, navigateRow, setTaskFocusedPanel } from './focus';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

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
});
