import { beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueWorkspaceEditIntent,
  getPendingWorkspaceEditIntents,
  getRebasedWorkspaceStateJson,
  getWorkspaceEditIntentConflicts,
  recordLoadedWorkspaceState,
  resetPersistenceSessionStateForTests,
} from './persistence-session.js';

function workspace(name = 'One', completedTaskCount = 0): string {
  return JSON.stringify({
    completedTaskCount,
    projects: [],
    taskOrder: ['task-1'],
    tasks: { 'task-1': { id: 'task-1', name } },
  });
}

describe('persistence session workspace intents', () => {
  beforeEach(() => resetPersistenceSessionStateForTests());

  it('rebases a pending typed edit over an unrelated canonical update', () => {
    recordLoadedWorkspaceState(workspace(), 4);
    enqueueWorkspaceEditIntent({
      baseName: 'One',
      kind: 'rename-task',
      nextName: 'Local',
      operationId: 'rename-1',
      taskId: 'task-1',
    });

    const canonical = workspace('One', 2);
    expect(JSON.parse(getRebasedWorkspaceStateJson(canonical))).toMatchObject({
      completedTaskCount: 2,
      tasks: { 'task-1': { name: 'Local' } },
    });
    recordLoadedWorkspaceState(canonical, 5);
    expect(getPendingWorkspaceEditIntents()).toEqual([
      expect.objectContaining({
        acknowledgedBaseRevision: 5,
        operationId: 'rename-1',
      }),
    ]);
    expect(getWorkspaceEditIntentConflicts()).toEqual([]);
  });

  it('retires and returns a same-field conflict while keeping canonical state visible', () => {
    recordLoadedWorkspaceState(workspace(), 1);
    enqueueWorkspaceEditIntent({
      baseName: 'One',
      kind: 'rename-task',
      nextName: 'Local',
      operationId: 'rename-1',
      taskId: 'task-1',
    });
    const canonical = workspace('Remote');

    expect(JSON.parse(getRebasedWorkspaceStateJson(canonical))).toMatchObject({
      tasks: { 'task-1': { name: 'Remote' } },
    });
    expect(recordLoadedWorkspaceState(canonical, 2)).toEqual([
      expect.objectContaining({
        canonicalValue: 'Remote',
        reason: 'same-field-changed',
      }),
    ]);
    expect(getWorkspaceEditIntentConflicts()).toEqual([
      expect.objectContaining({
        canonicalValue: 'Remote',
        reason: 'same-field-changed',
      }),
    ]);
    expect(getPendingWorkspaceEditIntents()).toEqual([]);

    expect(recordLoadedWorkspaceState(canonical, 3)).toEqual([]);
  });

  it('drops an intent when an acknowledged canonical snapshot contains its exact result', () => {
    recordLoadedWorkspaceState(workspace(), 1);
    enqueueWorkspaceEditIntent({
      baseName: 'One',
      kind: 'rename-task',
      nextName: 'Local',
      operationId: 'rename-1',
      taskId: 'task-1',
    });

    recordLoadedWorkspaceState(workspace('Local'), 2);
    expect(getPendingWorkspaceEditIntents()).toEqual([]);
  });

  it('coalesces repeated edits to one field and removes an edit that returns to base', () => {
    recordLoadedWorkspaceState(workspace(), 1);
    enqueueWorkspaceEditIntent({
      baseName: 'One',
      kind: 'rename-task',
      nextName: 'O',
      operationId: 'rename-1',
      taskId: 'task-1',
    });
    enqueueWorkspaceEditIntent({
      baseName: 'O',
      kind: 'rename-task',
      nextName: 'On',
      operationId: 'rename-2',
      taskId: 'task-1',
    });
    expect(getPendingWorkspaceEditIntents()).toEqual([
      expect.objectContaining({
        baseName: 'One',
        nextName: 'On',
        operationId: 'rename-1',
      }),
    ]);

    enqueueWorkspaceEditIntent({
      baseName: 'On',
      kind: 'rename-task',
      nextName: 'One',
      operationId: 'rename-3',
      taskId: 'task-1',
    });
    expect(getPendingWorkspaceEditIntents()).toEqual([]);
  });
});
