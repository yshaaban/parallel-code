import { describe, expect, it, vi } from 'vitest';

import { createIntendedTaskNotesWriterEntitlements } from '../../tests/harness/task-notes-writer-entitlements.js';
import { IPC } from './channels.js';
import {
  createTaskNotesIpcHandlers,
  createTrustedLocalTaskNotesIpcHandlers,
  type TaskNotesRequestAuthorization,
} from './task-notes-handlers.js';
import { createTaskNotesPrincipalContext, type TaskNotesService } from './task-notes-service.js';
import { DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS } from './task-notes-writer-entitlements.js';

const intended = createIntendedTaskNotesWriterEntitlements(['desktop']);

function createService() {
  return {
    getTaskNotes: vi.fn(async () => ({
      ok: true as const,
      result: { kind: 'task-state-unavailable' as const, retryAfterMs: 500 },
    })),
    issueTaskNotesOperation: vi.fn(async () => ({
      ok: true as const,
      result: { kind: 'task-state-unavailable' as const, retryAfterMs: 500 },
    })),
    updateTaskNotes: vi.fn(async () => ({
      ok: true as const,
      result: {
        kind: 'task-state-unavailable' as const,
        knownDisposition: { kind: 'unsettled' as const },
        retryAfterMs: 500,
      },
    })),
  } satisfies Pick<
    TaskNotesService,
    'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'
  >;
}

function authorization(
  grants: readonly ('notes:read' | 'notes:write')[],
): TaskNotesRequestAuthorization {
  return {
    grants: new Set(grants),
    principal: createTaskNotesPrincipalContext('workspace-principal', 'client-1', 'desktop'),
  };
}

describe('task notes IPC handlers', () => {
  it('derives principal and grants outside request JSON before forwarding each exact request', async () => {
    const service = createService();
    const getAuthorization = vi.fn(() => authorization(['notes:read', 'notes:write']));
    const handlers = createTaskNotesIpcHandlers({
      getAuthorization,
      service,
      writerEntitlement: intended.desktop,
      writerSurface: 'desktop',
    });
    const getRequest = { taskId: 'task-1' };
    const issueRequest = { taskId: 'task-1', taskIncarnation: 'A'.repeat(43) };
    const updateRequest = {
      taskId: 'task-1',
      taskIncarnation: 'A'.repeat(43),
      notes: 'notes',
      baseContentVersion: 'A'.repeat(43),
      operationId: 'A'.repeat(22),
      operationCapability: 'A'.repeat(43),
    };

    await handlers[IPC.GetTaskNotes]?.(getRequest);
    await handlers[IPC.IssueTaskNotesOperation]?.(issueRequest);
    await handlers[IPC.UpdateTaskNotes]?.(updateRequest);

    expect(getAuthorization.mock.calls).toEqual([['get'], ['issue'], ['update']]);
    const principal = authorization([]).principal;
    expect(service.getTaskNotes).toHaveBeenCalledWith(principal, getRequest);
    expect(service.issueTaskNotesOperation).toHaveBeenCalledWith(principal, issueRequest);
    expect(service.updateTaskNotes).toHaveBeenCalledWith(principal, updateRequest);
  });

  it('returns typed unauthenticated and forbidden responses before touching the service', async () => {
    const service = createService();
    const unauthenticated = createTaskNotesIpcHandlers({
      getAuthorization: () => ({ grants: new Set(), principal: null }),
      service,
      writerEntitlement: intended.desktop,
      writerSurface: 'desktop',
    });
    expect(await unauthenticated[IPC.GetTaskNotes]?.({ taskId: 'task-1' })).toEqual({
      ok: false,
      error: { code: 'unauthenticated' },
    });

    const forbidden = createTaskNotesIpcHandlers({
      getAuthorization: () => authorization(['notes:read']),
      service,
      writerEntitlement: intended.desktop,
      writerSurface: 'desktop',
    });
    expect(
      await forbidden[IPC.IssueTaskNotesOperation]?.({
        taskId: 'task-1',
        taskIncarnation: 'A'.repeat(43),
      }),
    ).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(await forbidden[IPC.UpdateTaskNotes]?.({ taskId: 'task-1' })).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(service.getTaskNotes).not.toHaveBeenCalled();
    expect(service.issueTaskNotesOperation).not.toHaveBeenCalled();
    expect(service.updateTaskNotes).not.toHaveBeenCalled();
  });

  it('lets the service own malformed-request classification after authorization', async () => {
    const service = createService();
    const handlers = createTaskNotesIpcHandlers({
      getAuthorization: () => authorization(['notes:read', 'notes:write']),
      service,
      writerEntitlement: intended.desktop,
      writerSurface: 'desktop',
    });

    await handlers[IPC.GetTaskNotes]?.(undefined);
    await handlers[IPC.IssueTaskNotesOperation]?.(undefined);
    await handlers[IPC.UpdateTaskNotes]?.(undefined);

    expect(service.getTaskNotes).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(service.issueTaskNotesOperation).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(service.updateTaskNotes).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('binds trusted local authority once while deferring service startup behind registered handlers', async () => {
    const service = createService();
    let resolveService: ((service: ReturnType<typeof createService>) => void) | undefined;
    const serviceReady = new Promise<ReturnType<typeof createService>>((resolve) => {
      resolveService = resolve;
    });
    const handlers = createTrustedLocalTaskNotesIpcHandlers({
      getService: () => serviceReady,
      principalId: 'local-workspace-owner',
      writerEntitlement: intended.desktop,
    });

    const response = handlers[IPC.GetTaskNotes]?.({ taskId: 'task-1' });
    let capabilitySettled = false;
    const capabilityResponse = Promise.resolve(handlers[IPC.GetTaskNotesCapability]?.()).then(
      (capability) => {
        capabilitySettled = true;
        return capability;
      },
    );
    expect(handlers).toHaveProperty(IPC.GetTaskNotes);
    await Promise.resolve();
    expect(capabilitySettled).toBe(false);
    expect(service.getTaskNotes).not.toHaveBeenCalled();
    resolveService?.(service);
    await response;
    expect(await capabilityResponse).toEqual({ read: true, write: true });

    expect(service.getTaskNotes).toHaveBeenCalledWith(
      createTaskNotesPrincipalContext('local-workspace-owner', undefined, 'desktop'),
      { taskId: 'task-1' },
    );
  });

  it('keeps local Issue dark while leaving Update classification to the service', async () => {
    const service = createService();
    const handlers = createTrustedLocalTaskNotesIpcHandlers({
      getService: async () => service,
      principalId: 'local-workspace-owner',
      writerEntitlement: DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS.desktop,
    });

    expect(await handlers[IPC.GetTaskNotesCapability]?.()).toEqual({ read: true, write: false });

    expect(
      await handlers[IPC.IssueTaskNotesOperation]?.({
        taskId: 'task-1',
        taskIncarnation: 'A'.repeat(43),
      }),
    ).toEqual({ ok: false, error: { code: 'forbidden' } });
    await handlers[IPC.UpdateTaskNotes]?.({ taskId: 'task-1' });
    expect(service.issueTaskNotesOperation).not.toHaveBeenCalled();
    expect(service.updateTaskNotes).toHaveBeenCalledOnce();
  });
});
