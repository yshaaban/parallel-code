import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { StorageEnv } from './storage.js';
import {
  WORKSPACE_HOST_ENVELOPE_KEY,
  canonicalJsonStringify,
  createElectronWorkspaceStateStorage,
  createStandaloneWorkspaceStateStorage,
  createWorkspaceHostRecord,
  decodeWorkspaceHostRecord,
  encodeWorkspaceHostRecord,
  incrementCanonicalUint64,
  parseCanonicalUint64,
  type JsonObject,
  type WorkspaceStateStorage,
  type WorkspaceStorageFaultPoint,
} from './workspace-state-storage.js';

const roots: string[] = [];
const openStorages: WorkspaceStateStorage[] = [];

function createEnv(): StorageEnv {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-workspace-storage-'));
  roots.push(userDataPath);
  return { isPackaged: true, userDataPath };
}

function statePath(env: StorageEnv, kind: 'electron' | 'standalone'): string {
  return path.join(env.userDataPath, kind === 'electron' ? 'state.json' : 'workspace-state.json');
}

async function standalone(
  env: StorageEnv,
  faultInjector?: (point: WorkspaceStorageFaultPoint) => void,
): Promise<WorkspaceStateStorage> {
  const storage = await createStandaloneWorkspaceStateStorage(env, {
    ...(faultInjector ? { faultInjector } : {}),
  });
  openStorages.push(storage);
  return storage;
}

async function electron(env: StorageEnv): Promise<WorkspaceStateStorage> {
  const storage = await createElectronWorkspaceStateStorage(env);
  openStorages.push(storage);
  return storage;
}

function nextRecord(
  storage: WorkspaceStateStorage,
  prior: Awaited<ReturnType<WorkspaceStateStorage['loadCurrent']>>,
  sharedState: JsonObject,
) {
  return createWorkspaceHostRecord({
    adapterKind: storage.kind,
    localState: prior.record.localState,
    privateState: prior.record.privateState,
    sharedRevision: prior.record.sharedRevision + 1,
    sharedState,
    storageGeneration: incrementCanonicalUint64(prior.record.storageGeneration),
  });
}

afterEach(async () => {
  await Promise.allSettled(openStorages.splice(0).map((storage) => storage.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('workspace host canonical envelope', () => {
  it('sorts object keys by UTF-8 bytes while preserving array order and normalizing negative zero', () => {
    expect(canonicalJsonStringify({ z: -0, a: [{ y: true, x: null }, 'second'] })).toBe(
      '{"a":[{"x":null,"y":true},"second"],"z":0}',
    );
  });

  it('accepts only canonical uint64 encodings and rejects overflow', () => {
    expect(parseCanonicalUint64('0')).toBe('0');
    expect(parseCanonicalUint64('18446744073709551615')).toBe('18446744073709551615');
    expect(() => parseCanonicalUint64('01')).toThrow('canonical unsigned decimal');
    expect(() => parseCanonicalUint64('+1')).toThrow('canonical unsigned decimal');
    expect(() => parseCanonicalUint64('18446744073709551616')).toThrow('exceeds uint64');
    expect(() => incrementCanonicalUint64(parseCanonicalUint64('18446744073709551615'))).toThrow(
      'overflow',
    );
  });

  it('rejects a digest that does not cover the complete canonical host payload', () => {
    const record = createWorkspaceHostRecord({
      adapterKind: 'standalone',
      privateState: { protected: true },
      sharedRevision: 4,
      sharedState: { tasks: {} },
      storageGeneration: parseCanonicalUint64('8'),
    });
    const encoded = encodeWorkspaceHostRecord(record);
    const root = JSON.parse(encoded) as Record<string, unknown>;
    const envelope = root[WORKSPACE_HOST_ENVELOPE_KEY] as Record<string, unknown>;
    envelope.storageGeneration = '9';

    expect(() => decodeWorkspaceHostRecord(JSON.stringify(root), 'standalone')).toThrow(
      'payloadDigest does not match',
    );
  });
});

describe('workspace storage adapters', () => {
  it('starts a new host with the complete canonical empty workspace shape', async () => {
    const storage = await standalone(createEnv());

    expect((await storage.startup()).kind).toBe('ready');
    expect((await storage.loadCurrent()).record.sharedState).toEqual({
      collapsedTaskOrder: [],
      projects: [],
      taskOrder: [],
      tasks: {},
    });
  });

  it('migrates a legacy standalone record to generation 1 without changing shared shape', async () => {
    const env = createEnv();
    fs.writeFileSync(
      statePath(env, 'standalone'),
      JSON.stringify({ revision: 7, state: { projects: [], taskOrder: [], tasks: {} } }),
    );
    const storage = await standalone(env);
    const startup = await storage.startup();
    expect(startup.kind).toBe('ready');
    const prior = await storage.loadCurrent();
    expect(prior).toMatchObject({
      primaryExists: true,
      source: 'legacy-primary',
      record: { sharedRevision: 7, storageGeneration: '0' },
    });

    const proposed = nextRecord(storage, prior, prior.record.sharedState);
    const committed = await storage.commitHostRecord(prior, proposed);
    expect(committed.kind).toBe('committed');
    const decoded = decodeWorkspaceHostRecord(
      fs.readFileSync(statePath(env, 'standalone'), 'utf8'),
      'standalone',
    );
    expect(decoded).toMatchObject({
      legacy: false,
      record: {
        sharedRevision: 8,
        sharedState: { projects: [], taskOrder: [], tasks: {} },
        storageGeneration: '1',
      },
    });
  });

  it('uses legacy state.json only as the generation-zero standalone fallback', async () => {
    const env = createEnv();
    fs.writeFileSync(
      statePath(env, 'electron'),
      JSON.stringify({
        projects: [],
        taskOrder: ['task-1'],
        tasks: { 'task-1': { id: 'task-1' } },
      }),
    );
    const storage = await standalone(env);

    const startup = await storage.startup();
    expect(startup).toMatchObject({
      kind: 'ready',
      snapshot: {
        primaryExists: false,
        source: 'legacy-fallback',
        record: { sharedRevision: 0, storageGeneration: '0' },
      },
    });
    const prior = await storage.loadCurrent();
    const proposed = nextRecord(storage, prior, prior.record.sharedState);
    expect((await storage.commitHostRecord(prior, proposed)).kind).toBe('committed');
    expect(fs.existsSync(statePath(env, 'standalone'))).toBe(true);
    expect(
      decodeWorkspaceHostRecord(fs.readFileSync(statePath(env, 'electron'), 'utf8'), 'electron')
        .legacy,
    ).toBe(true);
  });

  it('migrates Electron in place and preserves local fields in the same state.json', async () => {
    const env = createEnv();
    fs.writeFileSync(
      statePath(env, 'electron'),
      JSON.stringify({
        activeTaskId: 'task-1',
        projects: [],
        taskOrder: ['task-1'],
        tasks: { 'task-1': { id: 'task-1', name: 'One' } },
        terminals: { shell: { id: 'shell' } },
        windowState: { height: 700, width: 900 },
      }),
    );
    const storage = await electron(env);
    expect((await storage.startup()).kind).toBe('ready');
    const prior = await storage.loadCurrent();
    expect(prior.record.sharedState).toMatchObject({
      projects: [],
      taskOrder: ['task-1'],
      tasks: { 'task-1': { id: 'task-1', name: 'One' } },
    });
    expect(prior.record.localState).toMatchObject({
      activeTaskId: 'task-1',
      terminals: { shell: { id: 'shell' } },
      windowState: { height: 700, width: 900 },
    });

    const proposed = nextRecord(storage, prior, {
      ...prior.record.sharedState,
      committedMergeOperationId: 'operation-2',
      completedTaskCount: 2,
      mergeOperation: {
        committedAt: '2026-08-04T08:00:00.000Z',
        operationId: 'operation-2',
        progressVersion: 2,
        taskId: 'task-1',
      },
      mergeProgress: {
        schemaVersion: 1,
        version: 2,
        dateKey: '2026-08-04',
        tasksToday: 2,
        linesAdded: 8,
        linesRemoved: 3,
        updatedAt: '2026-08-04T08:00:00.000Z',
      },
    });
    expect((await storage.commitHostRecord(prior, proposed)).kind).toBe('committed');
    expect(fs.existsSync(path.join(env.userDataPath, 'workspace-state.json'))).toBe(false);
    const committed = (await storage.loadCurrent()).record;
    expect(committed.sharedState).toMatchObject({
      committedMergeOperationId: 'operation-2',
      mergeOperation: { operationId: 'operation-2', progressVersion: 2 },
      mergeProgress: { version: 2, tasksToday: 2, linesAdded: 8, linesRemoved: 3 },
    });
    expect(committed.localState).not.toHaveProperty('mergeProgress');
    expect(committed.localState).not.toHaveProperty('mergeOperation');
    const diskRoot = JSON.parse(fs.readFileSync(statePath(env, 'electron'), 'utf8')) as JsonObject;
    expect(diskRoot).toMatchObject({
      activeTaskId: 'task-1',
      committedMergeOperationId: 'operation-2',
      completedTaskCount: 2,
      mergeOperation: {
        operationId: 'operation-2',
        progressVersion: 2,
      },
      mergeProgress: {
        version: 2,
        tasksToday: 2,
        linesAdded: 8,
        linesRemoved: 3,
      },
      terminals: { shell: { id: 'shell' } },
      windowState: { height: 700, width: 900 },
    });
    expect(diskRoot[WORKSPACE_HOST_ENVELOPE_KEY]).toBeDefined();
  });

  it('produces the same logical shared record in standalone and Electron modes', async () => {
    const standaloneEnv = createEnv();
    const electronEnv = createEnv();
    const standaloneStorage = await standalone(standaloneEnv);
    const electronStorage = await electron(electronEnv);
    await standaloneStorage.startup();
    await electronStorage.startup();
    const standalonePrior = await standaloneStorage.loadCurrent();
    const electronPrior = await electronStorage.loadCurrent();
    const shared = {
      projects: [{ id: 'project-1', path: '/repo' }],
      taskOrder: ['task-1'],
      tasks: { 'task-1': { id: 'task-1', name: 'Task' } },
    };

    await standaloneStorage.commitHostRecord(
      standalonePrior,
      nextRecord(standaloneStorage, standalonePrior, shared),
    );
    await electronStorage.commitHostRecord(
      electronPrior,
      nextRecord(electronStorage, electronPrior, shared),
    );

    expect((await standaloneStorage.loadCurrent()).record.sharedState).toEqual(shared);
    expect((await electronStorage.loadCurrent()).record.sharedState).toEqual(shared);
    expect((await standaloneStorage.loadCurrent()).record.sharedRevision).toBe(1);
    expect((await electronStorage.loadCurrent()).record.sharedRevision).toBe(1);
  });
});

describe('primary-only recovery and runtime classification', () => {
  it('fails closed when primary is missing even if a valid higher temporary exists', async () => {
    const env = createEnv();
    const validTemp = createWorkspaceHostRecord({
      adapterKind: 'standalone',
      sharedRevision: 12,
      sharedState: { tasks: { newer: { id: 'newer' } } },
      storageGeneration: parseCanonicalUint64('12'),
    });
    fs.writeFileSync(`${statePath(env, 'standalone')}.tmp`, encodeWorkspaceHostRecord(validTemp));
    const storage = await standalone(env);

    const startup = await storage.startup();
    expect(startup).toMatchObject({
      kind: 'host-state-recovery-required',
      evidence: { temporary: { kind: 'valid', storageGeneration: '12' } },
    });
    expect(fs.existsSync(statePath(env, 'standalone'))).toBe(false);
    expect(fs.existsSync(`${statePath(env, 'standalone')}.tmp`)).toBe(true);
  });

  it('fails closed on a corrupt primary and never promotes a valid backup', async () => {
    const env = createEnv();
    const backup = createWorkspaceHostRecord({
      adapterKind: 'standalone',
      sharedRevision: 8,
      sharedState: { tasks: { backup: { id: 'backup' } } },
      storageGeneration: parseCanonicalUint64('8'),
    });
    fs.writeFileSync(statePath(env, 'standalone'), '{bad-json');
    fs.writeFileSync(`${statePath(env, 'standalone')}.bak`, encodeWorkspaceHostRecord(backup));
    const storage = await standalone(env);

    expect(await storage.startup()).toMatchObject({
      kind: 'host-state-recovery-required',
      evidence: { backup: { kind: 'valid', storageGeneration: '8' } },
    });
    expect(fs.readFileSync(statePath(env, 'standalone'), 'utf8')).toBe('{bad-json');
  });

  it('accepts a valid primary as sole authority even when a higher temp exists', async () => {
    const env = createEnv();
    const primary = createWorkspaceHostRecord({
      adapterKind: 'standalone',
      sharedRevision: 4,
      sharedState: { tasks: { primary: { id: 'primary' } } },
      storageGeneration: parseCanonicalUint64('4'),
    });
    const temporary = createWorkspaceHostRecord({
      adapterKind: 'standalone',
      sharedRevision: 9,
      sharedState: { tasks: { temporary: { id: 'temporary' } } },
      storageGeneration: parseCanonicalUint64('9'),
    });
    fs.writeFileSync(statePath(env, 'standalone'), encodeWorkspaceHostRecord(primary));
    fs.writeFileSync(`${statePath(env, 'standalone')}.tmp`, encodeWorkspaceHostRecord(temporary));
    const storage = await standalone(env);

    expect(await storage.startup()).toMatchObject({
      kind: 'ready',
      snapshot: { record: { sharedRevision: 4, storageGeneration: '4' } },
      evidence: { temporary: { kind: 'valid', storageGeneration: '9' } },
    });
    expect((await storage.loadCurrent()).record.sharedState).toEqual(primary.sharedState);
  });

  for (const point of [
    'after-temporary-open',
    'after-temporary-write',
    'after-temporary-fsync',
  ] as const) {
    it(`classifies ${point} failure as exact-prior not committed`, async () => {
      const env = createEnv();
      const storage = await standalone(env, (seen) => {
        if (seen === point) throw new Error(`fault:${point}`);
      });
      await storage.startup();
      const prior = await storage.loadCurrent();
      const proposed = nextRecord(storage, prior, { tasks: { proposed: { id: 'proposed' } } });

      const result = await storage.commitHostRecord(prior, proposed);
      expect(result.kind).toBe('not-committed');
      expect(fs.existsSync(statePath(env, 'standalone'))).toBe(false);
      expect((await storage.loadCurrent()).record.sharedRevision).toBe(0);
    });
  }

  it('classifies rename-before-directory-fsync failure as durability pending, then repairs exact proposal', async () => {
    const env = createEnv();
    let fail = true;
    const storage = await standalone(env, (point) => {
      if (fail && point === 'after-rename') throw new Error('lost before directory fsync');
    });
    await storage.startup();
    const prior = await storage.loadCurrent();
    const proposed = nextRecord(storage, prior, { tasks: { proposed: { id: 'proposed' } } });

    const result = await storage.commitHostRecord(prior, proposed);
    expect(result.kind).toBe('host-durability-repair-required');
    await expect(storage.loadCurrent()).rejects.toThrow('durability repair');
    fail = false;
    expect(await storage.repairDurability(proposed)).toMatchObject({
      kind: 'repaired',
      snapshot: { record: { sharedRevision: 1, storageGeneration: '1' } },
    });
    expect((await storage.loadCurrent()).record.sharedState).toEqual(proposed.sharedState);
  });

  it('classifies a lost acknowledgement after directory fsync as committed', async () => {
    const env = createEnv();
    const storage = await standalone(env, (point) => {
      if (point === 'after-directory-fsync') throw new Error('response lost');
    });
    await storage.startup();
    const prior = await storage.loadCurrent();
    const proposed = nextRecord(storage, prior, { tasks: { proposed: { id: 'proposed' } } });

    expect(await storage.commitHostRecord(prior, proposed)).toMatchObject({
      kind: 'committed',
      snapshot: { record: { sharedRevision: 1, storageGeneration: '1' } },
    });
  });

  for (const point of [
    'before-lock-release-read',
    'before-lock-release-unlink',
    'before-lock-release-directory-fsync',
  ] as const) {
    it(`retains exact lock ownership and retries close after ${point} failure`, async () => {
      const env = createEnv();
      let remainingFailures = 1;
      const storage = await standalone(env, (seen) => {
        if (seen === point && remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error(`fault:${point}`);
        }
      });
      expect((await storage.startup()).kind).toBe('ready');

      await expect(storage.close()).rejects.toThrow(`fault:${point}`);

      const blockedReplacement = await standalone(env);
      await expect(blockedReplacement.startup()).resolves.toMatchObject({
        kind: 'host-state-recovery-required',
        message: expect.stringContaining('exact retry'),
      });

      await expect(storage.close()).resolves.toBeUndefined();

      const replacement = await standalone(env);
      await expect(replacement.startup()).resolves.toMatchObject({ kind: 'ready' });
    });
  }
});
