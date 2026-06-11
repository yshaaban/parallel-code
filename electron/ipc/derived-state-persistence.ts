import fs from 'fs';
import path from 'path';

import {
  isGitStatusSyncSnapshotEvent,
  type GitStatusSyncSnapshotEvent,
} from '../../src/domain/server-state.js';
import {
  isTaskConvergenceSnapshot,
  type TaskConvergenceSnapshot,
} from '../../src/domain/task-convergence.js';
import { isTaskReviewSnapshot, type TaskReviewSnapshot } from '../../src/domain/task-review.js';
import {
  isTaskReviewSignalsSnapshot,
  type TaskReviewSignalsSnapshot,
} from '../../src/domain/task-review-signals.js';
import {
  isTaskStepsSummarySnapshot,
  type TaskStepsSummarySnapshot,
} from '../../src/domain/task-steps.js';
import { isRecord } from '../../src/lib/type-guards.js';
import { listGitStatusSnapshots, subscribeGitStatusSnapshots } from './git-status-state.js';
import { getStateDirForEnv, writeJsonFileAtomically, type StorageEnv } from './storage.js';
import {
  listTaskConvergenceSnapshots,
  subscribeTaskConvergence,
} from './task-convergence-state.js';
import { listTaskReviewSnapshots, subscribeTaskReview } from './task-review-state.js';
import {
  listTaskReviewSignalsSnapshots,
  subscribeTaskReviewSignals,
} from './task-review-signals.js';
import { listTaskStepsSummarySnapshots, subscribeTaskSteps } from './task-steps.js';

// Backend-owned persistence for derived external-state snapshots. The backend
// writes its own current snapshot maps (debounced) so the next boot can serve
// real snapshots immediately instead of recomputing every task eagerly.

export const DERIVED_STATE_FILE_NAME = 'derived-state.json';
const DERIVED_STATE_FORMAT_VERSION = 1;
const DERIVED_STATE_WRITE_DEBOUNCE_MS = 2_000;

export interface PersistedDerivedStateFile {
  formatVersion: typeof DERIVED_STATE_FORMAT_VERSION;
  gitStatus: GitStatusSyncSnapshotEvent[];
  savedAt: number;
  taskConvergence: TaskConvergenceSnapshot[];
  taskReview: TaskReviewSnapshot[];
  taskReviewSignals: TaskReviewSignalsSnapshot[];
  taskSteps: TaskStepsSummarySnapshot[];
}

export function getDerivedStateFilePath(env: StorageEnv): string {
  return path.join(getStateDirForEnv(env), DERIVED_STATE_FILE_NAME);
}

function collectValidEntries<T>(value: unknown, isEntry: (entry: unknown) => entry is T): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isEntry);
}

function buildPersistedDerivedState(): PersistedDerivedStateFile {
  return {
    formatVersion: DERIVED_STATE_FORMAT_VERSION,
    gitStatus: listGitStatusSnapshots(),
    savedAt: Date.now(),
    taskConvergence: listTaskConvergenceSnapshots(),
    taskReview: listTaskReviewSnapshots(),
    taskReviewSignals: listTaskReviewSignalsSnapshots(),
    taskSteps: listTaskStepsSummarySnapshots(),
  };
}

export function startDerivedStatePersistence(env: StorageEnv): () => void {
  const filePath = getDerivedStateFilePath(env);
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function flushDerivedState(): void {
    writeTimer = null;
    if (stopped) {
      return;
    }

    try {
      writeJsonFileAtomically(filePath, JSON.stringify(buildPersistedDerivedState()));
    } catch {
      // Derived-state persistence is best-effort; boot proceeds without it.
    }
  }

  function scheduleDerivedStateWrite(): void {
    if (stopped || writeTimer !== null) {
      return;
    }

    const timer = setTimeout(flushDerivedState, DERIVED_STATE_WRITE_DEBOUNCE_MS);
    timer.unref?.();
    writeTimer = timer;
  }

  const unsubscribes = [
    subscribeGitStatusSnapshots(scheduleDerivedStateWrite),
    subscribeTaskConvergence(scheduleDerivedStateWrite),
    subscribeTaskReview(scheduleDerivedStateWrite),
    subscribeTaskReviewSignals(scheduleDerivedStateWrite),
    subscribeTaskSteps(scheduleDerivedStateWrite),
  ];

  return () => {
    stopped = true;
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };
}

export function loadPersistedDerivedState(env: StorageEnv): PersistedDerivedStateFile | null {
  const filePath = getDerivedStateFilePath(env);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.formatVersion !== DERIVED_STATE_FORMAT_VERSION) {
    return null;
  }

  return {
    formatVersion: DERIVED_STATE_FORMAT_VERSION,
    gitStatus: collectValidEntries(parsed.gitStatus, isGitStatusSyncSnapshotEvent),
    savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    taskConvergence: collectValidEntries(parsed.taskConvergence, isTaskConvergenceSnapshot),
    taskReview: collectValidEntries(parsed.taskReview, isTaskReviewSnapshot),
    taskReviewSignals: collectValidEntries(parsed.taskReviewSignals, isTaskReviewSignalsSnapshot),
    taskSteps: collectValidEntries(parsed.taskSteps, isTaskStepsSummarySnapshot),
  };
}
