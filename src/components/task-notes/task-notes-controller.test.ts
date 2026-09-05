import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GetTaskNotesResult,
  IssueTaskNotesOperationResult,
  TaskNotesSnapshot,
  TaskNotesWireResponse,
  UpdateTaskNotesResult,
} from '../../domain/task-notes';
import { TaskNotesController } from './task-notes-controller';
import type { TaskNotesControllerOptions } from './task-notes-controller';
import { DesktopTaskNotesRegistry } from './task-notes-registry';
import type { TaskNotesTransport } from './task-notes-transport';

const TOKEN = 'A'.repeat(43);
const TOKEN_2 = `${'E'.repeat(42)}A`;
const OPERATION_ID = 'A'.repeat(22);
const SERVER_INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

function snapshot(overrides: Partial<TaskNotesSnapshot> = {}): TaskNotesSnapshot {
  return {
    taskId: 'task-1',
    taskIncarnation: TOKEN,
    notes: 'base',
    contentVersion: TOKEN,
    workspaceRevision: 1,
    ...overrides,
  };
}

function loaded(value = snapshot(), catalogVersion = 1): GetTaskNotesResult {
  return {
    kind: 'loaded',
    current: {
      relation: 'same-incarnation',
      currentNotes: { kind: 'present', snapshot: value },
      currentTask: {
        serverInstanceId: SERVER_INSTANCE_ID,
        catalogVersion,
        taskState: 'present',
        taskClosing: false,
        taskIncarnation: value.taskIncarnation,
      },
    },
  };
}

function issued(operationId = OPERATION_ID): IssueTaskNotesOperationResult {
  return {
    kind: 'issued',
    operation: {
      operationId,
      operationCapability: TOKEN,
      admitUntil: '2026-08-03T10:10:00.000Z',
      replayUntil: '2026-08-04T10:00:00.000Z',
    },
  };
}

function completed(value: TaskNotesSnapshot): UpdateTaskNotesResult {
  return {
    kind: 'completed',
    originalOutcome: {
      kind: 'saved',
      changed: true,
      committedContentVersion: value.contentVersion,
      committedWorkspaceRevision: value.workspaceRevision,
    },
    current: (loaded(value) as Extract<GetTaskNotesResult, { kind: 'loaded' }>).current,
    replayed: false,
    effectiveRetireAfter: '2026-08-04T10:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function ok<T>(result: T): TaskNotesWireResponse<T> {
  return { ok: true, result };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function options(): {
  acknowledgements: Array<{ operationId: string; operationCapability: string }>;
  value: TaskNotesControllerOptions;
} {
  const acknowledgements: Array<{ operationId: string; operationCapability: string }> = [];
  return {
    acknowledgements,
    value: {
      confirmAcknowledgements: vi.fn((confirmed: readonly (typeof acknowledgements)[number][]) => {
        for (const operation of confirmed) {
          const index = acknowledgements.findIndex(
            (candidate) => candidate.operationId === operation.operationId,
          );
          if (index >= 0) acknowledgements.splice(index, 1);
        }
      }),
      enqueueAcknowledgement: vi.fn((operation: (typeof acknowledgements)[number]) => {
        acknowledgements.push(operation);
      }),
      getAcknowledgements: () => [...acknowledgements],
    },
  };
}

describe('TaskNotesController', () => {
  beforeEach(() => vi.useRealTimers());

  it('retains edits made during a save while submitting one immutable draft', async () => {
    const updateResult = deferred<TaskNotesWireResponse<UpdateTaskNotesResult>>();
    const get = vi.fn(async () => ok(loaded()));
    const transport: TaskNotesTransport = {
      get,
      issue: vi.fn(async () => ok(issued())),
      update: vi.fn(() => updateResult.promise),
    };
    const controllerOptions = options();
    const controller = new TaskNotesController('task-1', transport, controllerOptions.value);
    await settle();

    controller.edit('submitted');
    controller.save();
    controller.edit('next draft');
    await settle();

    expect(transport.update).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'submitted', baseContentVersion: TOKEN }),
    );
    expect(controller.state.draft).toBe('next draft');

    const saved = snapshot({
      notes: 'submitted',
      contentVersion: TOKEN_2,
      workspaceRevision: 2,
    });
    updateResult.resolve({ ok: true, result: completed(saved) });
    await settle();

    expect(controller.state).toMatchObject({
      kind: 'dirty',
      draft: 'next draft',
      base: { notes: 'submitted', workspaceRevision: 2 },
    });
    expect(controllerOptions.value.enqueueAcknowledgement).toHaveBeenCalledTimes(1);
  });

  it('offers bounded completion proofs on the next Issue and clears them only after issued', async () => {
    const firstSaved = snapshot({ notes: 'first', contentVersion: TOKEN_2, workspaceRevision: 2 });
    const secondSaved = snapshot({ notes: 'second', contentVersion: TOKEN, workspaceRevision: 3 });
    const issue = vi
      .fn<TaskNotesTransport['issue']>()
      .mockResolvedValueOnce(ok(issued()))
      .mockResolvedValueOnce(ok({ kind: 'task-state-unavailable', retryAfterMs: 250 }))
      .mockResolvedValueOnce(ok(issued(`${'B'.repeat(21)}A`)));
    const update = vi
      .fn<TaskNotesTransport['update']>()
      .mockResolvedValueOnce(ok(completed(firstSaved)))
      .mockResolvedValueOnce(ok(completed(secondSaved)));
    const controllerOptions = options();
    const controller = new TaskNotesController(
      'task-1',
      { get: vi.fn(async () => ok(loaded())), issue, update },
      controllerOptions.value,
    );
    await settle();
    controller.edit('first');
    controller.save();
    await settle();
    expect(controllerOptions.acknowledgements).toEqual([
      { operationId: OPERATION_ID, operationCapability: TOKEN },
    ]);

    controller.edit('second');
    controller.save();
    await settle();
    expect(issue.mock.calls[1]?.[0].acknowledgedOperations).toEqual(
      controllerOptions.acknowledgements,
    );
    expect(controllerOptions.value.confirmAcknowledgements).not.toHaveBeenCalled();
    expect(controllerOptions.acknowledgements).toHaveLength(1);

    controller.retry();
    await settle();
    expect(issue.mock.calls[2]?.[0].acknowledgedOperations).toHaveLength(1);
    expect(controllerOptions.value.confirmAcknowledgements).toHaveBeenCalledTimes(1);
    expect(controllerOptions.acknowledgements).toEqual([
      { operationId: `${'B'.repeat(21)}A`, operationCapability: TOKEN },
    ]);
  });

  it('coalesces invalidations to one in-flight Get plus one newest follow-up', async () => {
    const second = deferred<TaskNotesWireResponse<GetTaskNotesResult>>();
    const third = deferred<TaskNotesWireResponse<GetTaskNotesResult>>();
    const get = vi
      .fn<TaskNotesTransport['get']>()
      .mockResolvedValueOnce(ok(loaded()))
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const controller = new TaskNotesController(
      'task-1',
      { get, issue: vi.fn(), update: vi.fn() },
      options().value,
    );
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.edit('local draft');

    controller.invalidate({ taskId: 'task-1', workspaceRevision: 2, sourceId: 'peer_a' });
    await settle();
    expect(get).toHaveBeenCalledTimes(2);
    controller.invalidate({ taskId: 'task-1', workspaceRevision: 3, sourceId: 'peer_b' });
    controller.invalidate({ taskId: 'task-1', workspaceRevision: 4, sourceId: 'peer_c' });

    second.resolve({
      ok: true,
      result: loaded(
        snapshot({ notes: 'remote 2', contentVersion: TOKEN_2, workspaceRevision: 2 }),
        2,
      ),
    });
    await settle();
    await settle();
    expect(get).toHaveBeenCalledTimes(3);
    third.resolve({
      ok: true,
      result: loaded(
        snapshot({ notes: 'remote 4', contentVersion: TOKEN_2, workspaceRevision: 4 }),
        4,
      ),
    });
    await settle();

    expect(controller.state).toMatchObject({
      kind: 'dirty',
      draft: 'local draft',
      external: { notes: 'remote 4', workspaceRevision: 4 },
    });
  });

  it('times out a hung Get without losing a retained draft', async () => {
    vi.useFakeTimers();
    const transport: TaskNotesTransport = {
      get: vi.fn<TaskNotesTransport['get']>(
        (_request, signal) =>
          new Promise<TaskNotesWireResponse<GetTaskNotesResult>>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      ),
      issue: vi.fn(),
      update: vi.fn(),
    };
    const controller = new TaskNotesController('task-1', transport, options().value);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(controller.state).toMatchObject({ kind: 'error', draft: '', recovery: 'retry-load' });
  });

  it('ignores stale lifecycle versions after observing task closing', async () => {
    const transport: TaskNotesTransport = {
      get: vi.fn(async () => ok(loaded())),
      issue: vi.fn(),
      update: vi.fn(),
    };
    const controller = new TaskNotesController('task-1', transport, options().value);
    await settle();
    controller.edit('keep me');
    controller.applyLifecycle({
      serverInstanceId: SERVER_INSTANCE_ID,
      catalogVersion: 5,
      taskState: 'present',
      taskClosing: true,
      taskIncarnation: TOKEN,
    });
    controller.applyLifecycle({
      serverInstanceId: SERVER_INSTANCE_ID,
      catalogVersion: 4,
      taskState: 'present',
      taskClosing: false,
      taskIncarnation: TOKEN,
    });
    expect(controller.state).toMatchObject({ kind: 'closing', draft: 'keep me' });
  });
});

describe('TaskNotesRegistry', () => {
  it('retains task-scoped drafts after unmount and installs unload protection only while dirty', async () => {
    const listeners = new Set<EventListener>();
    const target = {
      addEventListener: vi.fn((_type: string, listener: EventListener) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListener) =>
        listeners.delete(listener),
      ),
    };
    const registry = new DesktopTaskNotesRegistry({
      beforeUnloadTarget: target,
      onEntryChange: () => undefined,
    });
    const get = vi.fn(async () => ok(loaded()));
    const transport: TaskNotesTransport = {
      get,
      issue: vi.fn(),
      update: vi.fn(),
    };
    const mounted = registry.mount('task-1', transport);
    await settle();
    mounted.controller.edit('retained draft');
    expect(target.addEventListener).toHaveBeenCalledOnce();
    mounted.release();
    expect(registry.hasUnsaved('task-1')).toBe(true);
    expect(registry.get('task-1')?.state.draft).toBe('retained draft');
    const remounted = registry.mount('task-1', transport);
    await settle();
    expect(get).toHaveBeenCalledTimes(2);
    expect(remounted.controller.state.draft).toBe('retained draft');
    remounted.release();

    registry.discard('task-1');
    expect(registry.get('task-1')).toBeUndefined();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });
});
