import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskCreationOperationId } from '../domain/task-creation-ticket.js';

const ipc = vi.hoisted(() => ({
  invokeOnce: vi.fn(),
  isElectronRuntime: vi.fn(),
}));

vi.mock('../lib/ipc.js', () => ipc);

import { IPC } from '../../electron/ipc/channels.js';
import {
  executeTaskCreationReconciliation,
  inspectTaskCreationReconciliation,
  listTaskCreationReconciliations,
} from './task-creation-local-reconciliation.js';

const OPERATION_ID = Buffer.alloc(16, 1).toString('base64url') as TaskCreationOperationId;

beforeEach(() => {
  ipc.invokeOnce.mockReset();
  ipc.isElectronRuntime.mockReset();
});

describe('desktop task-creation reconciliation client', () => {
  it('uses only the local Electron IPC channels', async () => {
    ipc.isElectronRuntime.mockReturnValue(true);
    ipc.invokeOnce
      .mockResolvedValueOnce({ items: [], kind: 'page', nextCursor: null })
      .mockResolvedValueOnce({ kind: 'absent-or-superseded' })
      .mockResolvedValueOnce({ kind: 'absent-or-superseded' });

    await listTaskCreationReconciliations({ limit: 10 });
    await inspectTaskCreationReconciliation(OPERATION_ID);
    await executeTaskCreationReconciliation({
      expectedRecordVersion: 2,
      kind: 'abandon-without-delete',
      operationId: OPERATION_ID,
    });

    expect(ipc.invokeOnce.mock.calls).toEqual([
      [IPC.ListTaskCreationReconciliations, { limit: 10 }],
      [IPC.ExecuteTaskCreationReconciliation, { kind: 'inspect', operationId: OPERATION_ID }],
      [
        IPC.ExecuteTaskCreationReconciliation,
        {
          expectedRecordVersion: 2,
          kind: 'abandon-without-delete',
          operationId: OPERATION_ID,
        },
      ],
    ]);
  });

  it('fails before transport in every browser runtime', async () => {
    ipc.isElectronRuntime.mockReturnValue(false);

    await expect(listTaskCreationReconciliations()).rejects.toThrow(
      'available only in the local desktop app',
    );
    await expect(inspectTaskCreationReconciliation(OPERATION_ID)).rejects.toThrow(
      'available only in the local desktop app',
    );
    expect(ipc.invokeOnce).not.toHaveBeenCalled();
  });
});
