import type {
  GetTaskNotesRequest,
  GetTaskNotesResult,
  IssueTaskNotesOperationRequest,
  IssueTaskNotesOperationResult,
  TaskNotesCapability,
  TaskNotesWireResponse,
  UpdateTaskNotesRequest,
  UpdateTaskNotesResult,
} from '../../src/domain/task-notes.js';
import { IPC } from './channels.js';
import type { ActiveTaskNotesService, IpcHandler } from './handler-context.js';
import {
  createTaskNotesPrincipalContext,
  type TaskNotesPrincipalContext,
  type TaskNotesService,
} from './task-notes-service.js';
import {
  isTaskNotesWriterEntitled,
  type TaskNotesWriterEntitlement,
  type TaskNotesWriterSurface,
} from './task-notes-writer-entitlements.js';

export type TaskNotesMethod = 'get' | 'issue' | 'update';

export interface TaskNotesRequestAuthorization {
  grants: ReadonlySet<'notes:read' | 'notes:write'>;
  principal: TaskNotesPrincipalContext | null;
}

export interface TaskNotesHandlerOptions {
  getAuthorization: (method: TaskNotesMethod) => TaskNotesRequestAuthorization;
  service: Pick<TaskNotesService, 'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'>;
  writerEntitlement: TaskNotesWriterEntitlement;
  writerSurface: TaskNotesWriterSurface;
}

export interface TrustedLocalTaskNotesHandlerOptions {
  getService: () => Promise<ActiveTaskNotesService>;
  principalId: string;
  sourceId?: string | null;
  writerEntitlement: TaskNotesWriterEntitlement;
}

function authorize<Result>(
  authorization: TaskNotesRequestAuthorization,
  requiredGrant: 'notes:read' | 'notes:write',
): TaskNotesWireResponse<Result> | TaskNotesPrincipalContext {
  if (!authorization.principal) {
    return { ok: false, error: { code: 'unauthenticated' } };
  }
  if (!authorization.grants.has(requiredGrant)) {
    return { ok: false, error: { code: 'forbidden' } };
  }
  return authorization.principal;
}

function isWireResponse<Result>(
  value: TaskNotesWireResponse<Result> | TaskNotesPrincipalContext,
): value is TaskNotesWireResponse<Result> {
  return Object.prototype.hasOwnProperty.call(value, 'ok');
}

/**
 * The sole transport-neutral Notes handler table. Authentication adapters supply a backend-derived
 * principal/grant view; request JSON never supplies either. Browser and Electron-remote hosts may
 * call the same table only through their scoped gateway.
 */
export function createTaskNotesIpcHandlers(
  options: TaskNotesHandlerOptions,
): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.GetTaskNotes]: (args) => {
      const principal = authorize<GetTaskNotesResult>(
        options.getAuthorization('get'),
        'notes:read',
      );
      return isWireResponse(principal)
        ? principal
        : options.service.getTaskNotes(principal, args as unknown as GetTaskNotesRequest);
    },
    [IPC.IssueTaskNotesOperation]: (args) => {
      const principal = authorize<IssueTaskNotesOperationResult>(
        options.getAuthorization('issue'),
        'notes:write',
      );
      return isWireResponse(principal)
        ? principal
        : !isTaskNotesWriterEntitled(options.writerEntitlement, options.writerSurface)
          ? { ok: false, error: { code: 'forbidden' } }
          : options.service.issueTaskNotesOperation(
              principal,
              args as unknown as IssueTaskNotesOperationRequest,
            );
    },
    [IPC.UpdateTaskNotes]: (args) => {
      const principal = authorize<UpdateTaskNotesResult>(
        options.getAuthorization('update'),
        'notes:write',
      );
      return isWireResponse(principal)
        ? principal
        : options.service.updateTaskNotes(principal, args as unknown as UpdateTaskNotesRequest);
    },
  };
}

/**
 * Production desktop/browser-desktop adapter. The trusted local identity and grants are fixed at
 * composition time while the deferred facade makes every channel callable from the first request;
 * durable runtime activation therefore has no handler-registration race.
 */
export function createTrustedLocalTaskNotesIpcHandlers(
  options: TrustedLocalTaskNotesHandlerOptions,
): Partial<Record<IPC, IpcHandler>> {
  const principal = createTaskNotesPrincipalContext(
    options.principalId,
    options.sourceId,
    'desktop',
  );
  const grants = new Set(['notes:read', 'notes:write'] as const);
  const service: ActiveTaskNotesService = {
    getTaskNotes: async (...args) => (await options.getService()).getTaskNotes(...args),
    issueTaskNotesOperation: async (...args) =>
      (await options.getService()).issueTaskNotesOperation(...args),
    updateTaskNotes: async (...args) => (await options.getService()).updateTaskNotes(...args),
  };
  return {
    [IPC.GetTaskNotesCapability]: async () => {
      await options.getService();
      return Object.freeze({
        read: true,
        write: isTaskNotesWriterEntitled(options.writerEntitlement, 'desktop'),
      } satisfies TaskNotesCapability);
    },
    ...createTaskNotesIpcHandlers({
      getAuthorization: () => ({ grants, principal }),
      service,
      writerEntitlement: options.writerEntitlement,
      writerSurface: 'desktop',
    }),
  };
}
