import { describe, expect, it, vi } from 'vitest';

import type { TaskCatalogClientFacade } from '../domain/task-catalog';
import {
  REMOTE_TASK_CREATION_CAPABILITY_DARK,
  type TaskCreationClientFacade,
  type TaskCreationIntent,
} from '../domain/task-creation';
import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from '../domain/task-creation-ticket';
import { createGuardedRemoteTaskFacades } from './remote-task-creation-ipc';

const operationId = Buffer.alloc(16, 0x21).toString('base64url') as TaskCreationOperationId;
const operationCapability = Buffer.alloc(32, 0x22).toString(
  'base64url',
) as TaskCreationOperationCapability;

function createCatalogFacade(): TaskCatalogClientFacade {
  return {
    getDeltasSince: vi.fn(),
    getManifest: vi.fn(),
    getPage: vi.fn(),
  };
}

function createCreationFacade(): TaskCreationClientFacade {
  return {
    cancel: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    getCapabilities: vi.fn(),
    getPickerPage: vi.fn(),
    getWorktreeLinkCandidates: vi.fn(),
    issue: vi.fn(),
    retryShell: vi.fn(),
  };
}

function validIntent(): TaskCreationIntent {
  return {
    launch: { kind: 'terminal' },
    location: { kind: 'project-root' },
    name: 'remote-terminal',
    operationCapability,
    operationId,
    operationTicket: 'ticket-1',
    projectId: 'project-1',
    stepsTracking: true,
  };
}

describe('guarded remote task facades', () => {
  it('rejects malformed creation input before delegating to the host', async () => {
    const rawCatalog = createCatalogFacade();
    const rawCreation = createCreationFacade();
    const facades = createGuardedRemoteTaskFacades(rawCatalog, rawCreation);

    await expect(facades.creation.create({ ...validIntent(), name: 'bad\ud800' })).rejects.toThrow(
      'Invalid task-creation intent',
    );
    expect(rawCreation.create).not.toHaveBeenCalled();
  });

  it('rejects malformed catalog, capability, and ticket results at the client boundary', async () => {
    const rawCatalog = createCatalogFacade();
    const rawCreation = createCreationFacade();
    vi.mocked(rawCatalog.getManifest).mockResolvedValue({
      kind: 'found',
      value: 'unsafe',
    } as never);
    vi.mocked(rawCreation.getCapabilities).mockResolvedValue({ enabled: true } as never);
    vi.mocked(rawCreation.issue).mockResolvedValue({
      expiresAt: 2,
      issuedAt: 1,
      operationId,
      operationTicket: '',
    });
    const facades = createGuardedRemoteTaskFacades(rawCatalog, rawCreation);

    await expect(facades.catalog.getManifest()).rejects.toThrow(
      'Invalid task-catalog manifest response',
    );
    await expect(facades.creation.getCapabilities()).rejects.toThrow(
      'Invalid task-creation capability response',
    );
    await expect(facades.creation.issue()).rejects.toThrow('Invalid task-creation ticket response');
  });

  it('accepts valid guarded results and forwards abort signals unchanged', async () => {
    const rawCatalog = createCatalogFacade();
    const rawCreation = createCreationFacade();
    vi.mocked(rawCatalog.getManifest).mockResolvedValue({ kind: 'unavailable' });
    vi.mocked(rawCreation.getCapabilities).mockResolvedValue(REMOTE_TASK_CREATION_CAPABILITY_DARK);
    vi.mocked(rawCreation.issue).mockResolvedValue({
      expiresAt: 10_000,
      issuedAt: 1,
      operationId,
      operationTicket: 'ticket-1',
    });
    const facades = createGuardedRemoteTaskFacades(rawCatalog, rawCreation);
    const abortController = new AbortController();

    await expect(facades.catalog.getManifest(abortController.signal)).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(facades.creation.getCapabilities(abortController.signal)).resolves.toEqual(
      REMOTE_TASK_CREATION_CAPABILITY_DARK,
    );
    await expect(facades.creation.issue(abortController.signal)).resolves.toMatchObject({
      operationId,
      operationTicket: 'ticket-1',
    });
    expect(rawCatalog.getManifest).toHaveBeenCalledWith(abortController.signal);
    expect(rawCreation.getCapabilities).toHaveBeenCalledWith(abortController.signal);
    expect(rawCreation.issue).toHaveBeenCalledWith(abortController.signal);
  });
});
