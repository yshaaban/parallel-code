import {
  isCancelTaskCreationOperationResult,
  isCreateTaskCreationOperationResult,
  isGetTaskCreationOperationResult,
  isGetTaskWorktreeLinkCandidatesResult,
  isIssueTaskCreationOperationTicketResult,
  isTaskCreationCapabilities,
  isTaskCreationIntent,
  isTaskCreationPickerPage,
  type TaskCreationClientFacade,
} from '../domain/task-creation';
import { isRetryTaskShellSessionOperationResult } from '../domain/task-shell-session-operation';
import {
  isTaskCatalogDeltaBatch,
  isTaskCatalogFetchResult,
  isTaskCatalogPage,
  isTaskCatalogReplaceManifest,
  type TaskCatalogClientFacade,
} from '../domain/task-catalog';
import { invokeScopedRemoteCommand } from './remote-ipc';

function requireResponse<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  context: string,
): T {
  if (!guard(value)) throw new Error(`Invalid ${context} response`);
  return value;
}

export const remoteTaskCreationFacade: TaskCreationClientFacade = {
  cancel: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-creation.cancel',
      request,
      isCancelTaskCreationOperationResult,
      signal,
    ),
  create: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-creation.create',
      request,
      isCreateTaskCreationOperationResult,
      signal,
    ),
  get: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-creation.get',
      request,
      isGetTaskCreationOperationResult,
      signal,
    ),
  getCapabilities: (signal) =>
    invokeScopedRemoteCommand(
      'task-creation.get-capabilities',
      {},
      isTaskCreationCapabilities,
      signal,
    ),
  getPickerPage: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-creation.get-picker-page',
      request,
      isTaskCreationPickerPage,
      signal,
    ),
  getWorktreeLinkCandidates: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-creation.get-worktree-link-candidates',
      request,
      isGetTaskWorktreeLinkCandidatesResult,
      signal,
    ),
  issue: (signal) =>
    invokeScopedRemoteCommand(
      'task-creation.issue',
      {},
      isIssueTaskCreationOperationTicketResult,
      signal,
    ),
  retryShell: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-creation.retry-shell',
      request,
      isRetryTaskShellSessionOperationResult,
      signal,
    ),
};

export function createGuardedRemoteTaskFacades(
  catalog: TaskCatalogClientFacade,
  creation: TaskCreationClientFacade,
): { catalog: TaskCatalogClientFacade; creation: TaskCreationClientFacade } {
  return {
    catalog: {
      async getDeltasSince(request, signal) {
        return requireResponse(
          await catalog.getDeltasSince(request, signal),
          (value) => isTaskCatalogFetchResult(value, isTaskCatalogDeltaBatch),
          'task-catalog delta',
        );
      },
      async getManifest(signal) {
        return requireResponse(
          await catalog.getManifest(signal),
          (value) => isTaskCatalogFetchResult(value, isTaskCatalogReplaceManifest),
          'task-catalog manifest',
        );
      },
      async getPage(request, signal) {
        return requireResponse(
          await catalog.getPage(request, signal),
          (value) => isTaskCatalogFetchResult(value, isTaskCatalogPage),
          'task-catalog page',
        );
      },
    },
    creation: {
      async cancel(request, signal) {
        return requireResponse(
          await creation.cancel(request, signal),
          isCancelTaskCreationOperationResult,
          'task-creation cancel',
        );
      },
      async create(intent, signal) {
        if (!isTaskCreationIntent(intent)) throw new Error('Invalid task-creation intent');
        return requireResponse(
          await creation.create(intent, signal),
          isCreateTaskCreationOperationResult,
          'task-creation create',
        );
      },
      async get(request, signal) {
        return requireResponse(
          await creation.get(request, signal),
          isGetTaskCreationOperationResult,
          'task-creation status',
        );
      },
      async getCapabilities(signal) {
        return requireResponse(
          await creation.getCapabilities(signal),
          isTaskCreationCapabilities,
          'task-creation capability',
        );
      },
      async getPickerPage(request, signal) {
        return requireResponse(
          await creation.getPickerPage(request, signal),
          isTaskCreationPickerPage,
          'task-creation picker',
        );
      },
      async getWorktreeLinkCandidates(request, signal) {
        return requireResponse(
          await creation.getWorktreeLinkCandidates(request, signal),
          isGetTaskWorktreeLinkCandidatesResult,
          'task-creation worktree-link candidate',
        );
      },
      async issue(signal) {
        return requireResponse(
          await creation.issue(signal),
          isIssueTaskCreationOperationTicketResult,
          'task-creation ticket',
        );
      },
      async retryShell(request, signal) {
        return requireResponse(
          await creation.retryShell(request, signal),
          isRetryTaskShellSessionOperationResult,
          'task-creation shell retry',
        );
      },
    },
  };
}
