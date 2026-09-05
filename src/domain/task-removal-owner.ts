import type { TaskRemovalCurrentProjection } from './task-catalog.js';

export const TASK_REMOVAL_OWNER_SCHEMA_VERSION = 1 as const;
export const TASK_RUNTIME_REMOVAL_HOOK_SET_VERSION = 'task-runtime-removal-v1' as const;
export const TASK_REMOVAL_PARTICIPANT_IDS = Object.freeze([
  'agent-session',
  'initial-prompt',
  'task-runtime',
] as const);

export type TaskRemovalParticipantId = (typeof TASK_REMOVAL_PARTICIPANT_IDS)[number];

export interface TaskRemovalIdentity {
  deletionOperationId: string;
  taskId: string;
}

export type TaskRemovalState =
  | 'awaiting-linked-proof'
  | 'cleanup-pending'
  | 'complete'
  | 'finalizer-repair-pending';

/**
 * Public, wire-safe projection returned by the generic removal owner. Effect
 * evidence and cleanup plans remain backend-private; clients only need the
 * durable operation identity and current completion/finalizer state.
 */
export interface TaskRemovalMutationResult {
  deletionOperationId?: string;
  pendingFinalizers?: readonly TaskRemovalParticipantId[];
  removed: boolean;
  removalState?: TaskRemovalState;
  taskId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function isTaskRemovalMutationResult(value: unknown): value is TaskRemovalMutationResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      ...(value.deletionOperationId === undefined ? [] : ['deletionOperationId']),
      ...(value.pendingFinalizers === undefined ? [] : ['pendingFinalizers']),
      'removed',
      ...(value.removalState === undefined ? [] : ['removalState']),
      'taskId',
    ]) ||
    typeof value.taskId !== 'string' ||
    value.taskId.length === 0 ||
    typeof value.removed !== 'boolean' ||
    (value.deletionOperationId !== undefined &&
      (typeof value.deletionOperationId !== 'string' || value.deletionOperationId.length === 0)) ||
    (value.removalState !== undefined &&
      value.removalState !== 'awaiting-linked-proof' &&
      value.removalState !== 'cleanup-pending' &&
      value.removalState !== 'complete' &&
      value.removalState !== 'finalizer-repair-pending') ||
    (value.pendingFinalizers !== undefined &&
      (!Array.isArray(value.pendingFinalizers) ||
        new Set(value.pendingFinalizers).size !== value.pendingFinalizers.length ||
        value.pendingFinalizers.some(
          (participant) =>
            !(TASK_REMOVAL_PARTICIPANT_IDS as readonly unknown[]).includes(participant),
        )))
  ) {
    return false;
  }
  return true;
}

/**
 * Immutable backend cleanup inputs frozen before the first external removal effect. External
 * worktrees and current-branch tasks deliberately preserve Git state while still releasing runtime
 * resources.
 */
export interface TaskRemovalCleanupPlan {
  agentIds: string[];
  branchName: string;
  deleteBranch: boolean;
  gitCleanup: 'managed-worktree' | 'preserve';
  launchOperationId: string | null;
  preparedWorkspaceRevision: number;
  projectMode: 'git' | 'non-git';
  projectRoot: string;
  quarantinePath: string | null;
  taskId: string;
  taskIdentityWitness: string;
  taskMode: 'agent' | 'terminal';
  worktreePath: string;
}

export const TASK_REMOVAL_CLEANUP_STEPS = Object.freeze([
  'runners',
  'containers',
  'runtime-state',
  'coordinator',
  'worktree-quarantine',
  'branch-release',
  'shell-prepare',
] as const);

export type TaskRemovalCleanupStep = (typeof TASK_REMOVAL_CLEANUP_STEPS)[number];

export interface TaskRemovalParticipantRequest extends TaskRemovalIdentity {
  cleanupPlan: Readonly<TaskRemovalCleanupPlan>;
}

export type TaskRemovalParticipantGateSnapshot<THookSetVersion extends string> =
  | { kind: 'unavailable' }
  | {
      current: TaskRemovalCurrentProjection;
      cutoverEpoch: string;
      hookSetVersion: THookSetVersion;
      kind: 'active';
    };

/**
 * Owner-specific view of the generic removal gate. The view binds one exact
 * registered hook version, so consumers never need private hook maps or
 * deletion phases.
 */
export interface TaskRemovalParticipantGate<THookSetVersion extends string> {
  getTaskSnapshot(taskId: string): TaskRemovalParticipantGateSnapshot<THookSetVersion>;
  verifyCommittedRemoval(request: TaskRemovalIdentity): boolean;
}

export interface TaskRemovalOwnerCapability {
  cutoverEpoch: string;
  hookSetVersions: Readonly<Record<TaskRemovalParticipantId, string>>;
  kind: 'active';
  schemaVersion: typeof TASK_REMOVAL_OWNER_SCHEMA_VERSION;
}

export type TaskRemovalOwnerAvailability =
  | { kind: 'unavailable'; reason: 'not-cut-over' | 'recovery-required' }
  | TaskRemovalOwnerCapability;
