import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setStore, store } from './core';
import { registerFocusFn, resetFocusStateForTests } from './focus';
import { jumpToTask, moveActiveTask, navigateAgent, setActiveAgent } from './navigation';
import {
  createTestAgent,
  createTestProject,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';

describe('moveActiveTask', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetFocusStateForTests();
  });

  afterEach(() => {
    resetFocusStateForTests();
    vi.restoreAllMocks();
  });

  it('re-focuses the moved task panel after keyboard reordering', () => {
    const project = createTestProject();
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      projectId: project.id,
    });
    const neighbor = createTestTask({
      agentIds: ['agent-2'],
      id: 'task-2',
      projectId: project.id,
    });

    setStore('projects', [project]);
    setStore('tasks', {
      'task-1': task,
      'task-2': neighbor,
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-2' }),
    });
    setStore('taskOrder', ['task-1', 'task-2']);
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');
    setStore('focusedPanel', { 'task-1': 'prompt' });

    const focusMock = vi.fn();
    registerFocusFn('task-1:prompt', focusMock);

    moveActiveTask('right');

    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(store.taskOrder).toEqual(['task-2', 'task-1']);
    expect(store.activeTaskId).toBe('task-1');
  });

  it('jumps to a visible task by task order index', () => {
    const project = createTestProject();
    const firstTask = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      projectId: project.id,
    });
    const secondTask = createTestTask({
      agentIds: ['agent-2'],
      id: 'task-2',
      projectId: project.id,
    });

    setStore('projects', [project]);
    setStore('tasks', {
      'task-1': firstTask,
      'task-2': secondTask,
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-2' }),
    });
    setStore('taskOrder', ['task-1', 'task-2']);
    setStore('focusedPanel', { 'task-2': 'changed-files' });
    const focusMock = vi.fn();
    registerFocusFn('task-2:changed-files', focusMock);

    jumpToTask(1);

    expect(store.activeTaskId).toBe('task-2');
    expect(store.activeAgentId).toBe('agent-2');
    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  it('restores the stored selected agent when activating a multi-agent task', () => {
    const project = createTestProject();
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      projectId: project.id,
      selectedAgentId: 'agent-2',
    });

    setStore('projects', [project]);
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('taskOrder', ['task-1']);

    jumpToTask(0);

    expect(store.activeAgentId).toBe('agent-2');
  });

  it('updates task selected-agent projection when the active agent changes', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });

    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('taskOrder', ['task-1']);
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');

    navigateAgent('down');
    expect(store.activeAgentId).toBe('agent-2');
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-2');

    setActiveAgent('agent-1');
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-1');
  });

  it('jumps to a standalone terminal by task order index and focuses the terminal panel', () => {
    setStore('terminals', {
      'terminal-1': {
        agentId: 'terminal-agent-1',
        id: 'terminal-1',
        name: 'Terminal 1',
      },
    });
    setStore('taskOrder', ['terminal-1']);
    const focusMock = vi.fn();
    registerFocusFn('terminal-1:terminal', focusMock);

    jumpToTask(0);

    expect(store.activeTaskId).toBe('terminal-1');
    expect(store.activeAgentId).toBe(null);
    expect(store.focusedPanel['terminal-1']).toBe('terminal');
    expect(focusMock).toHaveBeenCalledTimes(1);
  });

  it('does not jump when the task order index is out of bounds', () => {
    const project = createTestProject();
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      projectId: project.id,
    });

    setStore('projects', [project]);
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
    });
    setStore('taskOrder', ['task-1']);
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');

    jumpToTask(8);

    expect(store.activeTaskId).toBe('task-1');
    expect(store.activeAgentId).toBe('agent-1');
  });
});
