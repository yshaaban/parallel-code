import type { WorktreeSymlinkWarning } from '../ipc/types.js';
import { isRecord } from '../lib/type-guards.js';
import { isWellFormedUnicodeScalarString } from '../lib/unicode-scalar.js';
import {
  TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES,
  isTaskInitialPromptDeliverySnapshot,
  type TaskInitialPromptDeliverySnapshot,
} from './task-initial-prompt-delivery.js';
import {
  isTaskCreationOperationCapability,
  isTaskCreationOperationId,
  IssueTaskCreationOperationTicketResult,
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from './task-creation-ticket.js';
import {
  isRemoteTaskSummary,
  isTaskCatalogCursor,
  isTaskCatalogIdentifier,
  type RemoteTaskSummary,
} from './task-catalog.js';
import {
  isTaskShellSessionOperationReplay,
  reduceTaskShellSessionOperationReplay,
  type RetryTaskShellSessionOperationRequest,
  type RetryTaskShellSessionOperationResult,
  type TaskShellSessionOperationReplay,
} from './task-shell-session-operation.js';

export type TaskWorktreeLinkWarning = WorktreeSymlinkWarning;

export const TASK_CREATION_NAME_MAX_UTF8_BYTES = 256;
export const TASK_CREATION_BRANCH_PREFIX_MAX_UTF8_BYTES = 96;
export const TASK_CREATION_GITHUB_URL_MAX_UTF8_BYTES = 2_048;

export type TaskCreationLocation =
  | { kind: 'managed-worktree'; requestedLinkNames: string[] }
  | { kind: 'project-root' }
  | { kind: 'existing-worktree'; worktreeRef: string };

export type TaskCreationLaunch =
  | {
      agentDefId: string;
      initialPrompt?: string;
      kind: 'agent';
      skipPermissions: boolean;
    }
  | { kind: 'terminal' };

export interface TaskCreationRequest {
  baseBranchRef?: string;
  branchPrefixPreference?: string;
  githubUrl?: string;
  launch: TaskCreationLaunch;
  location: TaskCreationLocation;
  name: string;
  projectId: string;
  stepsTracking: boolean;
}

export interface TaskCreationIntent extends TaskCreationRequest {
  operationCapability: TaskCreationOperationCapability;
  operationId: TaskCreationOperationId;
  operationTicket: string;
}

export type TaskCreationPhase =
  | 'validating'
  | 'preparing'
  | 'committing'
  | 'starting'
  | 'delivering-prompt'
  | 'active'
  | 'created-needs-attention'
  | 'failed-before-commit'
  | 'cancelled-before-preparation'
  | 'manual-reconciliation-required';

export type TaskCreationDurableIssueCode =
  | 'terminal-launch-capacity'
  | 'reservation-conflict'
  | 'preparation-failed'
  | 'workspace-conflict'
  | 'operation-journal-repair-required'
  | 'manual-reconciliation-required'
  | 'launch-failed'
  | 'prompt-enqueue-rejected'
  | 'projection-repair-required';

export type TaskCreationCreatePreRecordErrorCode =
  | 'invalid-request'
  | 'capability-denied'
  | 'operation-ticket-invalid'
  | 'operation-ticket-expired'
  | 'operation-conflict'
  | 'operation-expired'
  | 'rate-limited'
  | 'creation-capacity';

export type TaskCreationLookupErrorCode = 'invalid-request' | 'capability-denied' | 'rate-limited';

export type TaskCreationCapabilityReason =
  | 'backend-not-ready'
  | 'owner-epoch-mismatch'
  | 'secure-transport-required'
  | 'not-authorized'
  | 'project-mode-unavailable'
  | 'journal-unavailable';

export type TaskCreationCapability =
  | { enabled: true }
  | { enabled: false; reason: TaskCreationCapabilityReason };

export interface TaskCreationCapabilities {
  coordinator: { reason: 'coordinator-not-supported'; supported: false };
  enabled: boolean;
  locations: Record<
    'managed-worktree' | 'project-root' | 'existing-worktree',
    TaskCreationCapability
  >;
  modes: Record<'agent' | 'terminal', TaskCreationCapability>;
  permissionBypass: TaskCreationCapability;
  reason?: TaskCreationCapabilityReason;
}

export const REMOTE_TASK_CREATION_CAPABILITY_DARK: Readonly<TaskCreationCapabilities> =
  Object.freeze({
    coordinator: Object.freeze({
      reason: 'coordinator-not-supported' as const,
      supported: false as const,
    }),
    enabled: false,
    locations: Object.freeze({
      'existing-worktree': Object.freeze({ enabled: false, reason: 'backend-not-ready' as const }),
      'managed-worktree': Object.freeze({ enabled: false, reason: 'backend-not-ready' as const }),
      'project-root': Object.freeze({ enabled: false, reason: 'backend-not-ready' as const }),
    }),
    modes: Object.freeze({
      agent: Object.freeze({ enabled: false, reason: 'backend-not-ready' as const }),
      terminal: Object.freeze({ enabled: false, reason: 'backend-not-ready' as const }),
    }),
    permissionBypass: Object.freeze({ enabled: false, reason: 'backend-not-ready' as const }),
    reason: 'backend-not-ready',
  });

export type TaskCreationPickerKind = 'base-branch' | 'existing-worktree';

export type TaskCreationPickerItem =
  | {
      branchLabel: string;
      kind: 'base-branch';
      label: string;
      ref: string;
    }
  | {
      branchLabel: string | null;
      kind: 'existing-worktree';
      label: string;
      ownershipLabel: string;
      ref: string;
    };

export interface GetTaskCreationPickerPageRequest {
  cursor?: string;
  kind: TaskCreationPickerKind;
  projectId: string;
  query?: string;
}

export interface TaskCreationPickerPage {
  catalogVersion: number;
  generation: number;
  items: TaskCreationPickerItem[];
  kind: TaskCreationPickerKind;
  nextCursor: string | null;
  serverInstanceId: string;
  truncated: boolean;
}

export interface GetTaskWorktreeLinkCandidatesRequest {
  projectId: string;
}

export interface TaskWorktreeLinkCandidate {
  isDefault: boolean;
  name: string;
}

export type GetTaskWorktreeLinkCandidatesResult =
  | {
      candidates: TaskWorktreeLinkCandidate[];
      kind: 'found';
      truncated: boolean;
    }
  | { kind: 'unavailable' };

export type TaskCreationRecovery =
  | {
      committedWorkspaceRevision: number;
      kind: 'retry-agent-launch';
      launchOperationId: string;
    }
  | { deliveryId: string; kind: 'review-initial-prompt' };

export type TaskCreationManagedArtifactRecovery =
  | { kind: 'none' }
  | {
      branchDelete:
        | { kind: 'not-applicable' }
        | {
            challengeId: string;
            confirmationVersion: number;
            kind: 'confirmation-required';
          };
      kind:
        | 'retained-quarantine'
        | 'restore-pending'
        | 'unlock-pending'
        | 'manual-reconciliation-required';
      recoveryId: string;
    };

export interface TaskCreationSnapshotIssue {
  code: TaskCreationDurableIssueCode;
  message: string;
  retryable: boolean;
}

type TaskCreationSnapshotIssueWithCode<Code extends TaskCreationDurableIssueCode> = Omit<
  TaskCreationSnapshotIssue,
  'code'
> & { code: Code };

type TaskCreationFailedBeforeCommitIssueCode =
  | 'terminal-launch-capacity'
  | 'reservation-conflict'
  | 'preparation-failed'
  | 'workspace-conflict';

type TaskCreationAgentFailedBeforeCommitIssue = TaskCreationSnapshotIssueWithCode<
  Exclude<TaskCreationFailedBeforeCommitIssueCode, 'terminal-launch-capacity'>
>;

type TaskCreationTerminalFailedBeforeCommitIssue =
  TaskCreationSnapshotIssueWithCode<TaskCreationFailedBeforeCommitIssueCode>;

type TaskCreationManualIssue = TaskCreationSnapshotIssueWithCode<
  'operation-journal-repair-required' | 'manual-reconciliation-required'
>;

interface TaskCreationCurrentProjectionBase {
  catalogVersion: number;
  serverInstanceId: string;
  workspaceRevision: number;
}

export type TaskCreationNotCommittedCurrentProjection = TaskCreationCurrentProjectionBase & {
  task: null;
  taskClosing: false;
  taskState: 'not-visible';
};

export type TaskCreationCommittedCurrentProjection<Mode extends 'agent' | 'terminal'> =
  TaskCreationCurrentProjectionBase &
    (
      | {
          task: RemoteTaskSummary & { taskMode: Mode };
          taskClosing: boolean;
          taskState: 'present';
        }
      | {
          task: null;
          taskClosing: false;
          taskState: 'removed' | 'not-visible';
        }
    );

interface TaskCreationOperationSnapshotBase {
  operationId: TaskCreationOperationId;
  serverInstanceId: string;
  symlinkWarnings: TaskWorktreeLinkWarning[];
  version: number;
}

type TaskCreationNotCommittedState<FailureIssue extends TaskCreationSnapshotIssue> = {
  commit: 'not-committed';
  committedTaskId: null;
  committedWorkspaceRevision: null;
  current: TaskCreationNotCommittedCurrentProjection;
  promptDelivery?: never;
  recovery?: never;
  shellLaunch?: never;
} & (
  | {
      issue?: never;
      managedArtifactRecovery: { kind: 'none' };
      phase: 'validating' | 'preparing' | 'committing';
    }
  | {
      issue?: never;
      managedArtifactRecovery: { kind: 'none' };
      phase: 'cancelled-before-preparation';
    }
  | {
      issue: FailureIssue;
      managedArtifactRecovery: TaskCreationManagedArtifactRecovery;
      phase: 'failed-before-commit';
    }
  | {
      issue: TaskCreationManualIssue;
      managedArtifactRecovery: TaskCreationManagedArtifactRecovery;
      phase: 'manual-reconciliation-required';
    }
);

type TaskCreationAgentCommittedState = {
  commit: 'committed';
  committedTaskId: string;
  committedWorkspaceRevision: number;
  current: TaskCreationCommittedCurrentProjection<'agent'>;
  managedArtifactRecovery: { kind: 'none' };
  shellLaunch?: never;
} & (
  | {
      issue?: never;
      phase: 'starting';
      promptDelivery?: never;
      recovery?: never;
    }
  | {
      issue?: never;
      phase: 'delivering-prompt';
      promptDelivery: TaskInitialPromptDeliverySnapshot;
      recovery?: never;
    }
  | {
      issue?: never;
      phase: 'active';
      promptDelivery?: TaskInitialPromptDeliverySnapshot;
      recovery?: never;
    }
  | {
      issue: TaskCreationSnapshotIssueWithCode<'launch-failed'>;
      phase: 'created-needs-attention';
      promptDelivery?: never;
      recovery?: Extract<TaskCreationRecovery, { kind: 'retry-agent-launch' }>;
    }
  | {
      issue: TaskCreationSnapshotIssueWithCode<'prompt-enqueue-rejected'>;
      phase: 'created-needs-attention';
      promptDelivery: TaskInitialPromptDeliverySnapshot;
      recovery?: Extract<TaskCreationRecovery, { kind: 'review-initial-prompt' }>;
    }
  | {
      issue: TaskCreationSnapshotIssueWithCode<
        'operation-journal-repair-required' | 'projection-repair-required'
      >;
      phase: 'created-needs-attention';
      promptDelivery?: TaskInitialPromptDeliverySnapshot;
      recovery?: never;
    }
);

type TaskCreationTerminalCommittedState = {
  commit: 'committed';
  committedTaskId: string;
  committedWorkspaceRevision: number;
  current: TaskCreationCommittedCurrentProjection<'terminal'>;
  managedArtifactRecovery: { kind: 'none' };
  promptDelivery?: never;
  recovery?: never;
} & (
  | {
      issue?: never;
      phase: 'starting' | 'active';
      shellLaunch: TaskShellSessionOperationReplay;
    }
  | {
      issue: TaskCreationSnapshotIssueWithCode<'launch-failed'>;
      phase: 'created-needs-attention';
      shellLaunch: TaskShellSessionOperationReplay;
    }
  | {
      issue: TaskCreationSnapshotIssueWithCode<
        'operation-journal-repair-required' | 'projection-repair-required'
      >;
      phase: 'created-needs-attention';
      shellLaunch?: TaskShellSessionOperationReplay;
    }
);

export type TaskCreationAgentOperationSnapshot = TaskCreationOperationSnapshotBase & {
  taskMode: 'agent';
} & (
    | TaskCreationNotCommittedState<TaskCreationAgentFailedBeforeCommitIssue>
    | TaskCreationAgentCommittedState
  );

export type TaskCreationTerminalOperationSnapshot = TaskCreationOperationSnapshotBase & {
  taskMode: 'terminal';
} & (
    | TaskCreationNotCommittedState<TaskCreationTerminalFailedBeforeCommitIssue>
    | TaskCreationTerminalCommittedState
  );

export type TaskCreationOperationSnapshot =
  | TaskCreationAgentOperationSnapshot
  | TaskCreationTerminalOperationSnapshot;

type TaskCreationSnapshotResult<Outcome extends string> =
  | { kind: 'snapshot'; outcome: Outcome; snapshot: TaskCreationAgentOperationSnapshot }
  | { kind: 'snapshot'; outcome: Outcome; snapshot: TaskCreationTerminalOperationSnapshot };

export type TaskCreationCreateRejectedWithoutSnapshot = {
  code: TaskCreationCreatePreRecordErrorCode;
  kind: 'create-rejected-without-snapshot';
};

export type TaskCreationLookupRejectedWithoutSnapshot = {
  code: TaskCreationLookupErrorCode;
  kind: 'lookup-rejected-without-snapshot';
};

export type TaskCreationOperationStateUnavailable = {
  kind: 'operation-state-unavailable';
};

export type TaskCreationInfrastructureUnavailable =
  | { code: 'host-state-recovery-required'; kind: 'canonical-host-unavailable' }
  | {
      code: 'host-durability-repair-required';
      kind: 'canonical-host-durability-pending';
      pollAfterMs: number;
    }
  | {
      code: 'operation-journal-repair-required';
      kind: 'operation-journal-unavailable';
    };

export type CreateTaskCreationOperationResult =
  | TaskCreationSnapshotResult<'accepted' | 'joined' | 'replayed'>
  | TaskCreationCreateRejectedWithoutSnapshot
  | TaskCreationInfrastructureUnavailable;

export interface GetTaskCreationOperationRequest {
  operationCapability: TaskCreationOperationCapability;
  operationId: TaskCreationOperationId;
}

export type TaskCreationOperationLiveMessage =
  | { kind: 'connection-state'; state: 'connected' | 'disconnected' }
  | { kind: 'snapshot'; snapshot: TaskCreationOperationSnapshot }
  | { kind: 'subscription-state'; state: 'degraded' | 'ready' };

/**
 * One capability-bound live operation channel. Implementations retain the
 * capability in memory only and must remove it when the returned cleanup runs.
 */
export interface TaskCreationOperationLiveEventSource {
  subscribe(
    request: Readonly<GetTaskCreationOperationRequest>,
    listener: (message: TaskCreationOperationLiveMessage) => void,
  ): () => void;
}

export type GetTaskCreationOperationResult =
  | TaskCreationSnapshotResult<'found'>
  | TaskCreationLookupRejectedWithoutSnapshot
  | TaskCreationOperationStateUnavailable
  | TaskCreationInfrastructureUnavailable;

export interface CancelTaskCreationOperationRequest {
  expectedVersion: number;
  operationCapability: TaskCreationOperationCapability;
  operationId: TaskCreationOperationId;
}

export type CancelTaskCreationOperationResult =
  | TaskCreationSnapshotResult<'cancelled' | 'already-terminal' | 'too-late' | 'version-conflict'>
  | TaskCreationLookupRejectedWithoutSnapshot
  | TaskCreationOperationStateUnavailable
  | TaskCreationInfrastructureUnavailable;

export interface TaskCreationClientOperationState {
  overlay:
    | null
    | { code: TaskCreationCreatePreRecordErrorCode; kind: 'create-rejected' }
    | {
        code: TaskCreationLookupErrorCode;
        kind: 'lookup-rejected';
        retryAfterMs?: number;
      }
    | { kind: 'operation-state-unavailable' }
    | {
        kind: 'infrastructure-unavailable';
        result: TaskCreationInfrastructureUnavailable;
      };
  snapshot: TaskCreationOperationSnapshot | null;
}

export interface TaskCreationClientFacade {
  cancel(
    request: CancelTaskCreationOperationRequest,
    signal?: AbortSignal,
  ): Promise<CancelTaskCreationOperationResult>;
  create(
    intent: TaskCreationIntent,
    signal?: AbortSignal,
  ): Promise<CreateTaskCreationOperationResult>;
  get(
    request: GetTaskCreationOperationRequest,
    signal?: AbortSignal,
  ): Promise<GetTaskCreationOperationResult>;
  getCapabilities(signal?: AbortSignal): Promise<TaskCreationCapabilities>;
  getPickerPage(
    request: GetTaskCreationPickerPageRequest,
    signal?: AbortSignal,
  ): Promise<TaskCreationPickerPage>;
  getWorktreeLinkCandidates(
    request: GetTaskWorktreeLinkCandidatesRequest,
    signal?: AbortSignal,
  ): Promise<GetTaskWorktreeLinkCandidatesResult>;
  issue(signal?: AbortSignal): Promise<IssueTaskCreationOperationTicketResult>;
  retryShell(
    request: RetryTaskShellSessionOperationRequest,
    signal?: AbortSignal,
  ): Promise<RetryTaskShellSessionOperationResult>;
}

const CONTROL_CHARACTERS = /\p{Cc}/u;
const WARNING_REASONS = new Set([
  'candidate_query_failed',
  'not_current_candidate',
  'invalid_name',
  'reserved_name',
  'source_missing',
  'source_symlink',
  'unsupported_source_kind',
  'destination_exists',
  'link_failed',
  'exclude_update_failed',
  'ignore_postcondition_failed',
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOperationId(value: unknown): value is TaskCreationOperationId {
  return isTaskCreationOperationId(value);
}

function isCapability(value: unknown): value is TaskCreationOperationCapability {
  return isTaskCreationOperationCapability(value);
}

function isCreationCapability(value: unknown): value is TaskCreationCapability {
  if (!isRecord(value)) return false;
  if (value.enabled === true) return hasExactKeys(value, ['enabled']);
  return (
    value.enabled === false &&
    hasExactKeys(value, ['enabled', 'reason']) &&
    (value.reason === 'backend-not-ready' ||
      value.reason === 'owner-epoch-mismatch' ||
      value.reason === 'secure-transport-required' ||
      value.reason === 'not-authorized' ||
      value.reason === 'project-mode-unavailable' ||
      value.reason === 'journal-unavailable')
  );
}

export function isTaskCreationCapabilities(value: unknown): value is TaskCreationCapabilities {
  if (!isRecord(value)) return false;
  const allowed = [
    'coordinator',
    'enabled',
    'locations',
    'modes',
    'permissionBypass',
    'reason',
  ] as const;
  if (
    !hasOnlyKeys(value, allowed) ||
    !['coordinator', 'enabled', 'locations', 'modes', 'permissionBypass'].every(
      (key) => key in value,
    ) ||
    typeof value.enabled !== 'boolean' ||
    !isRecord(value.coordinator) ||
    !hasExactKeys(value.coordinator, ['reason', 'supported']) ||
    value.coordinator.supported !== false ||
    value.coordinator.reason !== 'coordinator-not-supported' ||
    !isRecord(value.locations) ||
    !hasExactKeys(value.locations, ['managed-worktree', 'project-root', 'existing-worktree']) ||
    !isCreationCapability(value.locations['managed-worktree']) ||
    !isCreationCapability(value.locations['project-root']) ||
    !isCreationCapability(value.locations['existing-worktree']) ||
    !isRecord(value.modes) ||
    !hasExactKeys(value.modes, ['agent', 'terminal']) ||
    !isCreationCapability(value.modes.agent) ||
    !isCreationCapability(value.modes.terminal) ||
    !isCreationCapability(value.permissionBypass)
  ) {
    return false;
  }
  return value.enabled
    ? value.reason === undefined
    : isCreationCapability({ enabled: false, reason: value.reason });
}

function isBoundedText(value: unknown, maxBytes: number, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    !CONTROL_CHARACTERS.test(value) &&
    isWellFormedUnicodeScalarString(value) &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function isBoundedPrompt(value: unknown): value is string {
  if (typeof value !== 'string' || !isWellFormedUnicodeScalarString(value)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
      codePoint === 127
    ) {
      return false;
    }
  }
  return new TextEncoder().encode(value).byteLength <= TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES;
}

export function isIssueTaskCreationOperationTicketResult(
  value: unknown,
): value is IssueTaskCreationOperationTicketResult {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['expiresAt', 'issuedAt', 'operationId', 'operationTicket']) &&
    isOperationId(value.operationId) &&
    isBoundedText(value.operationTicket, 1_024, false) &&
    isNonNegativeSafeInteger(value.issuedAt) &&
    isPositiveSafeInteger(value.expiresAt) &&
    value.expiresAt > value.issuedAt
  );
}

function isTaskCreationPickerItem(
  value: unknown,
  kind: TaskCreationPickerKind,
): value is TaskCreationPickerItem {
  if (!isRecord(value) || value.kind !== kind) return false;
  if (kind === 'base-branch') {
    return (
      hasExactKeys(value, ['branchLabel', 'kind', 'label', 'ref']) &&
      isBoundedText(value.branchLabel, 96, false) &&
      isBoundedText(value.label, 96, false) &&
      isTaskCatalogIdentifier(value.ref) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 384
    );
  }
  return (
    hasExactKeys(value, ['branchLabel', 'kind', 'label', 'ownershipLabel', 'ref']) &&
    (value.branchLabel === null || isBoundedText(value.branchLabel, 96, false)) &&
    isBoundedText(value.label, 96, false) &&
    isBoundedText(value.ownershipLabel, 96, false) &&
    isTaskCatalogIdentifier(value.ref) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 384
  );
}

export function isTaskCreationPickerPage(value: unknown): value is TaskCreationPickerPage {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'catalogVersion',
      'generation',
      'items',
      'kind',
      'nextCursor',
      'serverInstanceId',
      'truncated',
    ]) &&
    (value.kind === 'base-branch' || value.kind === 'existing-worktree') &&
    isNonNegativeSafeInteger(value.catalogVersion) &&
    isNonNegativeSafeInteger(value.generation) &&
    isTaskCatalogIdentifier(value.serverInstanceId) &&
    Array.isArray(value.items) &&
    value.items.length <= 50 &&
    value.items.every((item) =>
      isTaskCreationPickerItem(item, value.kind as TaskCreationPickerKind),
    ) &&
    (value.nextCursor === null || isTaskCatalogCursor(value.nextCursor)) &&
    typeof value.truncated === 'boolean' &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 49_152
  );
}

export function isGetTaskWorktreeLinkCandidatesResult(
  value: unknown,
): value is GetTaskWorktreeLinkCandidatesResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'unavailable') return hasExactKeys(value, ['kind']);
  return (
    value.kind === 'found' &&
    hasExactKeys(value, ['candidates', 'kind', 'truncated']) &&
    Array.isArray(value.candidates) &&
    value.candidates.length <= 128 &&
    value.candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        hasExactKeys(candidate, ['isDefault', 'name']) &&
        typeof candidate.isDefault === 'boolean' &&
        isBoundedText(candidate.name, 255, false),
    ) &&
    typeof value.truncated === 'boolean'
  );
}

const TASK_CREATION_REQUEST_KEYS = [
  'baseBranchRef',
  'branchPrefixPreference',
  'githubUrl',
  'launch',
  'location',
  'name',
  'projectId',
  'stepsTracking',
] as const;

const TASK_CREATION_REQUEST_REQUIRED_KEYS = [
  'launch',
  'location',
  'name',
  'projectId',
  'stepsTracking',
] as const;

function hasValidTaskCreationRequestFields(value: Record<string, unknown>): boolean {
  if (
    !TASK_CREATION_REQUEST_REQUIRED_KEYS.every((key) => key in value) ||
    !isTaskCatalogIdentifier(value.projectId) ||
    !isBoundedText(value.name, TASK_CREATION_NAME_MAX_UTF8_BYTES, false) ||
    typeof value.stepsTracking !== 'boolean' ||
    (value.baseBranchRef !== undefined && !isTaskCatalogIdentifier(value.baseBranchRef)) ||
    (value.branchPrefixPreference !== undefined &&
      !isBoundedText(
        value.branchPrefixPreference,
        TASK_CREATION_BRANCH_PREFIX_MAX_UTF8_BYTES,
        false,
      )) ||
    (value.githubUrl !== undefined &&
      !isBoundedText(value.githubUrl, TASK_CREATION_GITHUB_URL_MAX_UTF8_BYTES, false))
  ) {
    return false;
  }

  if (!isRecord(value.location) || typeof value.location.kind !== 'string') return false;
  switch (value.location.kind) {
    case 'managed-worktree':
      if (
        !hasExactKeys(value.location, ['kind', 'requestedLinkNames']) ||
        !Array.isArray(value.location.requestedLinkNames) ||
        value.location.requestedLinkNames.length > 128 ||
        !value.location.requestedLinkNames.every((name) => isBoundedText(name, 255, false))
      ) {
        return false;
      }
      break;
    case 'project-root':
      if (!hasExactKeys(value.location, ['kind'])) return false;
      break;
    case 'existing-worktree':
      if (
        !hasExactKeys(value.location, ['kind', 'worktreeRef']) ||
        !isTaskCatalogIdentifier(value.location.worktreeRef)
      ) {
        return false;
      }
      break;
    default:
      return false;
  }

  if (!isRecord(value.launch) || typeof value.launch.kind !== 'string') return false;
  if (value.launch.kind === 'terminal') return hasExactKeys(value.launch, ['kind']);
  return (
    value.launch.kind === 'agent' &&
    hasOnlyKeys(value.launch, ['agentDefId', 'initialPrompt', 'kind', 'skipPermissions']) &&
    'agentDefId' in value.launch &&
    'skipPermissions' in value.launch &&
    isTaskCatalogIdentifier(value.launch.agentDefId) &&
    typeof value.launch.skipPermissions === 'boolean' &&
    (value.launch.initialPrompt === undefined || isBoundedPrompt(value.launch.initialPrompt))
  );
}

export function isTaskCreationRequest(value: unknown): value is TaskCreationRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, TASK_CREATION_REQUEST_KEYS) &&
    hasValidTaskCreationRequestFields(value)
  );
}

export function isTaskCreationIntent(value: unknown): value is TaskCreationIntent {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      ...TASK_CREATION_REQUEST_KEYS,
      'operationCapability',
      'operationId',
      'operationTicket',
    ]) &&
    hasValidTaskCreationRequestFields(value) &&
    isOperationId(value.operationId) &&
    isCapability(value.operationCapability) &&
    isBoundedText(value.operationTicket, 1_024, false)
  );
}

function isWarning(value: unknown): value is TaskWorktreeLinkWarning {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['message', 'name', 'reason']) &&
    isBoundedText(value.name, 255, false) &&
    typeof value.reason === 'string' &&
    WARNING_REASONS.has(value.reason) &&
    isBoundedText(value.message, 256, false)
  );
}

function isManagedArtifactRecovery(value: unknown): value is TaskCreationManagedArtifactRecovery {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'none') return hasExactKeys(value, ['kind']);
  if (
    !(
      value.kind === 'retained-quarantine' ||
      value.kind === 'restore-pending' ||
      value.kind === 'unlock-pending' ||
      value.kind === 'manual-reconciliation-required'
    ) ||
    !hasExactKeys(value, ['branchDelete', 'kind', 'recoveryId']) ||
    !isTaskCatalogIdentifier(value.recoveryId) ||
    !isRecord(value.branchDelete)
  ) {
    return false;
  }
  return (
    (value.branchDelete.kind === 'not-applicable' && hasExactKeys(value.branchDelete, ['kind'])) ||
    (value.branchDelete.kind === 'confirmation-required' &&
      hasExactKeys(value.branchDelete, ['challengeId', 'confirmationVersion', 'kind']) &&
      isTaskCatalogIdentifier(value.branchDelete.challengeId) &&
      isNonNegativeSafeInteger(value.branchDelete.confirmationVersion))
  );
}

function isSnapshotIssue(value: unknown): value is TaskCreationSnapshotIssue {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code', 'message', 'retryable']) &&
    (value.code === 'terminal-launch-capacity' ||
      value.code === 'reservation-conflict' ||
      value.code === 'preparation-failed' ||
      value.code === 'workspace-conflict' ||
      value.code === 'operation-journal-repair-required' ||
      value.code === 'manual-reconciliation-required' ||
      value.code === 'launch-failed' ||
      value.code === 'prompt-enqueue-rejected' ||
      value.code === 'projection-repair-required') &&
    isBoundedText(value.message, 256, false) &&
    typeof value.retryable === 'boolean'
  );
}

function isCurrentProjection(
  value: unknown,
  taskMode: 'agent' | 'terminal',
  committed: boolean,
): value is
  | TaskCreationNotCommittedCurrentProjection
  | TaskCreationCommittedCurrentProjection<typeof taskMode> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'catalogVersion',
      'serverInstanceId',
      'task',
      'taskClosing',
      'taskState',
      'workspaceRevision',
    ]) ||
    !isTaskCatalogIdentifier(value.serverInstanceId) ||
    !isNonNegativeSafeInteger(value.catalogVersion) ||
    !isNonNegativeSafeInteger(value.workspaceRevision) ||
    typeof value.taskClosing !== 'boolean'
  ) {
    return false;
  }
  if (!committed) {
    return value.task === null && value.taskState === 'not-visible' && value.taskClosing === false;
  }
  if (value.taskState === 'present') {
    return isRemoteTaskSummary(value.task) && value.task.taskMode === taskMode;
  }
  return (
    (value.taskState === 'removed' || value.taskState === 'not-visible') &&
    value.task === null &&
    value.taskClosing === false
  );
}

function isRecovery(value: unknown): value is TaskCreationRecovery {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'review-initial-prompt') {
    return hasExactKeys(value, ['deliveryId', 'kind']) && isTaskCatalogIdentifier(value.deliveryId);
  }
  return (
    value.kind === 'retry-agent-launch' &&
    hasExactKeys(value, ['committedWorkspaceRevision', 'kind', 'launchOperationId']) &&
    isPositiveSafeInteger(value.committedWorkspaceRevision) &&
    isTaskCatalogIdentifier(value.launchOperationId)
  );
}

const SNAPSHOT_KEYS = [
  'commit',
  'committedTaskId',
  'committedWorkspaceRevision',
  'current',
  'issue',
  'managedArtifactRecovery',
  'operationId',
  'phase',
  'promptDelivery',
  'recovery',
  'serverInstanceId',
  'shellLaunch',
  'symlinkWarnings',
  'taskMode',
  'version',
] as const;

function hasSnapshotBase(value: Record<string, unknown>): boolean {
  const required = SNAPSHOT_KEYS.filter(
    (key) =>
      key !== 'issue' && key !== 'promptDelivery' && key !== 'recovery' && key !== 'shellLaunch',
  );
  return (
    hasOnlyKeys(value, SNAPSHOT_KEYS) &&
    required.every((key) => key in value) &&
    isOperationId(value.operationId) &&
    isPositiveSafeInteger(value.version) &&
    isTaskCatalogIdentifier(value.serverInstanceId) &&
    Array.isArray(value.symlinkWarnings) &&
    value.symlinkWarnings.length <= 128 &&
    value.symlinkWarnings.every(isWarning) &&
    isManagedArtifactRecovery(value.managedArtifactRecovery)
  );
}

function isNotCommittedSnapshot(
  value: Record<string, unknown>,
  taskMode: 'agent' | 'terminal',
): boolean {
  const managedArtifactRecovery = value.managedArtifactRecovery;
  if (
    !isManagedArtifactRecovery(managedArtifactRecovery) ||
    value.commit !== 'not-committed' ||
    value.committedTaskId !== null ||
    value.committedWorkspaceRevision !== null ||
    value.promptDelivery !== undefined ||
    value.recovery !== undefined ||
    value.shellLaunch !== undefined ||
    !isCurrentProjection(value.current, taskMode, false)
  ) {
    return false;
  }
  switch (value.phase) {
    case 'validating':
    case 'preparing':
    case 'committing':
    case 'cancelled-before-preparation':
      return value.issue === undefined && managedArtifactRecovery.kind === 'none';
    case 'failed-before-commit':
      return (
        isSnapshotIssue(value.issue) &&
        (value.issue.code === 'reservation-conflict' ||
          value.issue.code === 'preparation-failed' ||
          value.issue.code === 'workspace-conflict' ||
          (taskMode === 'terminal' && value.issue.code === 'terminal-launch-capacity'))
      );
    case 'manual-reconciliation-required':
      return (
        isSnapshotIssue(value.issue) &&
        (value.issue.code === 'operation-journal-repair-required' ||
          value.issue.code === 'manual-reconciliation-required')
      );
    default:
      return false;
  }
}

function hasCommittedBase(value: Record<string, unknown>, taskMode: 'agent' | 'terminal'): boolean {
  const managedArtifactRecovery = value.managedArtifactRecovery;
  return (
    isManagedArtifactRecovery(managedArtifactRecovery) &&
    value.commit === 'committed' &&
    isTaskCatalogIdentifier(value.committedTaskId) &&
    isPositiveSafeInteger(value.committedWorkspaceRevision) &&
    isCurrentProjection(value.current, taskMode, true) &&
    managedArtifactRecovery.kind === 'none' &&
    (value.current.task === null || value.current.task.taskId === value.committedTaskId) &&
    value.current.workspaceRevision >= value.committedWorkspaceRevision
  );
}

function isAgentCommittedSnapshot(value: Record<string, unknown>): boolean {
  if (
    !hasCommittedBase(value, 'agent') ||
    value.shellLaunch !== undefined ||
    (value.promptDelivery !== undefined &&
      !isTaskInitialPromptDeliverySnapshot(value.promptDelivery)) ||
    (value.recovery !== undefined && !isRecovery(value.recovery))
  ) {
    return false;
  }
  switch (value.phase) {
    case 'starting':
      return (
        value.issue === undefined &&
        value.promptDelivery === undefined &&
        value.recovery === undefined
      );
    case 'delivering-prompt':
      return (
        value.issue === undefined &&
        isTaskInitialPromptDeliverySnapshot(value.promptDelivery) &&
        value.recovery === undefined
      );
    case 'active':
      return value.issue === undefined && value.recovery === undefined;
    case 'created-needs-attention':
      if (!isSnapshotIssue(value.issue)) return false;
      if (value.issue.code === 'launch-failed') {
        return (
          value.promptDelivery === undefined &&
          (value.recovery === undefined || value.recovery.kind === 'retry-agent-launch')
        );
      }
      if (value.issue.code === 'prompt-enqueue-rejected') {
        return (
          isTaskInitialPromptDeliverySnapshot(value.promptDelivery) &&
          (value.recovery === undefined || value.recovery.kind === 'review-initial-prompt')
        );
      }
      return (
        (value.issue.code === 'operation-journal-repair-required' ||
          value.issue.code === 'projection-repair-required') &&
        value.recovery === undefined
      );
    default:
      return false;
  }
}

function isTerminalCommittedSnapshot(value: Record<string, unknown>): boolean {
  if (
    !hasCommittedBase(value, 'terminal') ||
    value.promptDelivery !== undefined ||
    value.recovery !== undefined ||
    (value.shellLaunch !== undefined && !isTaskShellSessionOperationReplay(value.shellLaunch))
  ) {
    return false;
  }
  if (
    value.shellLaunch !== undefined &&
    (value.shellLaunch.current.serverInstanceId !== value.serverInstanceId ||
      value.shellLaunch.identity.creationOperationId !== value.operationId ||
      value.shellLaunch.identity.committedWorkspaceRevision !== value.committedWorkspaceRevision)
  ) {
    return false;
  }
  switch (value.phase) {
    case 'starting':
    case 'active':
      return value.issue === undefined && value.shellLaunch !== undefined;
    case 'created-needs-attention':
      return (
        isSnapshotIssue(value.issue) &&
        ((value.issue.code === 'launch-failed' && value.shellLaunch !== undefined) ||
          value.issue.code === 'operation-journal-repair-required' ||
          value.issue.code === 'projection-repair-required')
      );
    default:
      return false;
  }
}

export function isTaskCreationOperationSnapshot(
  value: unknown,
): value is TaskCreationOperationSnapshot {
  if (!isRecord(value) || !hasSnapshotBase(value)) return false;
  if (value.taskMode === 'agent') {
    return isNotCommittedSnapshot(value, 'agent') || isAgentCommittedSnapshot(value);
  }
  if (value.taskMode === 'terminal') {
    return isNotCommittedSnapshot(value, 'terminal') || isTerminalCommittedSnapshot(value);
  }
  return false;
}

function isInfrastructureUnavailable(value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case 'canonical-host-unavailable':
      return hasExactKeys(value, ['code', 'kind']) && value.code === 'host-state-recovery-required';
    case 'canonical-host-durability-pending':
      return (
        hasExactKeys(value, ['code', 'kind', 'pollAfterMs']) &&
        value.code === 'host-durability-repair-required' &&
        isPositiveSafeInteger(value.pollAfterMs)
      );
    case 'operation-journal-unavailable':
      return (
        hasExactKeys(value, ['code', 'kind']) && value.code === 'operation-journal-repair-required'
      );
    default:
      return false;
  }
}

function isSnapshotResult(value: Record<string, unknown>, outcomes: ReadonlySet<string>): boolean {
  return (
    hasExactKeys(value, ['kind', 'outcome', 'snapshot']) &&
    value.kind === 'snapshot' &&
    typeof value.outcome === 'string' &&
    outcomes.has(value.outcome) &&
    isTaskCreationOperationSnapshot(value.snapshot)
  );
}

export function isCreateTaskCreationOperationResult(
  value: unknown,
): value is CreateTaskCreationOperationResult {
  if (!isRecord(value)) return false;
  if (isSnapshotResult(value, new Set(['accepted', 'joined', 'replayed']))) return true;
  return (
    (value.kind === 'create-rejected-without-snapshot' &&
      hasExactKeys(value, ['code', 'kind']) &&
      (value.code === 'invalid-request' ||
        value.code === 'capability-denied' ||
        value.code === 'operation-ticket-invalid' ||
        value.code === 'operation-ticket-expired' ||
        value.code === 'operation-conflict' ||
        value.code === 'operation-expired' ||
        value.code === 'rate-limited' ||
        value.code === 'creation-capacity')) ||
    isInfrastructureUnavailable(value)
  );
}

function isLookupResultBase(value: Record<string, unknown>): boolean {
  return (
    (value.kind === 'lookup-rejected-without-snapshot' &&
      hasExactKeys(value, ['code', 'kind']) &&
      (value.code === 'invalid-request' ||
        value.code === 'capability-denied' ||
        value.code === 'rate-limited')) ||
    (value.kind === 'operation-state-unavailable' && hasExactKeys(value, ['kind'])) ||
    isInfrastructureUnavailable(value)
  );
}

export function isGetTaskCreationOperationResult(
  value: unknown,
): value is GetTaskCreationOperationResult {
  return (
    isRecord(value) && (isSnapshotResult(value, new Set(['found'])) || isLookupResultBase(value))
  );
}

export function isCancelTaskCreationOperationResult(
  value: unknown,
): value is CancelTaskCreationOperationResult {
  return (
    isRecord(value) &&
    (isSnapshotResult(
      value,
      new Set(['cancelled', 'already-terminal', 'too-late', 'version-conflict']),
    ) ||
      isLookupResultBase(value))
  );
}

function selectNewerCurrent(
  current: TaskCreationOperationSnapshot['current'],
  incoming: TaskCreationOperationSnapshot['current'],
): TaskCreationOperationSnapshot['current'] {
  if (current.serverInstanceId !== incoming.serverInstanceId) return incoming;
  return incoming.catalogVersion >= current.catalogVersion ? incoming : current;
}

export function reduceTaskCreationOperationSnapshot(
  current: TaskCreationOperationSnapshot | null,
  incoming: TaskCreationOperationSnapshot,
): TaskCreationOperationSnapshot {
  if (!isTaskCreationOperationSnapshot(incoming)) {
    throw new Error('Invalid task-creation operation snapshot');
  }
  if (
    !current ||
    current.serverInstanceId !== incoming.serverInstanceId ||
    current.operationId !== incoming.operationId
  ) {
    return incoming;
  }
  if (current.taskMode !== incoming.taskMode) {
    throw new Error('Task-creation operation mode changed');
  }

  const latestOperation = incoming.version >= current.version ? incoming : current;
  if (latestOperation.commit === 'not-committed') return latestOperation;

  const latestCurrent = selectNewerCurrent(current.current, incoming.current);
  let reduced =
    latestOperation.current === latestCurrent
      ? latestOperation
      : ({ ...latestOperation, current: latestCurrent } as TaskCreationOperationSnapshot);

  if (
    reduced.taskMode === 'terminal' &&
    current.taskMode === 'terminal' &&
    incoming.taskMode === 'terminal' &&
    current.shellLaunch &&
    incoming.shellLaunch &&
    reduced.shellLaunch
  ) {
    const shellLaunch = reduceTaskShellSessionOperationReplay(
      current.shellLaunch,
      incoming.shellLaunch,
    );
    if (shellLaunch !== reduced.shellLaunch) {
      reduced = { ...reduced, shellLaunch } as TaskCreationOperationSnapshot;
    }
  }
  return reduced;
}

export function createEmptyTaskCreationClientOperationState(): TaskCreationClientOperationState {
  return { overlay: null, snapshot: null };
}

export function reduceCreateTaskCreationOperationResult(
  current: TaskCreationClientOperationState,
  result: CreateTaskCreationOperationResult,
): TaskCreationClientOperationState {
  if (!isCreateTaskCreationOperationResult(result)) throw new Error('Invalid create result');
  if (result.kind === 'snapshot') {
    return {
      overlay: null,
      snapshot: reduceTaskCreationOperationSnapshot(current.snapshot, result.snapshot),
    };
  }
  if (result.kind === 'create-rejected-without-snapshot') {
    return { overlay: { code: result.code, kind: 'create-rejected' }, snapshot: null };
  }
  return {
    overlay: { kind: 'infrastructure-unavailable', result },
    snapshot: current.snapshot,
  };
}

export function reduceTaskCreationLookupResult(
  current: TaskCreationClientOperationState,
  result: GetTaskCreationOperationResult | CancelTaskCreationOperationResult,
  retryAfterMs?: number,
): TaskCreationClientOperationState {
  if (!isGetTaskCreationOperationResult(result) && !isCancelTaskCreationOperationResult(result)) {
    throw new Error('Invalid task-creation lookup result');
  }
  if (result.kind === 'snapshot') {
    return {
      overlay: null,
      snapshot: reduceTaskCreationOperationSnapshot(current.snapshot, result.snapshot),
    };
  }
  if (result.kind === 'lookup-rejected-without-snapshot') {
    return {
      overlay: {
        code: result.code,
        kind: 'lookup-rejected',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
      snapshot: current.snapshot,
    };
  }
  if (result.kind === 'operation-state-unavailable') {
    return { overlay: { kind: 'operation-state-unavailable' }, snapshot: current.snapshot };
  }
  return {
    overlay: { kind: 'infrastructure-unavailable', result },
    snapshot: current.snapshot,
  };
}

export function canCancelTaskCreation(snapshot: TaskCreationOperationSnapshot): boolean {
  return snapshot.commit === 'not-committed' && snapshot.phase === 'validating';
}

export function getTaskCreationPhaseLabel(snapshot: TaskCreationOperationSnapshot): string {
  switch (snapshot.phase) {
    case 'validating':
      return 'Validating task';
    case 'preparing':
      return 'Preparing worktree';
    case 'committing':
      return 'Saving task';
    case 'starting':
      return snapshot.taskMode === 'agent' ? 'Starting agent' : 'Starting terminal';
    case 'delivering-prompt':
      return 'Queuing initial prompt';
    case 'active':
      return 'Task created';
    case 'created-needs-attention':
      return 'Task needs attention';
    case 'failed-before-commit':
      return 'Task was not created';
    case 'cancelled-before-preparation':
      return 'Task creation cancelled';
    case 'manual-reconciliation-required':
      return 'Local review required';
  }
}

export function isTaskCreationTerminalPhase(snapshot: TaskCreationOperationSnapshot): boolean {
  return (
    snapshot.phase === 'active' ||
    snapshot.phase === 'created-needs-attention' ||
    snapshot.phase === 'failed-before-commit' ||
    snapshot.phase === 'cancelled-before-preparation' ||
    snapshot.phase === 'manual-reconciliation-required'
  );
}

export type { IssueTaskCreationOperationTicketResult };
export type { RetryTaskShellSessionOperationRequest, RetryTaskShellSessionOperationResult };
