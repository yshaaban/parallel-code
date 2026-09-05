import { createSignal } from 'solid-js';

import {
  decodeMergeProgressPersistenceProjection,
  getMergeProgressSnapshotDisposition,
  type CommittedMergeOperationMarker,
  type MergeProgressPersistenceInput,
  type MergeProgressPersistenceProjection,
  type MergeProgressSnapshot,
  type MergeProgressSnapshotDisposition,
} from '../domain/task-merge.js';
import { getLocalDateKey } from '../lib/date.js';

export type ApplyMergeProgressResult = MergeProgressSnapshotDisposition;
export type ApplyPersistedMergeProgressResult = ApplyMergeProgressResult | 'absent' | 'invalid';

const [currentMergeProgress, setCurrentMergeProgress] =
  createSignal<Readonly<MergeProgressSnapshot> | null>(null);
let canonicalPersistenceProjection: Readonly<MergeProgressPersistenceProjection> | null = null;

function copySnapshot(snapshot: MergeProgressSnapshot): Readonly<MergeProgressSnapshot> {
  return Object.freeze({ ...snapshot });
}

function copyPersistenceProjection(
  projection: MergeProgressPersistenceProjection,
): Readonly<MergeProgressPersistenceProjection> {
  const mergeProgress = copySnapshot(projection.mergeProgress);
  if (!projection.mergeOperation) return Object.freeze({ mergeProgress });
  return Object.freeze({
    committedMergeOperationId: projection.committedMergeOperationId,
    mergeOperation: Object.freeze({ ...projection.mergeOperation }),
    mergeProgress,
  });
}

function markersEqual(
  left: Readonly<CommittedMergeOperationMarker>,
  right: Readonly<CommittedMergeOperationMarker>,
): boolean {
  return (
    left.committedAt === right.committedAt &&
    left.operationId === right.operationId &&
    left.progressVersion === right.progressVersion &&
    left.taskId === right.taskId
  );
}

/** Apply a complete backend projection. There is intentionally no local-delta mutation API. */
export function applyMergeProgressSnapshot(
  snapshot: MergeProgressSnapshot,
): ApplyMergeProgressResult {
  const current = currentMergeProgress();
  const disposition = getMergeProgressSnapshotDisposition(current, snapshot);
  if (disposition === 'newer') {
    setCurrentMergeProgress(copySnapshot(snapshot));
  }
  return disposition;
}

/**
 * Shared decode boundary for workspace reloads and browser cold bootstrap. Invalid or legacy-only
 * state cannot erase a newer in-memory projection; the compatibility fields remain a UI fallback
 * until the backend cutover has seeded the canonical snapshot.
 */
export function applyPersistedMergeProgressSnapshot(
  value: unknown,
): ApplyPersistedMergeProgressResult {
  if (value === undefined || value === null) return 'absent';
  return applyPersistedMergeProgressProjection({ mergeProgress: value });
}

/** Apply and retain the complete canonical persistence projection used by full-state proposals. */
export function applyPersistedMergeProgressProjection(
  input: MergeProgressPersistenceInput,
): ApplyPersistedMergeProgressResult {
  if (
    (input.mergeProgress === undefined || input.mergeProgress === null) &&
    input.mergeOperation === undefined &&
    input.committedMergeOperationId === undefined
  ) {
    return 'absent';
  }
  const projection = decodeMergeProgressPersistenceProjection(input);
  if (!projection) return 'invalid';

  const canonicalDisposition = canonicalPersistenceProjection
    ? getMergeProgressSnapshotDisposition(
        canonicalPersistenceProjection.mergeProgress,
        projection.mergeProgress,
      )
    : 'newer';
  if (
    canonicalDisposition === 'newer' &&
    canonicalPersistenceProjection?.mergeOperation &&
    !projection.mergeOperation
  ) {
    return 'invalid';
  }
  if (canonicalDisposition === 'conflict') return 'conflict';
  if (
    canonicalDisposition === 'duplicate' &&
    canonicalPersistenceProjection?.mergeOperation &&
    projection.mergeOperation &&
    !markersEqual(canonicalPersistenceProjection.mergeOperation, projection.mergeOperation)
  ) {
    return 'conflict';
  }

  const displayDisposition = applyMergeProgressSnapshot(projection.mergeProgress);
  if (
    canonicalDisposition === 'newer' ||
    (canonicalDisposition === 'duplicate' &&
      (!canonicalPersistenceProjection?.mergeOperation || projection.mergeOperation))
  ) {
    canonicalPersistenceProjection = copyPersistenceProjection(projection);
  }
  return displayDisposition;
}

export function getCurrentMergeProgressSnapshot(): Readonly<MergeProgressSnapshot> | null {
  return currentMergeProgress();
}

export function getCanonicalMergeProgressPersistenceProjection(): Readonly<MergeProgressPersistenceProjection> | null {
  return canonicalPersistenceProjection;
}

export function getMergedTasksTodayFromProgress(now: Date = new Date()): number {
  const snapshot = currentMergeProgress();
  return snapshot?.dateKey === getLocalDateKey(now) ? snapshot.tasksToday : 0;
}

export function getMergedLineTotalsFromProgress(): { added: number; removed: number } {
  const snapshot = currentMergeProgress();
  return {
    added: snapshot?.linesAdded ?? 0,
    removed: snapshot?.linesRemoved ?? 0,
  };
}

export function resetMergeProgressProjectionForTests(): void {
  setCurrentMergeProgress(null);
  canonicalPersistenceProjection = null;
}
