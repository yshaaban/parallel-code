import {
  isGetTaskNotesRequest,
  isGetTaskNotesWireResponse,
  isIssueTaskNotesOperationRequest,
  isIssueTaskNotesOperationWireResponse,
  isUpdateTaskNotesRequest,
  isUpdateTaskNotesWireResponse,
  type GetTaskNotesRequest,
  type IssueTaskNotesOperationRequest,
  type UpdateTaskNotesRequest,
} from '../../src/domain/task-notes.js';
import type { RemoteCommandRegistrationTable } from './remote-command-gateway.js';
import { createTaskNotesPrincipalContext, type TaskNotesService } from './task-notes-service.js';
import {
  isTaskNotesWriterEntitled,
  type TaskNotesWriterEntitlement,
} from './task-notes-writer-entitlements.js';

/** Strict scoped adapter; the service remains the only notes policy owner. */
export function createTaskNotesRemoteCommandRegistrations(
  service: Pick<TaskNotesService, 'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'>,
  writerEntitlement: TaskNotesWriterEntitlement,
): RemoteCommandRegistrationTable {
  const writeAvailable = () => isTaskNotesWriterEntitled(writerEntitlement, 'remote');
  return {
    'task-notes.get': {
      execute: (context, request) =>
        service.getTaskNotes(
          createTaskNotesPrincipalContext(context.principalId, context.sourceId, 'remote'),
          request as GetTaskNotesRequest,
        ),
      isRequest: isGetTaskNotesRequest,
      isResult: isGetTaskNotesWireResponse,
    },
    'task-notes.issue': {
      execute: (context, request) =>
        writeAvailable()
          ? service.issueTaskNotesOperation(
              createTaskNotesPrincipalContext(context.principalId, context.sourceId, 'remote'),
              request as IssueTaskNotesOperationRequest,
            )
          : { ok: false, error: { code: 'forbidden' as const } },
      isAvailable: writeAvailable,
      isRequest: isIssueTaskNotesOperationRequest,
      isResult: isIssueTaskNotesOperationWireResponse,
    },
    'task-notes.update': {
      execute: (context, request) =>
        service.updateTaskNotes(
          createTaskNotesPrincipalContext(context.principalId, context.sourceId, 'remote'),
          request as UpdateTaskNotesRequest,
        ),
      isRequest: isUpdateTaskNotesRequest,
      isResult: isUpdateTaskNotesWireResponse,
    },
  };
}
