import type { TaskRemovalState } from './task-removal-owner.js';

export type TaskCleanupWarningKind = 'containers' | 'runners' | 'worktree';

export interface TaskCleanupWarning {
  kind: TaskCleanupWarningKind;
  message: string;
}

export type TaskCleanupRemovalState = TaskRemovalState;

export interface TaskCleanupResult {
  cleanupWarnings: TaskCleanupWarning[];
  removalState?: TaskCleanupRemovalState;
}

// Compatibility aliases for callers whose operation is specifically task deletion. Runtime-only
// cleanup now shares the same result contract, so the canonical domain names stay operation-neutral.
export type DeleteTaskCleanupWarningKind = TaskCleanupWarningKind;
export type DeleteTaskCleanupWarning = TaskCleanupWarning;
export type DeleteTaskResult = TaskCleanupResult;
