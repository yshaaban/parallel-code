import { describe, expect, it } from 'vitest';
import {
  WorkspaceEditIntentQueue,
  rebaseWorkspaceEditIntents,
  type WorkspaceEditIntent,
} from './workspace-edit-intents.js';

function state() {
  return {
    completedTaskCount: 1,
    projects: [{ baseBranch: 'main', id: 'project-1', name: 'Project', path: '/repo' }],
    taskOrder: ['task-1', 'task-2'],
    collapsedTaskOrder: [],
    tasks: {
      'task-1': { id: 'task-1', name: 'One', notes: 'not-owned-by-intents' },
      'task-2': { id: 'task-2', name: 'Two' },
    },
  };
}

type WorkspaceEditIntentInput = {
  [TKind in WorkspaceEditIntent['kind']]: Omit<
    Extract<WorkspaceEditIntent, { kind: TKind }>,
    'acknowledgedBaseRevision'
  >;
}[WorkspaceEditIntent['kind']];

function intent(value: WorkspaceEditIntentInput): WorkspaceEditIntent {
  return { ...value, acknowledgedBaseRevision: 4 } as WorkspaceEditIntent;
}

describe('typed workspace edit intent rebase', () => {
  it('replays rename, order, project, task, and workspace reducers on untouched target fields', () => {
    const intents: WorkspaceEditIntent[] = [
      intent({
        baseName: 'One',
        kind: 'rename-task',
        nextName: 'Renamed',
        operationId: 'rename-1',
        taskId: 'task-1',
      }),
      intent({
        baseOrder: ['task-1', 'task-2'],
        kind: 'reorder-tasks',
        list: 'active',
        nextOrder: ['task-2', 'task-1'],
        operationId: 'reorder-1',
      }),
      intent({
        baseValue: 'main',
        field: 'baseBranch',
        kind: 'edit-project-field',
        nextValue: 'trunk',
        operationId: 'project-1',
        projectId: 'project-1',
      }),
      intent({
        baseValue: undefined,
        field: 'skipPermissions',
        kind: 'edit-task-field',
        nextValue: true,
        operationId: 'task-1',
        taskId: 'task-2',
      }),
      intent({
        baseValue: 1,
        field: 'completedTaskCount',
        kind: 'edit-workspace-field',
        nextValue: 2,
        operationId: 'workspace-1',
      }),
    ];

    const result = rebaseWorkspaceEditIntents(state(), intents);

    expect(result.conflicts).toEqual([]);
    expect(result.pendingIntents).toHaveLength(5);
    expect(result.state).toMatchObject({
      completedTaskCount: 2,
      projects: [{ baseBranch: 'trunk', id: 'project-1' }],
      taskOrder: ['task-2', 'task-1'],
      tasks: {
        'task-1': { name: 'Renamed' },
        'task-2': { skipPermissions: true },
      },
    });
  });

  it('drops operations explicitly acknowledged by ID and operations already reflected canonically', () => {
    const canonical = state();
    canonical.tasks['task-1'].name = 'Renamed';
    const intents: WorkspaceEditIntent[] = [
      intent({
        baseName: 'One',
        kind: 'rename-task',
        nextName: 'Renamed',
        operationId: 'already-visible',
        taskId: 'task-1',
      }),
      intent({
        baseValue: 1,
        field: 'completedTaskCount',
        kind: 'edit-workspace-field',
        nextValue: 2,
        operationId: 'server-acked',
      }),
    ];

    const result = rebaseWorkspaceEditIntents(canonical, intents, new Set(['server-acked']));

    expect(result.acknowledgedOperationIds).toEqual(['already-visible', 'server-acked']);
    expect(result.pendingIntents).toEqual([]);
    expect(result.state.completedTaskCount).toBe(1);
  });

  it('retires and surfaces same-field conflicts without overwriting canonical state', () => {
    const canonical = state();
    canonical.tasks['task-1'].name = 'Remote rename';
    const canonicalProject = canonical.projects[0];
    if (!canonicalProject) throw new Error('test project missing');
    canonicalProject.baseBranch = 'release';
    const intents: WorkspaceEditIntent[] = [
      intent({
        baseName: 'One',
        kind: 'rename-task',
        nextName: 'Local rename',
        operationId: 'rename',
        taskId: 'task-1',
      }),
      intent({
        baseValue: 'main',
        field: 'baseBranch',
        kind: 'edit-project-field',
        nextValue: 'trunk',
        operationId: 'project',
        projectId: 'project-1',
      }),
    ];

    const result = rebaseWorkspaceEditIntents(canonical, intents);

    expect(result.state.tasks['task-1'].name).toBe('Remote rename');
    expect(result.state.projects[0]?.baseBranch).toBe('release');
    expect(result.pendingIntents).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        canonicalValue: 'Remote rename',
        intent: expect.objectContaining({ operationId: 'rename' }),
        reason: 'same-field-changed',
      }),
      expect.objectContaining({
        canonicalValue: 'release',
        intent: expect.objectContaining({ operationId: 'project' }),
        reason: 'same-field-changed',
      }),
    ]);
  });

  it('never models task addition or removal as replayable intents', () => {
    const kinds: WorkspaceEditIntent['kind'][] = [
      'rename-task',
      'reorder-tasks',
      'edit-project-field',
      'edit-task-field',
      'edit-workspace-field',
    ];

    expect(kinds).not.toContain('add-task');
    expect(kinds).not.toContain('remove-task');
  });

  it('keeps a bounded queue, rejects duplicate IDs, and advances the acknowledged base on rebase', () => {
    const queue = new WorkspaceEditIntentQueue(state(), 4, 2);
    const rename = intent({
      baseName: 'One',
      kind: 'rename-task',
      nextName: 'Renamed',
      operationId: 'rename',
      taskId: 'task-1',
    });
    queue.enqueue(rename);
    expect(() => queue.enqueue(rename)).toThrow('Duplicate');
    queue.enqueue(
      intent({
        baseOrder: ['task-1', 'task-2'],
        kind: 'reorder-tasks',
        list: 'active',
        nextOrder: ['task-2', 'task-1'],
        operationId: 'reorder',
      }),
    );
    expect(() =>
      queue.enqueue(
        intent({
          baseValue: 1,
          field: 'completedTaskCount',
          kind: 'edit-workspace-field',
          nextValue: 2,
          operationId: 'overflow',
        }),
      ),
    ).toThrow('queue is full');

    const rebased = queue.replaceCanonicalBase(state(), 5, new Set(['rename']));
    expect(rebased.pendingIntents).toEqual([
      expect.objectContaining({ acknowledgedBaseRevision: 5, operationId: 'reorder' }),
    ]);
    expect(queue.snapshot()).toMatchObject({
      lastAcknowledgedRevision: 5,
      pendingIntents: [{ operationId: 'reorder' }],
    });
  });

  it('surfaces target removal as a conflict instead of resurrecting the target', () => {
    const canonical = state();
    Reflect.deleteProperty(canonical.tasks, 'task-1');
    const result = rebaseWorkspaceEditIntents(canonical, [
      intent({
        baseName: 'One',
        kind: 'rename-task',
        nextName: 'Renamed',
        operationId: 'rename',
        taskId: 'task-1',
      }),
    ]);

    expect(result.conflicts).toEqual([expect.objectContaining({ reason: 'target-missing' })]);
    expect(result.pendingIntents).toEqual([]);
    expect(result.state.tasks['task-1']).toBeUndefined();
  });
});
