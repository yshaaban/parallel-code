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
  it.each<WorkspaceEditIntentInput>([
    {
      kind: 'rename-task',
      taskId: 'task-1',
      operationId: 'first',
      baseName: 'One',
      nextName: 'Two',
    },
    {
      kind: 'reorder-tasks',
      list: 'active',
      operationId: 'first',
      baseOrder: ['task-1', 'task-2'],
      nextOrder: ['task-2', 'task-1'],
    },
    {
      kind: 'edit-project-field',
      projectId: 'project-1',
      field: 'baseBranch',
      operationId: 'first',
      baseValue: 'main',
      nextValue: 'trunk',
    },
    {
      kind: 'edit-task-field',
      taskId: 'task-1',
      field: 'planFileName',
      operationId: 'first',
      baseValue: 'first.md',
      nextValue: 'second.md',
    },
    {
      kind: 'edit-workspace-field',
      field: 'hydraCommand',
      operationId: 'first',
      baseValue: 'old',
      nextValue: 'new',
    },
    {
      kind: 'set-task-shell-membership',
      taskId: 'task-1',
      shellId: 'shell-1',
      operationId: 'first',
      present: true,
    },
  ])('coalesces $kind while preserving its original base and operation identity', (first) => {
    const queue = new WorkspaceEditIntentQueue(state(), 4);
    queue.enqueue(intent(first));
    let next: WorkspaceEditIntentInput;
    let expected: WorkspaceEditIntent;
    switch (first.kind) {
      case 'rename-task':
        next = { ...first, operationId: 'second', baseName: first.nextName, nextName: 'Latest' };
        expected = intent({ ...first, nextName: 'Latest' });
        break;
      case 'reorder-tasks':
        next = {
          ...first,
          operationId: 'second',
          baseOrder: first.nextOrder,
          nextOrder: ['task-2'],
        };
        expected = intent({ ...first, nextOrder: ['task-2'] });
        break;
      case 'set-task-shell-membership':
        next = { ...first, operationId: 'second', present: false };
        expected = intent({ ...first, present: false });
        break;
      default:
        next = { ...first, operationId: 'second', baseValue: first.nextValue, nextValue: 'Latest' };
        expected = intent({ ...first, nextValue: 'Latest' });
    }
    queue.enqueue(intent(next));
    expect(queue.snapshot().pendingIntents).toEqual([expected]);
  });

  function renameIntent(
    baseName: string,
    nextName: string,
    operationId: string,
  ): WorkspaceEditIntent {
    return intent({ kind: 'rename-task', taskId: 'task-1', baseName, nextName, operationId });
  }

  it('keeps submitted edits ordered and acknowledges a skipped same-field prefix before replaying its tail', () => {
    const queue = new WorkspaceEditIntentQueue(state(), 4);
    let previous = 'One';
    for (const next of ['Two', 'Three', 'Four']) {
      queue.enqueue(renameIntent(previous, next, next));
      const submitted = state();
      submitted.tasks['task-1'].name = next;
      queue.markSubmitted(submitted);
      previous = next;
    }
    queue.enqueue(renameIntent('Four', 'Latest local', 'tail'));
    expect(queue.replaceCanonicalBase(state(), 4).pendingIntents).toHaveLength(4);
    const canonical = state();
    canonical.tasks['task-1'].name = 'Four';

    // Preview runs before the store records the new canonical base.
    expect(
      rebaseWorkspaceEditIntents(canonical, queue.snapshot().pendingIntents).state.tasks['task-1']
        .name,
    ).toBe('Latest local');
    const result = queue.replaceCanonicalBase(canonical, 5);
    expect(result.conflicts).toEqual([]);
    expect(result.acknowledgedOperationIds).toEqual(['Two', 'Three', 'Four']);
    expect(result.pendingIntents).toEqual([
      expect.objectContaining({ operationId: 'tail', acknowledgedBaseRevision: 5 }),
    ]);
    expect(result.state.tasks['task-1'].name).toBe('Latest local');
  });

  it('still surfaces a genuine peer same-field change instead of replaying a submitted chain over it', () => {
    const queue = new WorkspaceEditIntentQueue(state(), 4);
    queue.enqueue(renameIntent('One', 'Intermediate', 'first'));
    const submitted = state();
    submitted.tasks['task-1'].name = 'Intermediate';
    queue.markSubmitted(submitted);
    queue.enqueue(renameIntent('Intermediate', 'One', 'second'));
    const peer = state();
    peer.tasks['task-1'].name = 'Peer';
    const result = queue.replaceCanonicalBase(peer, 5);
    expect(result.state.tasks['task-1'].name).toBe('Peer');
    expect(result.pendingIntents).toEqual([]);
    expect(result.conflicts).toHaveLength(2);
  });

  it('bounds submitted history and releases capacity after a later exact result', () => {
    const queue = new WorkspaceEditIntentQueue(state(), 4, 2);
    queue.enqueue(renameIntent('One', 'Two', 'first'));
    const submitted = state();
    submitted.tasks['task-1'].name = 'Two';
    queue.markSubmitted(submitted);
    queue.enqueue(renameIntent('Two', 'Three', 'second'));
    submitted.tasks['task-1'].name = 'Three';
    queue.markSubmitted(submitted);
    expect(() => queue.enqueue(renameIntent('Three', 'Four', 'overflow'))).toThrow('full');
    expect(queue.replaceCanonicalBase(submitted, 5).pendingIntents).toEqual([]);
    expect(() =>
      queue.enqueue({ ...renameIntent('Three', 'Four', 'next'), acknowledgedBaseRevision: 5 }),
    ).not.toThrow();
  });

  it('counts reserved capacity against new edits and releases a reservation only once', () => {
    const queue = new WorkspaceEditIntentQueue(state(), 4, 1);
    const release = queue.reserveCapacity();
    expect(() => queue.enqueue(renameIntent('One', 'Two', 'blocked'))).toThrow('full');
    expect(() => queue.reserveCapacity()).toThrow('full');
    release();
    release();
    queue.enqueue(renameIntent('One', 'Two', 'admitted'));
    expect(() => queue.reserveCapacity()).toThrow('full');
  });

  function shellState(shellAgentIds = ['primary', 'local']) {
    return {
      tasks: {
        'task-1': {
          id: 'task-1',
          shellAgentIds,
          shellCount: shellAgentIds.length,
          taskInitialShellOwnership: { kind: 'managed-terminal-v1', sessionId: 'primary' },
        },
      },
    };
  }

  function shellIntent(shellId: string, present: boolean): WorkspaceEditIntent {
    return intent({
      kind: 'set-task-shell-membership',
      operationId: `${shellId}:${present}`,
      shellId,
      present,
      taskId: 'task-1',
    });
  }

  it('rebases per-shell additions and removals without replacing canonical sibling membership', () => {
    const canonical = shellState(['primary', 'peer', 'local']);
    const result = rebaseWorkspaceEditIntents(canonical, [
      shellIntent('local', false),
      shellIntent('new', true),
    ]);
    expect(result.state.tasks['task-1']).toMatchObject({
      shellAgentIds: ['primary', 'peer', 'new'],
      shellCount: 3,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.pendingIntents).toHaveLength(2);
    expect(canonical.tasks['task-1'].shellAgentIds).toEqual(['primary', 'peer', 'local']);
  });

  it('coalesces add then close without acknowledging the original absence or a late add', () => {
    const initial = shellState(['primary']);
    const queue = new WorkspaceEditIntentQueue(initial, 4, 1);
    queue.enqueue(shellIntent('new', true));
    queue.enqueue(shellIntent('new', false));
    expect(queue.replaceCanonicalBase(initial, 4).pendingIntents).toHaveLength(1);
    const lateAdd = queue.replaceCanonicalBase(shellState(['primary', 'new']), 5);
    expect(lateAdd.state.tasks['task-1'].shellAgentIds).toEqual(['primary']);
    expect(lateAdd.pendingIntents).toEqual([
      expect.objectContaining({ present: false, acknowledgedBaseRevision: 5 }),
    ]);
    expect(queue.replaceCanonicalBase(initial, 5).pendingIntents).toHaveLength(1);
    expect(queue.replaceCanonicalBase(initial, 6).pendingIntents).toEqual([]);
  });

  it('coalesces against the latest canonical revision and keeps the queue bounded by shell', () => {
    const initial = shellState(['primary']);
    const queue = new WorkspaceEditIntentQueue(initial, 4, 1);
    queue.enqueue(shellIntent('new', true));
    queue.replaceCanonicalBase(initial, 5);
    queue.enqueue({ ...shellIntent('new', false), acknowledgedBaseRevision: 5 });
    expect(queue.replaceCanonicalBase(initial, 5).pendingIntents).toHaveLength(1);
    expect(() =>
      queue.enqueue({ ...shellIntent('another', true), acknowledgedBaseRevision: 5 }),
    ).toThrow('full');
    expect(queue.snapshot().pendingIntents).toEqual([
      expect.objectContaining({ shellId: 'new', present: false, acknowledgedBaseRevision: 5 }),
    ]);
  });

  it('retires shell intents for removed tasks without recreating tasks', () => {
    const result = rebaseWorkspaceEditIntents({ tasks: {} }, [shellIntent('new', true)]);
    expect(result.state).toEqual({ tasks: {} });
    expect(result.pendingIntents).toEqual([]);
    expect(result.conflicts).toEqual([expect.objectContaining({ reason: 'target-missing' })]);
  });

  it.each([
    'remove-primary',
    'missing-primary',
    'changed-task-identity',
    'legacy-missing-shell-ids',
  ])('does not replay membership against %s', (scenario) => {
    const canonical = shellState() as { tasks: Record<string, Record<string, unknown>> };
    const task = canonical.tasks['task-1'];
    if (!task) throw new Error('Expected task fixture');
    if (scenario === 'missing-primary') task.shellAgentIds = ['local'];
    if (scenario === 'changed-task-identity') task.id = 'replacement';
    if (scenario === 'legacy-missing-shell-ids') delete task.shellAgentIds;
    const before = structuredClone(canonical);
    const result = rebaseWorkspaceEditIntents(canonical, [
      shellIntent(scenario === 'remove-primary' ? 'primary' : 'new', scenario !== 'remove-primary'),
    ]);
    expect(result.state).toEqual(before);
    expect(result.pendingIntents).toEqual([]);
    expect(result.conflicts).toEqual([expect.objectContaining({ reason: 'same-field-changed' })]);
  });

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
