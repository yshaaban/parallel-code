import {
  isCancelTaskCreationOperationResult,
  isCreateTaskCreationOperationResult,
  isGetTaskCreationOperationResult,
  isGetTaskWorktreeLinkCandidatesResult,
  isIssueTaskCreationOperationTicketResult,
  isTaskCreationCapabilities,
  isTaskCreationIntent,
  isTaskCreationPickerPage,
  type CancelTaskCreationOperationRequest,
  type GetTaskCreationOperationRequest,
  type GetTaskCreationPickerPageRequest,
  type GetTaskWorktreeLinkCandidatesRequest,
  type TaskCreationIntent,
} from '../../src/domain/task-creation.js';
import {
  isCanonicalTaskCreationAuthEpoch,
  isTaskCreationOperationCapability,
  isTaskCreationOperationId,
  isTaskCreationTicketAuthenticationContext,
  type TaskCreationTicketAuthenticationContext,
} from '../../src/domain/task-creation-ticket.js';
import {
  isRetryTaskShellSessionOperationRequest,
  isRetryTaskShellSessionOperationResult,
} from '../../src/domain/task-shell-session-operation.js';
import { isTaskCatalogCursor, isTaskCatalogIdentifier } from '../../src/domain/task-catalog.js';
import { isRecord } from '../../src/lib/type-guards.js';
import { isWellFormedUnicodeScalarString } from '../../src/lib/unicode-scalar.js';
import type {
  RemoteCommandAuthentication,
  RemoteCommandExecutionContext,
  RemoteGrant,
  RemoteCommandRegistrationTable,
} from './remote-command-gateway.js';
import type { TaskCreationWorkflow } from './task-creation-workflow.js';

const PICKER_QUERY_MAX_UTF8_BYTES = 256;
const CONTROL_CHARACTERS = /\p{Cc}/u;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isEmptyRequest(value: unknown): value is Record<string, never> {
  return isRecord(value) && hasExactKeys(value, []);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPickerQuery(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isWellFormedUnicodeScalarString(value) &&
    !CONTROL_CHARACTERS.test(value) &&
    new TextEncoder().encode(value).byteLength <= PICKER_QUERY_MAX_UTF8_BYTES
  );
}

function isGetTaskCreationOperationRequest(
  value: unknown,
): value is GetTaskCreationOperationRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['operationCapability', 'operationId']) &&
    isTaskCreationOperationCapability(value.operationCapability) &&
    isTaskCreationOperationId(value.operationId)
  );
}

function isCancelTaskCreationOperationRequest(
  value: unknown,
): value is CancelTaskCreationOperationRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['expectedVersion', 'operationCapability', 'operationId']) &&
    isPositiveSafeInteger(value.expectedVersion) &&
    isTaskCreationOperationCapability(value.operationCapability) &&
    isTaskCreationOperationId(value.operationId)
  );
}

function isGetTaskCreationPickerPageRequest(
  value: unknown,
): value is GetTaskCreationPickerPageRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['cursor', 'kind', 'projectId', 'query']) &&
    hasExactKeys(value, [
      'kind',
      'projectId',
      ...('cursor' in value ? ['cursor'] : []),
      ...('query' in value ? ['query'] : []),
    ]) &&
    (value.kind === 'base-branch' || value.kind === 'existing-worktree') &&
    isTaskCatalogIdentifier(value.projectId) &&
    (!('cursor' in value) || isTaskCatalogCursor(value.cursor)) &&
    (!('query' in value) || isPickerQuery(value.query))
  );
}

function isGetTaskWorktreeLinkCandidatesRequest(
  value: unknown,
): value is GetTaskWorktreeLinkCandidatesRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['projectId']) &&
    isTaskCatalogIdentifier(value.projectId)
  );
}

function requireRequest<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  label: string,
): T {
  if (!guard(value)) throw new TypeError(`Invalid ${label} request`);
  return value;
}

function decodeAuthenticationSessionGeneration(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 16 && decoded.toString('base64url') === value
    ? Uint8Array.from(decoded)
    : null;
}

type RemoteTaskCreationAuthenticationEvidence = Pick<
  RemoteCommandExecutionContext,
  'authEpoch' | 'authenticationSessionGeneration' | 'principalId'
>;

export function toTaskCreationAuthentication(
  context: RemoteTaskCreationAuthenticationEvidence,
): TaskCreationTicketAuthenticationContext {
  const authenticationSessionGeneration = decodeAuthenticationSessionGeneration(
    context.authenticationSessionGeneration,
  );
  const authentication = {
    authEpoch: context.authEpoch,
    authenticationSessionGeneration,
    workspacePrincipalId: context.principalId,
  };
  if (
    !isCanonicalTaskCreationAuthEpoch(context.authEpoch) ||
    authenticationSessionGeneration === null ||
    !isTaskCreationTicketAuthenticationContext(authentication)
  ) {
    throw new TypeError('Invalid remote task-creation authentication context');
  }
  return authentication;
}

type RemoteTaskCreationOperationSubscriber = (
  authentication: RemoteCommandAuthentication,
  request: GetTaskCreationOperationRequest,
  listener: Parameters<TaskCreationWorkflow['subscribeOperation']>[2],
) => ReturnType<TaskCreationWorkflow['subscribeOperation']>;

export interface RemoteTaskCreationOperationSource {
  refreshOperation: TaskCreationWorkflow['refreshOperation'];
  subscribe: RemoteTaskCreationOperationSubscriber;
}

/**
 * The websocket transport supplies server-owned session evidence; this adapter
 * performs the same canonical authentication conversion as HTTP commands.
 */
export function createRemoteTaskCreationOperationSource(
  workflow: Pick<TaskCreationWorkflow, 'refreshOperation' | 'subscribeOperation'>,
): RemoteTaskCreationOperationSource {
  return {
    refreshOperation: (operationId) => workflow.refreshOperation(operationId),
    subscribe: (authentication, request, listener) =>
      workflow.subscribeOperation(toTaskCreationAuthentication(authentication), request, listener),
  };
}

function getCreateRequiredGrants(intent: Readonly<TaskCreationIntent>): readonly RemoteGrant[] {
  const grants: RemoteGrant[] = [];
  if (intent.location.kind === 'project-root') grants.push('task:create-root');
  if (intent.location.kind === 'existing-worktree') grants.push('task:create-imported');
  if (intent.launch.kind === 'agent' && intent.launch.skipPermissions) {
    grants.push('task:permission-bypass');
  }
  return grants;
}

function projectCapabilitiesForRemoteGrants(
  context: RemoteCommandExecutionContext,
  capabilities: Awaited<ReturnType<TaskCreationWorkflow['getCapabilities']>>,
): Awaited<ReturnType<TaskCreationWorkflow['getCapabilities']>> {
  const denied = { enabled: false as const, reason: 'not-authorized' as const };
  return {
    ...capabilities,
    locations: {
      ...capabilities.locations,
      'existing-worktree': context.hasGrant('task:create-imported')
        ? capabilities.locations['existing-worktree']
        : denied,
      'project-root': context.hasGrant('task:create-root')
        ? capabilities.locations['project-root']
        : denied,
    },
    permissionBypass: context.hasGrant('task:permission-bypass')
      ? capabilities.permissionBypass
      : denied,
  };
}

/**
 * The command table is the only remote transport adapter for creation. It converts
 * server-owned authentication evidence and validates both sides of every command.
 */
export function createTaskCreationRemoteCommandRegistrations(
  workflow: TaskCreationWorkflow,
): RemoteCommandRegistrationTable {
  return {
    'task-creation.cancel': {
      execute: (context, request) =>
        workflow.cancel(
          toTaskCreationAuthentication(context),
          requireRequest(request, isCancelTaskCreationOperationRequest, 'task-creation cancel'),
        ),
      isRequest: isCancelTaskCreationOperationRequest,
      isResult: isCancelTaskCreationOperationResult,
    },
    'task-creation.create': {
      execute: (context, request) =>
        workflow.create(
          toTaskCreationAuthentication(context),
          requireRequest<TaskCreationIntent>(request, isTaskCreationIntent, 'task-creation create'),
        ),
      isRequest: isTaskCreationIntent,
      isResult: isCreateTaskCreationOperationResult,
      requiredGrants: getCreateRequiredGrants,
    },
    'task-creation.get': {
      execute: (context, request) =>
        workflow.get(
          toTaskCreationAuthentication(context),
          requireRequest(request, isGetTaskCreationOperationRequest, 'task-creation status'),
        ),
      isRequest: isGetTaskCreationOperationRequest,
      isResult: isGetTaskCreationOperationResult,
    },
    'task-creation.get-capabilities': {
      execute: async (context, request) => {
        requireRequest(request, isEmptyRequest, 'task-creation capabilities');
        return projectCapabilitiesForRemoteGrants(
          context,
          await workflow.getCapabilities(toTaskCreationAuthentication(context)),
        );
      },
      isRequest: isEmptyRequest,
      isResult: isTaskCreationCapabilities,
    },
    'task-creation.get-picker-page': {
      execute: (context, request) =>
        workflow.getPickerPage(
          toTaskCreationAuthentication(context),
          requireRequest(request, isGetTaskCreationPickerPageRequest, 'task-creation picker page'),
        ),
      isRequest: isGetTaskCreationPickerPageRequest,
      isResult: isTaskCreationPickerPage,
      requiredGrants: (request) =>
        isGetTaskCreationPickerPageRequest(request) && request.kind === 'existing-worktree'
          ? ['task:create-imported']
          : [],
    },
    'task-creation.get-worktree-link-candidates': {
      execute: (context, request) =>
        workflow.getWorktreeLinkCandidates(
          toTaskCreationAuthentication(context),
          requireRequest(
            request,
            isGetTaskWorktreeLinkCandidatesRequest,
            'task-creation worktree-link candidates',
          ),
        ),
      isRequest: isGetTaskWorktreeLinkCandidatesRequest,
      isResult: isGetTaskWorktreeLinkCandidatesResult,
    },
    'task-creation.issue': {
      execute: (context, request) => {
        requireRequest(request, isEmptyRequest, 'task-creation ticket issue');
        return workflow.issue(toTaskCreationAuthentication(context));
      },
      isRequest: isEmptyRequest,
      isResult: isIssueTaskCreationOperationTicketResult,
    },
    'task-creation.retry-shell': {
      execute: (context, request) =>
        workflow.retryShell(
          toTaskCreationAuthentication(context),
          requireRequest(
            request,
            isRetryTaskShellSessionOperationRequest,
            'task-creation shell retry',
          ),
        ),
      isRequest: isRetryTaskShellSessionOperationRequest,
      isResult: isRetryTaskShellSessionOperationResult,
    },
  };
}
