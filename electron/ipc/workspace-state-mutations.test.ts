import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageEnv } from './storage.js';
import {
  WorkspaceMutationDurabilityError,
  WorkspaceMutationNotCommittedError,
  WorkspaceMutationRecoveryError,
  WorkspaceMutationService,
  WorkspaceProtectedFieldConflictError,
  WorkspaceRevisionConflictError,
  activateProtectedPolicyForTest,
  changed,
  type WorkspaceHostMutationSlices,
  unchanged,
} from './workspace-state-mutations.js';
import {
  createStandaloneWorkspaceStateStorage,
  type JsonObject,
  type WorkspaceStateStorage,
} from './workspace-state-storage.js';

const roots: string[] = [];
const storages: WorkspaceStateStorage[] = [];

function createEnv(): StorageEnv {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-workspace-mutation-'));
  roots.push(userDataPath);
  return { isPackaged: true, userDataPath };
}

async function createService(
  env: StorageEnv,
  options: ConstructorParameters<typeof WorkspaceMutationService>[1] = {},
  storageOptions: Parameters<typeof createStandaloneWorkspaceStateStorage>[1] = {},
): Promise<WorkspaceMutationService> {
  const storage = await createStandaloneWorkspaceStateStorage(env, storageOptions);
  storages.push(storage);
  return new WorkspaceMutationService(storage, options);
}

afterEach(async () => {
  await Promise.allSettled(storages.splice(0).map((storage) => storage.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('workspace mutation authority', () => {
  it('inspects a detached snapshot without writing, publishing, or advancing revision', async () => {
    const env = createEnv();
    const prepare = vi.fn();
    const emit = vi.fn();
    const service = await createService(env, {
      emitWorkspaceStateChanged: emit,
      prepareProjections: prepare,
    });
    const authority = service.createPrivateMutationAuthority();

    const inspected = await authority.inspect({ operation: 'inspect-detached' }, (slices) => {
      (slices.sharedState as JsonObject).forged = true;
      (slices.privateState as JsonObject).forged = true;
      return slices;
    });

    expect(inspected).toMatchObject({
      privateState: { forged: true },
      sharedRevision: 0,
      sharedState: { forged: true },
      storageGeneration: '0',
    });
    await expect(
      authority.inspect({ operation: 'inspect-again' }, (slices) => ({
        privateState: slices.privateState,
        revision: slices.sharedRevision,
        sharedState: slices.sharedState,
      })),
    ).resolves.toMatchObject({
      privateState: {},
      revision: 0,
      sharedState: {
        collapsedTaskOrder: [],
        projects: [],
        taskOrder: [],
        tasks: {},
      },
    });
    expect(fs.existsSync(path.join(env.userDataPath, 'workspace-state.json'))).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects promptly while a commit is in flight, then inspects only settled truth', async () => {
    const env = createEnv();
    let releaseCommit: (() => void) | undefined;
    let signalRename: (() => void) | undefined;
    const commitHeld = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const renamed = new Promise<void>((resolve) => {
      signalRename = resolve;
    });
    const service = await createService(
      env,
      {},
      {
        faultInjector: async (point) => {
          if (point !== 'after-rename') return;
          signalRename?.();
          await commitHeld;
        },
      },
    );
    const observer = await createService(env);
    const authority = observer.createPrivateMutationAuthority();
    const mutation = service.replaceSharedState(
      { operation: 'held-commit' },
      { tasks: { 'task-1': { id: 'task-1' } } },
      undefined,
    );
    await renamed;

    const duringCommitInspector = vi.fn(
      (slices: Readonly<WorkspaceHostMutationSlices>) => slices.sharedRevision,
    );
    await expect(
      authority.inspect({ operation: 'during-commit' }, duringCommitInspector),
    ).rejects.toThrow('Workspace mutation is in flight');
    expect(duringCommitInspector).not.toHaveBeenCalled();

    releaseCommit?.();
    await expect(mutation).resolves.toMatchObject({ revision: 1 });
    await expect(
      authority.inspect({ operation: 'after-commit' }, (slices) => ({
        revision: slices.sharedRevision,
        tasks: slices.sharedState.tasks,
      })),
    ).resolves.toEqual({
      revision: 1,
      tasks: { 'task-1': { id: 'task-1' } },
    });
  });

  it('revalidates a tentative inspection in the next queued mutation', async () => {
    const service = await createService(createEnv());
    const authority = service.createPrivateMutationAuthority();
    const tentative = await authority.inspect(
      { operation: 'tentative' },
      (slices) => slices.sharedRevision,
    );
    expect(tentative).toBe(0);
    await service.replaceSharedState(
      { operation: 'intervening-write' },
      { tasks: { 'task-1': { id: 'task-1' } } },
      undefined,
    );

    await expect(
      authority.mutate({ operation: 'revalidate' }, (slices) => {
        expect(slices.sharedRevision).toBe(1);
        expect(slices.sharedState).toMatchObject({ tasks: { 'task-1': { id: 'task-1' } } });
        return unchanged('revalidated');
      }),
    ).resolves.toEqual({ changed: false, result: 'revalidated', revision: 1 });
  });

  it('returns unchanged at the current revision without writing, projecting, invalidating, or emitting', async () => {
    const env = createEnv();
    const prepare = vi.fn();
    const invalidate = vi.fn();
    const emit = vi.fn();
    const service = await createService(env, {
      emitWorkspaceStateChanged: emit,
      invalidateSharedStateCaches: invalidate,
      prepareProjections: prepare,
    });

    const result = await service.mutateWorkspaceState(
      { expectedSharedRevision: 0, operation: 'read-only' },
      (sharedState) => {
        expect(sharedState).toEqual({
          collapsedTaskOrder: [],
          projects: [],
          taskOrder: [],
          tasks: {},
        });
        return unchanged('same');
      },
    );

    expect(result).toEqual({ changed: false, result: 'same', revision: 0 });
    expect(fs.existsSync(path.join(env.userDataPath, 'workspace-state.json'))).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('increments shared revision and host generation exactly once, then publishes exact committed state', async () => {
    const env = createEnv();
    const order: string[] = [];
    const publish = vi.fn((prepared: unknown) => {
      expect(prepared).toEqual({ taskNames: ['task-1'] });
      order.push('publish');
    });
    const service = await createService(env, {
      emitWorkspaceStateChanged: (payload) => {
        expect(payload).toEqual({ revision: 1, savedAt: 123, sourceId: 'client-1' });
        order.push('event');
      },
      invalidateSharedStateCaches: () => {
        order.push('invalidate');
      },
      now: () => 123,
      prepareProjections: (proposed, changes) => {
        expect(changes).toEqual({ localChanged: false, privateChanged: true, sharedChanged: true });
        expect(proposed.sharedRevision).toBe(1);
        expect(proposed.storageGeneration).toBe('1');
        order.push('prepare');
        return { sharedProjection: { taskNames: Object.keys(proposed.sharedState.tasks ?? {}) } };
      },
      publishSharedProjection: publish,
    });

    const result = await service.mutateWorkspaceState(
      { expectedSharedRevision: 0, operation: 'add-fixture', sourceId: 'client-1' },
      () => changed({ nextSharedState: { tasks: { 'task-1': { id: 'task-1' } } } }, 'ok'),
    );

    expect(result).toEqual({ changed: true, result: 'ok', revision: 1 });
    expect(order).toEqual(['prepare', 'publish', 'invalidate', 'event']);
    expect((await service.storage.loadCurrent()).record).toMatchObject({
      sharedRevision: 1,
      sharedState: { tasks: { 'task-1': { id: 'task-1' } } },
      storageGeneration: '1',
    });
  });

  it('checks stale revision before invoking the pure mutator', async () => {
    const service = await createService(createEnv());
    await service.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'first' },
      { tasks: {} },
      undefined,
    );
    const mutator = vi.fn(() => unchanged(undefined));

    await expect(
      service.mutateWorkspaceState({ expectedSharedRevision: 0, operation: 'stale' }, mutator),
    ).rejects.toBeInstanceOf(WorkspaceRevisionConflictError);
    expect(mutator).not.toHaveBeenCalled();
    expect((await service.storage.loadCurrent()).record.sharedRevision).toBe(1);
  });

  it('serializes concurrent writers across service instances sharing one canonical identity', async () => {
    const env = createEnv();
    const first = await createService(env);
    const second = await createService(env);

    const [firstResult, secondResult] = await Promise.all([
      first.mutateWorkspaceState({ operation: 'first' }, (state) =>
        changed({ nextSharedState: { ...state, first: true } }, 'first'),
      ),
      second.mutateWorkspaceState({ operation: 'second' }, (state) =>
        changed({ nextSharedState: { ...state, second: true } }, 'second'),
      ),
    ]);

    expect([firstResult.revision, secondResult.revision].sort()).toEqual([1, 2]);
    expect((await first.storage.loadCurrent()).record).toMatchObject({
      sharedRevision: 2,
      sharedState: { first: true, second: true },
      storageGeneration: '2',
    });
  });

  it('prepares every projection before persistence and leaves the primary untouched on prepare failure', async () => {
    const env = createEnv();
    const service = await createService(env, {
      prepareProjections: () => {
        throw new Error('invalid projection');
      },
    });

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 0, operation: 'invalid' },
        { tasks: {} },
        undefined,
      ),
    ).rejects.toThrow('invalid projection');
    expect(fs.existsSync(path.join(env.userDataPath, 'workspace-state.json'))).toBe(false);
  });

  it('returns committed success with a repair warning when a non-authoritative publication fails', async () => {
    const env = createEnv();
    const degraded = vi.fn();
    const emitted = vi.fn();
    const service = await createService(env, {
      emitWorkspaceStateChanged: emitted,
      markProjectionDegraded: degraded,
      prepareProjections: () => ({ sharedProjection: { valid: true } }),
      publishSharedProjection: () => {
        throw new Error('projection unavailable');
      },
    });

    const result = await service.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'committed' },
      { tasks: {} },
      'done',
    );

    expect(result).toMatchObject({
      changed: true,
      result: 'done',
      revision: 1,
      warning: {
        code: 'projection-repair-required',
        messages: ['shared projection: projection unavailable'],
      },
    });
    expect(degraded).toHaveBeenCalledWith(['shared projection: projection unavailable']);
    expect(emitted).toHaveBeenCalledOnce();
    expect((await service.storage.loadCurrent()).record.sharedRevision).toBe(1);
  });

  it('reports response loss only after the durable commit and all publication handoffs', async () => {
    const env = createEnv();
    const emitted = vi.fn();
    const service = await createService(env, {
      emitWorkspaceStateChanged: emitted,
      faultInjector: () => {
        throw new Error('response lost');
      },
    });

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 0, operation: 'lost-response' },
        { tasks: {} },
        undefined,
      ),
    ).rejects.toThrow('response lost');
    expect(emitted).toHaveBeenCalledOnce();
    expect((await service.storage.loadCurrent()).record.sharedRevision).toBe(1);
    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 0, operation: 'retry' },
        { tasks: {} },
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceRevisionConflictError);
  });
});

describe('protected workspace policies', () => {
  it('keeps every protected policy inactive in the foundation record', async () => {
    const service = await createService(createEnv());
    await service.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed' },
      {
        taskOrder: ['task-1'],
        tasks: { 'task-1': { id: 'task-1', notes: 'canonical', worktreePath: '/one' } },
      },
      undefined,
    );

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 1, operation: 'legacy-edit' },
        {
          taskOrder: ['task-2'],
          tasks: { 'task-2': { id: 'task-2', notes: 'changed', worktreePath: '/two' } },
        },
        undefined,
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('rejects same-revision omission or changes once a named policy activates', async () => {
    const service = await createService(createEnv());
    await service.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed' },
      { tasks: { 'task-1': { id: 'task-1', name: 'Old', notes: 'canonical' } } },
      undefined,
    );
    const privateAuthority = service.createPrivateMutationAuthority();
    await privateAuthority.mutate({ operation: 'activate-notes' }, (slices) =>
      changed(
        {
          nextPrivateState: activateProtectedPolicyForTest(slices.privateState, 'task-notes'),
        },
        undefined,
      ),
    );

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 1, operation: 'omit-notes' },
        { tasks: { 'task-1': { id: 'task-1', name: 'New' } } },
        undefined,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceProtectedFieldConflictError>>({
        code: 'workspace-protected-field-conflict',
        policyId: 'task-notes',
      }),
    );
    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 1, operation: 'change-notes' },
        { tasks: { 'task-1': { id: 'task-1', name: 'New', notes: 'forged' } } },
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceProtectedFieldConflictError);
    expect((await service.storage.loadCurrent()).record.sharedRevision).toBe(1);
  });

  it('accepts an exact protected echo while allowing an unprotected edit', async () => {
    const service = await createService(createEnv());
    await service.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed' },
      { tasks: { 'task-1': { id: 'task-1', name: 'Old', notes: 'canonical' } } },
      undefined,
    );
    await service.createPrivateMutationAuthority().mutate({ operation: 'activate' }, (slices) =>
      changed(
        {
          nextPrivateState: activateProtectedPolicyForTest(slices.privateState, 'task-notes'),
        },
        undefined,
      ),
    );

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 1, operation: 'rename' },
        { tasks: { 'task-1': { id: 'task-1', name: 'New', notes: 'canonical' } } },
        undefined,
      ),
    ).resolves.toMatchObject({ revision: 2 });
    expect((await service.storage.loadCurrent()).record.sharedState).toEqual({
      tasks: { 'task-1': { id: 'task-1', name: 'New', notes: 'canonical' } },
    });
  });

  it('leaves merge progress writable while inactive and protects its full top-level projection once active', async () => {
    const service = await createService(createEnv());
    const canonicalProgress = {
      schemaVersion: 1,
      version: 2,
      dateKey: '2026-08-04',
      tasksToday: 3,
      linesAdded: 20,
      linesRemoved: 4,
      updatedAt: '2026-08-04T08:00:00.000Z',
    };
    const canonicalMarker = {
      committedAt: '2026-08-04T08:00:00.000Z',
      operationId: 'operation-2',
      progressVersion: 2,
      taskId: 'task-2',
    };
    const canonicalState = {
      committedMergeOperationId: 'operation-2',
      completedTaskCount: 3,
      completedTaskDate: '2026-08-04',
      mergeOperation: canonicalMarker,
      mergeProgress: canonicalProgress,
      mergedLinesAdded: 20,
      mergedLinesRemoved: 4,
      theme: 'dark',
    };

    await service.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed-legacy-progress-writer' },
      canonicalState,
      undefined,
    );
    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 1, operation: 'inactive-legacy-progress-edit' },
        {
          ...canonicalState,
          completedTaskCount: 99,
          mergeProgress: { ...canonicalProgress, tasksToday: 99 },
        },
        undefined,
      ),
    ).resolves.toMatchObject({ revision: 2 });

    await service
      .createPrivateMutationAuthority()
      .mutate({ operation: 'activate-merge-progress' }, (slices) =>
        changed(
          {
            nextPrivateState: activateProtectedPolicyForTest(slices.privateState, 'merge-progress'),
          },
          undefined,
        ),
      );
    const activatedState = (await service.storage.loadCurrent()).record.sharedState;

    for (const forged of [
      { ...activatedState, committedMergeOperationId: 'forged-operation' },
      { ...activatedState, completedTaskCount: 100 },
      { ...activatedState, completedTaskDate: '2026-08-03' },
      {
        ...activatedState,
        mergeProgress: {
          ...(activatedState.mergeProgress as Record<string, unknown>),
          tasksToday: 100,
        },
      },
      {
        ...activatedState,
        mergeOperation: {
          ...(activatedState.mergeOperation as Record<string, unknown>),
          operationId: 'forged-operation',
        },
      },
      { ...activatedState, mergedLinesAdded: 100 },
      { ...activatedState, mergedLinesRemoved: 100 },
    ]) {
      await expect(
        service.replaceSharedState(
          { expectedSharedRevision: 2, operation: 'forged-progress' },
          forged,
          undefined,
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<WorkspaceProtectedFieldConflictError>>({
          code: 'workspace-protected-field-conflict',
          policyId: 'merge-progress',
        }),
      );
    }

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 2, operation: 'exact-progress-echo' },
        { ...activatedState, theme: 'light' },
        undefined,
      ),
    ).resolves.toMatchObject({ revision: 3 });
    expect((await service.storage.loadCurrent()).record.sharedState).toEqual({
      ...activatedState,
      theme: 'light',
    });
  });

  it('evaluates stale revision before protected-field forgery', async () => {
    const service = await createService(createEnv());
    await service.replaceSharedState(
      { expectedSharedRevision: 0, operation: 'seed' },
      { tasks: { 'task-1': { id: 'task-1', notes: 'canonical' } } },
      undefined,
    );
    await service.createPrivateMutationAuthority().mutate({ operation: 'activate' }, (slices) =>
      changed(
        {
          nextPrivateState: activateProtectedPolicyForTest(slices.privateState, 'task-notes'),
        },
        undefined,
      ),
    );

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 0, operation: 'stale-forgery' },
        { tasks: { 'task-1': { id: 'task-1', notes: 'forged' } } },
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceRevisionConflictError);
  });
});

describe('mutation commit classification', () => {
  it('surfaces exact-prior write failure as safe not-committed', async () => {
    const env = createEnv();
    const service = await createService(
      env,
      {},
      {
        faultInjector: (point) => {
          if (point === 'after-temporary-write') throw new Error('write failed');
        },
      },
    );

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 0, operation: 'write-failure' },
        { tasks: {} },
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceMutationNotCommittedError);
    expect((await service.storage.loadCurrent()).record.sharedRevision).toBe(0);
  });

  it('blocks publication and later mutations while exact proposal durability is pending', async () => {
    const env = createEnv();
    let injectFailure = true;
    const emit = vi.fn();
    const service = await createService(
      env,
      { emitWorkspaceStateChanged: emit },
      {
        faultInjector: (point) => {
          if (injectFailure && point === 'after-rename')
            throw new Error('directory fsync unavailable');
        },
      },
    );

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 0, operation: 'pending' },
        { tasks: {} },
        'committed-result',
      ),
    ).rejects.toBeInstanceOf(WorkspaceMutationDurabilityError);
    expect(emit).not.toHaveBeenCalled();
    const observer = await createService(env);
    const pendingInspector = vi.fn(
      (slices: Readonly<WorkspaceHostMutationSlices>) => slices.sharedRevision,
    );
    await expect(
      observer
        .createPrivateMutationAuthority()
        .inspect({ operation: 'inspect-pending' }, pendingInspector),
    ).rejects.toBeInstanceOf(WorkspaceMutationDurabilityError);
    expect(pendingInspector).not.toHaveBeenCalled();
    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 1, operation: 'blocked' },
        { tasks: {} },
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceMutationDurabilityError);

    injectFailure = false;
    await expect(service.repairPendingDurability()).resolves.toEqual({
      changed: true,
      result: 'committed-result',
      revision: 1,
    });
    expect(emit).toHaveBeenCalledOnce();
    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 1, operation: 'after-repair' },
        { tasks: {} },
        undefined,
      ),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it('blocks all mutations when startup detects primary recovery ambiguity', async () => {
    const env = createEnv();
    fs.writeFileSync(path.join(env.userDataPath, 'workspace-state.json'), '{corrupt');
    const service = await createService(env);

    await expect(
      service.replaceSharedState(
        { expectedSharedRevision: 0, operation: 'blocked' },
        { tasks: {} },
        undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceMutationRecoveryError);
    const corruptInspector = vi.fn(
      (slices: Readonly<WorkspaceHostMutationSlices>) => slices.sharedRevision,
    );
    await expect(
      service
        .createPrivateMutationAuthority()
        .inspect({ operation: 'inspect-corrupt' }, corruptInspector),
    ).rejects.toBeInstanceOf(WorkspaceMutationRecoveryError);
    expect(corruptInspector).not.toHaveBeenCalled();
  });

  it('rejects asynchronous trusted mutators before any host write', async () => {
    const service = await createService(createEnv());
    const authority = service.createPrivateMutationAuthority();
    await expect(
      authority.mutate({ operation: 'async' }, (() =>
        Promise.resolve(unchanged(undefined))) as unknown as Parameters<
        typeof authority.mutate
      >[1]),
    ).rejects.toThrow('pure and synchronous');
    expect((await service.storage.loadCurrent()).record.sharedRevision).toBe(0);
  });
});
