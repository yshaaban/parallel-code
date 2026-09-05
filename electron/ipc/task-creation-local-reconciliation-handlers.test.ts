import { describe, expect, it, vi } from 'vitest';

import type { TaskCreationOperationId } from '../../src/domain/task-creation-ticket.js';
import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import { createTaskCreationLocalReconciliationIpcHandlers } from './task-creation-local-reconciliation-handlers.js';
import type { ProductionTaskExperienceRuntime } from './task-experience-runtime-composition.js';

const OPERATION_ID = Buffer.alloc(16, 1).toString('base64url') as TaskCreationOperationId;

function runtime() {
  const list = vi.fn(async () => ({ items: [], kind: 'page' as const, nextCursor: null }));
  const execute = vi.fn(async () => ({ kind: 'absent-or-superseded' as const }));
  return {
    execute,
    list,
    value: {
      localReconciliation: {
        electronMain: { execute, inspect: vi.fn(), list },
      },
    } as unknown as ProductionTaskExperienceRuntime,
  };
}

describe('task-creation local reconciliation IPC handlers', () => {
  it('injects the Electron-main command and accepts no caller authority', async () => {
    const test = runtime();
    const handlers = createTaskCreationLocalReconciliationIpcHandlers(test.value);

    await expect(handlers[IPC.ListTaskCreationReconciliations]?.({ limit: 10 })).resolves.toEqual({
      items: [],
      kind: 'page',
      nextCursor: null,
    });
    await expect(
      handlers[IPC.ExecuteTaskCreationReconciliation]?.({
        kind: 'inspect',
        operationId: OPERATION_ID,
      }),
    ).resolves.toEqual({ kind: 'absent-or-superseded' });

    expect(test.list).toHaveBeenCalledWith({ limit: 10 });
    expect(test.execute).toHaveBeenCalledWith({ kind: 'inspect', operationId: OPERATION_ID });
  });

  it('rejects forged authority and malformed actions before reaching the owner', async () => {
    const test = runtime();
    const handlers = createTaskCreationLocalReconciliationIpcHandlers(test.value);

    expect(() =>
      handlers[IPC.ListTaskCreationReconciliations]?.({ actor: 'electron-main' }),
    ).toThrow(BadRequestError);
    expect(() =>
      handlers[IPC.ExecuteTaskCreationReconciliation]?.({
        actor: 'electron-main',
        kind: 'inspect',
        operationId: OPERATION_ID,
      }),
    ).toThrow(BadRequestError);
    expect(test.list).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });
});
