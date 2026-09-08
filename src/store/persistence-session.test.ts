import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueWorkspaceEditIntent,
  getPendingWorkspaceEditIntents,
  getRebasedWorkspaceStateJson,
  getWorkspaceEditIntentConflicts,
  recordLoadedWorkspaceState,
  reserveWorkspaceEditIntentCapacity,
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
  afterEach(() => vi.restoreAllMocks());

  it('reuses an initialized queue without reparsing canonical JSON for each edit or reservation', () => {
    recordLoadedWorkspaceState(workspace(), 4);
    const parse = vi.spyOn(JSON, 'parse');
    for (let index = 0; index < 3; index += 1) {
      enqueueWorkspaceEditIntent({
        kind: 'rename-task',
        taskId: 'task-1',
        operationId: `rename-${index}`,
        baseName: index === 0 ? 'One' : `Local ${index - 1}`,
        nextName: `Local ${index}`,
      });
      reserveWorkspaceEditIntentCapacity()();
    }
    expect(parse).not.toHaveBeenCalled();
    expect(getPendingWorkspaceEditIntents()).toEqual([
      expect.objectContaining({ operationId: 'rename-0', baseName: 'One', nextName: 'Local 2' }),
    ]);
  });

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
