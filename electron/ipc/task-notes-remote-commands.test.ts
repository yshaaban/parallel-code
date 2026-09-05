import { describe, expect, it, vi } from 'vitest';
import { createIntendedTaskNotesWriterEntitlements } from '../../tests/harness/task-notes-writer-entitlements.js';
import { createTaskNotesContentVersion } from './task-notes-operations.js';
import { createTaskNotesRemoteCommandRegistrations } from './task-notes-remote-commands.js';
import type {
  RemoteCommandExecutionContext,
  RemoteCommandName,
  RemoteCommandRegistrationTable,
} from './remote-command-gateway.js';
import type { TaskNotesService } from './task-notes-service.js';
import { DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS } from './task-notes-writer-entitlements.js';

const intended = createIntendedTaskNotesWriterEntitlements(['remote']);

const context: RemoteCommandExecutionContext = {
  authEpoch: 'epoch',
  authenticationSessionGeneration: 'generation',
  hasGrant: () => true,
  principalId: 'workspace-owner',
  sourceId: 'mobile-1',
};

function createService() {
  return {
    getTaskNotes: vi.fn(async (_principal: unknown, _request: unknown) => ({
      ok: true as const,
      result: { kind: 'not-found' as const, current: { relation: 'task-removed' as const } },
    })),
    issueTaskNotesOperation: vi.fn(async (_principal: unknown, _request: unknown) => ({
      ok: true as const,
      result: { kind: 'not-found' as const },
    })),
    updateTaskNotes: vi.fn(async (_principal: unknown, _request: unknown) => ({
      ok: true as const,
      result: {
        kind: 'no-change' as const,
        current: {
          notes: '',
          contentVersion: createTaskNotesContentVersion(''),
          taskIncarnation: 'incarnation',
        },
        knownDisposition: { kind: 'unknown' as const },
      },
    })),
  };
}

function requireRegistration(
  registrations: RemoteCommandRegistrationTable,
  name: RemoteCommandName,
) {
  const registration = registrations[name];
  if (!registration) throw new Error(`Missing ${name} registration`);
  return registration;
}

describe('task notes remote registrations', () => {
  it('binds the server-authenticated principal and source to every method', async () => {
    const service = createService();
    const registrations = createTaskNotesRemoteCommandRegistrations(
      service as unknown as Pick<
        TaskNotesService,
        'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'
      >,
      intended.remote,
    );
    const get = requireRegistration(registrations, 'task-notes.get');
    const issue = requireRegistration(registrations, 'task-notes.issue');
    await get.execute(context, { taskId: 'task-1' });
    await issue.execute(context, {
      acknowledgedOperations: [],
      taskId: 'task-1',
      taskIncarnation: 'incarnation',
    });
    expect(service.getTaskNotes.mock.calls[0]?.[0]).toEqual({
      principalHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      sourceId: 'mobile-1',
      writerSurface: 'remote',
    });
    expect(service.issueTaskNotesOperation.mock.calls[0]?.[0]).toEqual(
      service.getTaskNotes.mock.calls[0]?.[0],
    );
  });

  it('keeps request and response contracts method-specific', async () => {
    const service = createService();
    const registrations = createTaskNotesRemoteCommandRegistrations(
      service as unknown as Pick<
        TaskNotesService,
        'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'
      >,
      intended.remote,
    );
    const get = requireRegistration(registrations, 'task-notes.get');
    const issue = requireRegistration(registrations, 'task-notes.issue');
    expect(get.isRequest({ taskId: 'task-1' })).toBe(true);
    expect(get.isRequest({ taskId: 'task-1', taskIncarnation: 'wrong-method' })).toBe(false);
    expect(
      issue.isResult(
        await issue.execute(context, {
          acknowledgedOperations: [],
          taskId: 'task-1',
          taskIncarnation: 'incarnation',
        }),
      ),
    ).toBe(true);
    expect(
      get.isResult(
        await issue.execute(context, {
          acknowledgedOperations: [],
          taskId: 'task-1',
          taskIncarnation: 'incarnation',
        }),
      ),
    ).toBe(false);
  });

  it('withdraws remote Issue while retaining Update for service-owned replay and recovery', async () => {
    const service = createService();
    const registrations = createTaskNotesRemoteCommandRegistrations(
      service as unknown as Pick<
        TaskNotesService,
        'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'
      >,
      DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS.remote,
    );
    const issue = requireRegistration(registrations, 'task-notes.issue');
    const update = requireRegistration(registrations, 'task-notes.update');

    expect(issue.isAvailable?.()).toBe(false);
    expect(update.isAvailable?.()).not.toBe(false);
    expect(await issue.execute(context, {})).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    await update.execute(context, {});
    expect(service.issueTaskNotesOperation).not.toHaveBeenCalled();
    expect(service.updateTaskNotes).toHaveBeenCalledOnce();
  });
});
