import { describe, expect, it, vi } from 'vitest';

import type {
  GetTaskCatalogPageRequest,
  RemoteProjectSummary,
  RemoteTaskSessionRef,
  RemoteTaskSummary,
  TaskCatalogClientFacade,
  TaskCatalogDeltaBatch,
  TaskCatalogEvent,
  TaskCatalogEntityKind,
  TaskCatalogLiveEventSource,
  TaskCatalogPage,
  TaskCatalogReplaceManifest,
} from '../domain/task-catalog';
import { TaskCatalogRuntime, TaskCatalogStore } from './task-catalog-store';

function project(id = 'project-1'): RemoteProjectSummary {
  return {
    baseBranchChoiceCount: 1,
    baseBranchChoicesTruncated: false,
    id,
    label: 'Parallel Code',
    labelTruncated: false,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    projectMode: 'git',
    worktreeChoiceCount: 0,
    worktreeChoicesTruncated: false,
  };
}

function task(overrides: Partial<RemoteTaskSummary> = {}): RemoteTaskSummary {
  return {
    branchLabel: 'feature/catalog',
    branchLabelTruncated: false,
    creationStatus: 'ready',
    lifecycle: 'active',
    location: 'managed-worktree',
    name: 'Catalog work',
    nameTruncated: false,
    ownership: 'managed',
    projectId: 'project-1',
    sessionCount: 0,
    taskId: 'task-1',
    taskMode: 'agent',
    ...overrides,
  };
}

function session(overrides: Partial<RemoteTaskSessionRef> = {}): RemoteTaskSessionRef {
  return {
    generation: 1,
    kind: 'agent',
    orderKey: '0001',
    sessionId: 'session-1',
    state: 'running',
    taskId: 'task-1',
    ...overrides,
  };
}

function delta(
  fromCatalogVersion: number,
  toCatalogVersion: number,
  events: TaskCatalogEvent[],
  serverInstanceId = 'server-a',
): TaskCatalogDeltaBatch {
  return { events, fromCatalogVersion, serverInstanceId, toCatalogVersion };
}

function manifest(
  counts: Partial<Record<TaskCatalogEntityKind, number>> = {},
  overrides: Partial<TaskCatalogReplaceManifest> = {},
): TaskCatalogReplaceManifest {
  return {
    catalogVersion: 4,
    counts: {
      project: 1,
      session: 0,
      'static-agent': 0,
      task: 1,
      ...counts,
    },
    mode: 'replace-paged',
    pageByteLimit: 49_152,
    pageItemLimit: 50,
    serverInstanceId: 'server-a',
    snapshotId: 'snapshot-a',
    ...overrides,
  };
}

function page(
  currentManifest: TaskCatalogReplaceManifest,
  kind: TaskCatalogEntityKind,
  items: TaskCatalogPage['items'],
  nextCursor: string | null = null,
): TaskCatalogPage {
  return {
    catalogVersion: currentManifest.catalogVersion,
    items,
    kind,
    nextCursor,
    serverInstanceId: currentManifest.serverInstanceId,
    snapshotId: currentManifest.snapshotId,
  } as TaskCatalogPage;
}

function request(
  currentManifest: TaskCatalogReplaceManifest,
  kind: TaskCatalogEntityKind,
  cursor?: string,
): GetTaskCatalogPageRequest {
  return {
    catalogVersion: currentManifest.catalogVersion,
    kind,
    serverInstanceId: currentManifest.serverInstanceId,
    snapshotId: currentManifest.snapshotId,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function publish(
  store: TaskCatalogStore,
  currentManifest = manifest(),
  rows: {
    projects?: RemoteProjectSummary[];
    sessions?: RemoteTaskSessionRef[];
    tasks?: RemoteTaskSummary[];
  } = {},
): void {
  expect(store.beginManifest(currentManifest)).toBe('staged');
  expect(
    store.stagePage(
      page(currentManifest, 'project', rows.projects ?? [project()]),
      request(currentManifest, 'project'),
    ),
  ).toBe('accepted');
  expect(
    store.stagePage(
      page(currentManifest, 'static-agent', []),
      request(currentManifest, 'static-agent'),
    ),
  ).toBe('accepted');
  expect(
    store.stagePage(
      page(currentManifest, 'task', rows.tasks ?? [task()]),
      request(currentManifest, 'task'),
    ),
  ).toBe('accepted');
  expect(
    store.stagePage(
      page(currentManifest, 'session', rows.sessions ?? []),
      request(currentManifest, 'session'),
    ),
  ).toBe('published');
}

describe('TaskCatalogStore', () => {
  it('publishes a counted replacement atomically', () => {
    const store = new TaskCatalogStore();
    const currentManifest = manifest();

    expect(store.beginManifest(currentManifest)).toBe('staged');
    store.stagePage(
      page(currentManifest, 'project', [project()]),
      request(currentManifest, 'project'),
    );
    store.stagePage(
      page(currentManifest, 'static-agent', []),
      request(currentManifest, 'static-agent'),
    );
    store.stagePage(page(currentManifest, 'task', [task()]), request(currentManifest, 'task'));

    expect(store.getSnapshot()).toMatchObject({ projection: null, status: 'loading' });

    expect(
      store.stagePage(page(currentManifest, 'session', []), request(currentManifest, 'session')),
    ).toBe('published');
    expect(store.getSnapshot().projection?.tasks.get('task-1')?.name).toBe('Catalog work');
    expect(store.getSnapshot().status).toBe('ready');
  });

  it('discards duplicate/count-invalid staging without clearing prior complete truth', () => {
    const store = new TaskCatalogStore();
    publish(store);
    const prior = store.getSnapshot().projection;
    const nextManifest = manifest({ task: 2 }, { catalogVersion: 5, snapshotId: 'snapshot-b' });
    store.beginManifest(nextManifest);
    store.stagePage(page(nextManifest, 'project', [project()]), request(nextManifest, 'project'));
    store.stagePage(page(nextManifest, 'static-agent', []), request(nextManifest, 'static-agent'));

    expect(
      store.stagePage(page(nextManifest, 'task', [task(), task()]), request(nextManifest, 'task')),
    ).toBe('stale');
    expect(store.getSnapshot()).toMatchObject({
      projection: prior,
      staleReason: 'duplicate-row',
      status: 'stale',
    });
  });

  it('replays contiguous deltas after replacement and rejects gaps', () => {
    const store = new TaskCatalogStore();
    const currentManifest = manifest();
    store.beginManifest(currentManifest);
    expect(
      store.applyDeltaBatch(
        delta(4, 5, [
          {
            catalogVersion: 5,
            entity: task({ name: 'Renamed' }),
            entityKind: 'task',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('buffered');
    store.stagePage(
      page(currentManifest, 'project', [project()]),
      request(currentManifest, 'project'),
    );
    store.stagePage(
      page(currentManifest, 'static-agent', []),
      request(currentManifest, 'static-agent'),
    );
    store.stagePage(page(currentManifest, 'task', [task()]), request(currentManifest, 'task'));
    store.stagePage(page(currentManifest, 'session', []), request(currentManifest, 'session'));

    expect(store.getSnapshot().projection?.catalogVersion).toBe(5);
    expect(store.getSnapshot().projection?.tasks.get('task-1')?.name).toBe('Renamed');

    expect(
      store.applyDeltaBatch(
        delta(6, 7, [
          {
            catalogVersion: 7,
            entityId: 'task-1',
            entityKind: 'task',
            kind: 'remove',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('stale');
    expect(store.getSnapshot().projection?.tasks.has('task-1')).toBe(true);
  });

  it('applies one complete catalog version atomically and resumes from its final version', () => {
    const store = new TaskCatalogStore();
    publish(store);

    expect(
      store.applyDeltaBatch(
        delta(4, 5, [
          {
            catalogVersion: 5,
            entity: task({ name: 'Renamed task' }),
            entityKind: 'task',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
          {
            catalogVersion: 5,
            entity: project('project-1'),
            entityKind: 'project',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('applied');
    expect(store.getDeltaResumeVersion()).toBe(5);
    expect(store.getSnapshot().projection?.tasks.get('task-1')?.name).toBe('Renamed task');
  });

  it('publishes a session and its matching task count in one coherent notification', () => {
    const store = new TaskCatalogStore();
    publish(store);
    const prior = store.getSnapshot().projection;
    const observed: Array<ReturnType<TaskCatalogStore['getSnapshot']>> = [];
    store.subscribe((snapshot) => observed.push(snapshot));

    expect(
      store.applyDeltaBatch(
        delta(4, 5, [
          {
            catalogVersion: 5,
            entity: session(),
            entityKind: 'session',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
          {
            catalogVersion: 5,
            entity: task({ primarySessionId: 'session-1', sessionCount: 1 }),
            entityKind: 'task',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('applied');

    expect(observed).toHaveLength(2);
    expect(observed[1]?.projection?.sessionsByTask.get('task-1')).toHaveLength(1);
    expect(observed[1]?.projection?.tasks.get('task-1')?.sessionCount).toBe(1);
    expect(prior?.sessions.size).toBe(0);
    expect(prior?.tasks.get('task-1')?.sessionCount).toBe(0);
  });

  it('removes a task and its session atomically even when the task event comes first', () => {
    const store = new TaskCatalogStore();
    const currentManifest = manifest({ session: 1 });
    publish(store, currentManifest, {
      sessions: [session()],
      tasks: [task({ primarySessionId: 'session-1', sessionCount: 1 })],
    });
    const prior = store.getSnapshot().projection;
    const listener = vi.fn();
    store.subscribe(listener);

    expect(
      store.applyDeltaBatch(
        delta(4, 5, [
          {
            catalogVersion: 5,
            entityId: 'task-1',
            entityKind: 'task',
            kind: 'remove',
            serverInstanceId: 'server-a',
          },
          {
            catalogVersion: 5,
            entityId: 'session-1',
            entityKind: 'session',
            kind: 'remove',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('applied');

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().projection?.tasks.size).toBe(0);
    expect(store.getSnapshot().projection?.sessions.size).toBe(0);
    expect(prior?.tasks.has('task-1')).toBe(true);
    expect(prior?.sessions.has('session-1')).toBe(true);
  });

  it('adds and removes a project/task pair without exposing an orphan task', () => {
    const store = new TaskCatalogStore();
    publish(store);
    const taskTwo = task({ name: 'Second task', projectId: 'project-2', taskId: 'task-2' });
    const listener = vi.fn();
    store.subscribe(listener);

    expect(
      store.applyDeltaBatch(
        delta(4, 5, [
          {
            catalogVersion: 5,
            entity: taskTwo,
            entityKind: 'task',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
          {
            catalogVersion: 5,
            entity: project('project-2'),
            entityKind: 'project',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('applied');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().projection?.tasks.get('task-2')?.projectId).toBe('project-2');

    expect(
      store.applyDeltaBatch(
        delta(5, 6, [
          {
            catalogVersion: 6,
            entityId: 'project-2',
            entityKind: 'project',
            kind: 'remove',
            serverInstanceId: 'server-a',
          },
          {
            catalogVersion: 6,
            entityId: 'task-2',
            entityKind: 'task',
            kind: 'remove',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('applied');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().projection?.projects.has('project-2')).toBe(false);
    expect(store.getSnapshot().projection?.tasks.has('task-2')).toBe(false);
  });

  it('keeps the prior projection byte-for-byte visible when a batch fails integrity', () => {
    const store = new TaskCatalogStore();
    publish(store);
    const prior = store.getSnapshot().projection;

    expect(
      store.applyDeltaBatch(
        delta(4, 5, [
          {
            catalogVersion: 5,
            entityId: 'project-1',
            entityKind: 'project',
            kind: 'remove',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('stale');

    expect(store.getSnapshot()).toMatchObject({
      projection: prior,
      staleReason: 'referential-integrity',
      status: 'stale',
    });
    expect(prior?.projects.has('project-1')).toBe(true);
    expect(prior?.tasks.get('task-1')?.projectId).toBe('project-1');
  });

  it('validates buffered deltas after paged staging and preserves the prior snapshot on failure', () => {
    const store = new TaskCatalogStore();
    publish(store);
    const prior = store.getSnapshot().projection;
    const nextManifest = manifest({}, { catalogVersion: 6, snapshotId: 'snapshot-next' });
    expect(store.beginManifest(nextManifest)).toBe('staged');
    expect(
      store.applyDeltaBatch(
        delta(6, 7, [
          {
            catalogVersion: 7,
            entity: task({ primarySessionId: 'missing-session', sessionCount: 1 }),
            entityKind: 'task',
            kind: 'replace',
            serverInstanceId: 'server-a',
          },
        ]),
      ),
    ).toBe('buffered');
    store.stagePage(page(nextManifest, 'project', [project()]), request(nextManifest, 'project'));
    store.stagePage(page(nextManifest, 'static-agent', []), request(nextManifest, 'static-agent'));
    store.stagePage(page(nextManifest, 'task', [task()]), request(nextManifest, 'task'));

    expect(
      store.stagePage(page(nextManifest, 'session', []), request(nextManifest, 'session')),
    ).toBe('stale');
    expect(store.getSnapshot()).toMatchObject({
      projection: prior,
      staleReason: 'referential-integrity',
      status: 'stale',
    });
  });

  it('keeps prior truth visible while reconnecting and rejects another server delta', () => {
    const store = new TaskCatalogStore();
    publish(store);
    store.markReconnecting();
    expect(store.getSnapshot().projection?.tasks.has('task-1')).toBe(true);
    expect(
      store.applyDeltaBatch(
        delta(
          0,
          1,
          [
            {
              catalogVersion: 1,
              entityId: 'task-1',
              entityKind: 'task',
              kind: 'remove',
              serverInstanceId: 'server-b',
            },
          ],
          'server-b',
        ),
      ),
    ).toBe('stale');
    expect(store.getSnapshot().staleReason).toBe('server-restarted');
  });
});

describe('TaskCatalogRuntime', () => {
  it('contains throwing live cleanup during replacement, detach, and disposal', () => {
    const transport: TaskCatalogClientFacade = {
      getDeltasSince: vi.fn(),
      getManifest: vi.fn(),
      getPage: vi.fn(),
    };
    const firstCleanup = vi.fn(() => {
      throw new Error('first cleanup failed');
    });
    const secondCleanup = vi.fn(() => {
      throw new Error('second cleanup failed');
    });
    const thirdCleanup = vi.fn(() => {
      throw new Error('third cleanup failed');
    });
    const runtime = new TaskCatalogRuntime({
      liveEvents: { subscribe: vi.fn(() => firstCleanup) },
      transport,
    });

    let detachSecond = (): void => undefined;
    expect(() => {
      detachSecond = runtime.connectLiveEvents({ subscribe: vi.fn(() => secondCleanup) });
    }).not.toThrow();
    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(detachSecond).not.toThrow();
    expect(secondCleanup).toHaveBeenCalledOnce();

    runtime.connectLiveEvents({ subscribe: vi.fn(() => thirdCleanup) });
    expect(() => runtime.dispose()).not.toThrow();
    expect(thirdCleanup).toHaveBeenCalledOnce();
  });

  it('contains cleanup returned after a subscription destroys the runtime synchronously', () => {
    const runtime = new TaskCatalogRuntime({
      transport: {
        getDeltasSince: vi.fn(),
        getManifest: vi.fn(),
        getPage: vi.fn(),
      },
    });
    const cleanup = vi.fn(() => {
      throw new Error('late cleanup failed');
    });

    expect(() =>
      runtime.connectLiveEvents({
        subscribe: vi.fn(() => {
          runtime.dispose();
          return cleanup;
        }),
      }),
    ).not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('fetches bounded pages in kind order and yields between non-final pages', async () => {
    const currentManifest = manifest({ project: 50 });
    const projects = Array.from({ length: 50 }, (_, index) => project(`project-${index}`));
    const getPage = vi.fn<TaskCatalogClientFacade['getPage']>(async (pageRequest) => {
      const items =
        pageRequest.kind === 'project' ? projects : pageRequest.kind === 'task' ? [task()] : [];
      return { kind: 'found', value: page(currentManifest, pageRequest.kind, items) };
    });
    const yieldBetweenPages = vi.fn(async () => undefined);
    const runtime = new TaskCatalogRuntime({
      transport: {
        getDeltasSince: async (deltaRequest) => ({
          kind: 'found',
          value: {
            events: [],
            fromCatalogVersion: deltaRequest.catalogVersion,
            serverInstanceId: deltaRequest.serverInstanceId,
            toCatalogVersion: deltaRequest.catalogVersion,
          },
        }),
        getManifest: async () => ({ kind: 'found', value: currentManifest }),
        getPage,
      },
      yieldBetweenPages,
    });

    await runtime.refresh();

    expect(getPage).toHaveBeenCalledTimes(4);
    expect(yieldBetweenPages).not.toHaveBeenCalled();
    expect(runtime.store.getSnapshot().status).toBe('ready');
  });

  it('wires live connection state, coalesces resync storms, and preserves visible truth', async () => {
    const currentManifest = manifest();
    const listeners = new Set<(message: unknown) => void>();
    const emit = (message: unknown) => {
      for (const listener of listeners) {
        listener(message);
      }
    };
    const stop = vi.fn();
    const liveEvents: TaskCatalogLiveEventSource = {
      subscribe: vi.fn((nextListener) => {
        listeners.add(nextListener);
        return () => {
          listeners.delete(nextListener);
          stop();
        };
      }),
    };
    const getManifest = vi.fn<TaskCatalogClientFacade['getManifest']>(async () => ({
      kind: 'found',
      value: currentManifest,
    }));
    const runtime = new TaskCatalogRuntime({
      liveEvents,
      transport: {
        getDeltasSince: async (deltaRequest) => ({
          kind: 'found',
          value: {
            events: [],
            fromCatalogVersion: deltaRequest.catalogVersion,
            serverInstanceId: deltaRequest.serverInstanceId,
            toCatalogVersion: deltaRequest.catalogVersion,
          },
        }),
        getManifest,
        getPage: async (pageRequest) => ({
          kind: 'found',
          value: page(
            currentManifest,
            pageRequest.kind,
            pageRequest.kind === 'project'
              ? [project()]
              : pageRequest.kind === 'task'
                ? [task()]
                : [],
          ),
        }),
      },
    });

    emit({ kind: 'connection-state', state: 'connected' });
    await runtime.requestResync();
    expect(runtime.store.getSnapshot().status).toBe('ready');
    expect(getManifest).toHaveBeenCalledOnce();

    emit({
      batch: delta(4, 5, [
        {
          catalogVersion: 5,
          entity: task({ name: 'Live rename' }),
          entityKind: 'task',
          kind: 'replace',
          serverInstanceId: 'server-a',
        },
      ]),
      kind: 'catalog-delta',
    });
    expect(runtime.store.getSnapshot().projection?.tasks.get('task-1')?.name).toBe('Live rename');
    expect(getManifest).toHaveBeenCalledOnce();

    emit({ malformed: true });
    emit({ malformed: true });
    await runtime.requestResync();
    expect(getManifest).toHaveBeenCalledTimes(2);
    expect(runtime.store.getSnapshot().projection?.tasks.has('task-1')).toBe(true);

    emit({ kind: 'connection-state', state: 'disconnected' });
    expect(runtime.store.getSnapshot()).toMatchObject({ status: 'reconnecting' });
    expect(runtime.store.getSnapshot().projection?.tasks.has('task-1')).toBe(true);
    emit({ kind: 'connection-state', state: 'connected' });
    await runtime.requestResync();
    expect(getManifest).toHaveBeenCalledTimes(3);
    expect(runtime.store.getSnapshot().status).toBe('ready');

    runtime.dispose();
    expect(stop).toHaveBeenCalledOnce();
    emit({ kind: 'connection-state', state: 'connected' });
    await runtime.requestResync();
    expect(getManifest).toHaveBeenCalledTimes(3);
  });
});
