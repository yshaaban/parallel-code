import { produce } from 'solid-js/store';
import { deleteRecordEntry } from '../lib/record-utils';
import { setStore, store } from './state';
import type { AppStore } from './types';

type KeyedSnapshotRecordKey = {
  [K in keyof AppStore]: AppStore[K] extends Record<string, unknown> ? K : never;
}[keyof AppStore];

type SnapshotRecordValue<K extends KeyedSnapshotRecordKey> =
  AppStore[K] extends Record<string, infer Value> ? Value : never;

export function setKeyedSnapshotRecordEntry<K extends KeyedSnapshotRecordKey>(
  recordKey: K,
  key: string,
  snapshot: SnapshotRecordValue<K>,
): void {
  setStore(recordKey, key as never, snapshot as never);
}

export function replaceKeyedSnapshotRecord<K extends KeyedSnapshotRecordKey>(
  recordKey: K,
  snapshots: ReadonlyArray<SnapshotRecordValue<K>>,
  getKey: (snapshot: SnapshotRecordValue<K>) => string,
): void {
  setStore(
    recordKey,
    () =>
      Object.fromEntries(snapshots.map((snapshot) => [getKey(snapshot), snapshot])) as AppStore[K],
  );
}

export function clearKeyedSnapshotRecordEntry<K extends KeyedSnapshotRecordKey>(
  recordKey: K,
  key: string,
): void {
  setStore(
    produce((state: AppStore) => {
      deleteRecordEntry(state[recordKey] as Record<string, SnapshotRecordValue<K>>, key);
    }),
  );
}

export function clearKeyedSnapshotRecordEntries<K extends KeyedSnapshotRecordKey>(
  recordKey: K,
  keys: Iterable<string>,
): void {
  setStore(
    produce((state: AppStore) => {
      const record = state[recordKey] as Record<string, SnapshotRecordValue<K>>;
      for (const key of keys) {
        deleteRecordEntry(record, key);
      }
    }),
  );
}

export function getKeyedSnapshotRecordEntry<K extends KeyedSnapshotRecordKey>(
  recordKey: K,
  key: string,
): SnapshotRecordValue<K> | undefined {
  return (store[recordKey] as Record<string, SnapshotRecordValue<K>>)[key];
}
