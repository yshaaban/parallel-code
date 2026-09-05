import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { isRecord } from '../../src/lib/type-guards.js';
import {
  createShardedOperationStore,
  type ShardedOperationStore,
  type ShardedOperationStoreFaultPoint,
} from './sharded-operation-store.js';

interface TestRecord {
  key: string;
  version: number;
}

const roots: string[] = [];
const stores: ShardedOperationStore<TestRecord>[] = [];

function createRoot(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-sharded-store-'));
  roots.push(parent);
  return path.join(parent, 'operations');
}

function createStore(
  rootPath: string,
  faultInjector?: (point: ShardedOperationStoreFaultPoint) => void,
): ShardedOperationStore<TestRecord> {
  const store = createShardedOperationStore<TestRecord>({
    codec: {
      decodePayload(value) {
        if (
          !isRecord(value) ||
          typeof value.key !== 'string' ||
          !Number.isSafeInteger(value.version) ||
          (value.version as number) < 1
        ) {
          throw new Error('Invalid test record');
        }
        return { key: value.key, version: value.version as number };
      },
      getCanonicalKey: (record) => record.key,
      getChargedBytes: () => 1,
      getRecordVersion: (record) => record.version,
    },
    ...(faultInjector ? { faultInjector } : {}),
    journalKind: 'ownership-test',
    limits: {
      maxChargedBytes: 1_024,
      maxIndexBytes: 1_048_576,
      maxRecordCount: 1_024,
      maxRecordEnvelopeBytes: 1_048_576,
    },
    rootPath,
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe('sharded operation store process-lock ownership', () => {
  for (const point of [
    'before-lock-release-read',
    'before-lock-release-unlink',
    'before-lock-release-directory-fsync',
  ] as const) {
    it(`retains exact lock ownership and retries close after ${point} failure`, async () => {
      const rootPath = createRoot();
      let remainingFailures = 1;
      const store = createStore(rootPath, (seen) => {
        if (seen === point && remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error(`fault:${point}`);
        }
      });
      await expect(store.activateFresh()).resolves.toMatchObject({ health: 'healthy' });

      const firstClose = store.close();
      expect(store.close()).toBe(firstClose);
      await expect(firstClose).rejects.toThrow(`fault:${point}`);

      const blockedReplacement = createStore(rootPath);
      await expect(blockedReplacement.startup()).rejects.toThrow('exact retry');

      await expect(store.close()).resolves.toBeUndefined();

      const replacement = createStore(rootPath);
      await expect(replacement.startup()).resolves.toMatchObject({ health: 'healthy' });
    });
  }
});
