import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeOnce: vi.fn(),
  invokeWithAbortSignal: vi.fn(),
}));

vi.mock('../lib/ipc', () => ipc);

import { desktopTaskNotesTransport } from './task-notes-transport';

describe('desktop task notes transport', () => {
  beforeEach(() => {
    ipc.invoke.mockReset();
    ipc.invokeOnce.mockReset();
    ipc.invokeWithAbortSignal.mockReset();
  });

  it('uses abortable Get, one-shot Issue, and idempotent Update transports', async () => {
    const failure = { ok: false, error: { code: 'forbidden' } } as const;
    ipc.invokeWithAbortSignal.mockResolvedValue(failure);
    ipc.invokeOnce.mockResolvedValue(failure);
    ipc.invoke.mockResolvedValue(failure);
    const abort = new AbortController();
    await expect(
      desktopTaskNotesTransport.get({ taskId: 'task-1' }, abort.signal),
    ).resolves.toEqual(failure);
    await expect(
      desktopTaskNotesTransport.issue({ taskId: 'task-1', taskIncarnation: 'A'.repeat(43) }),
    ).resolves.toEqual(failure);
    await expect(
      desktopTaskNotesTransport.update({
        taskId: 'task-1',
        taskIncarnation: 'A'.repeat(43),
        notes: 'draft',
        baseContentVersion: 'A'.repeat(43),
        operationId: 'A'.repeat(22),
        operationCapability: 'A'.repeat(43),
      }),
    ).resolves.toEqual(failure);
    expect(ipc.invokeWithAbortSignal).toHaveBeenCalledWith(IPC.GetTaskNotes, abort.signal, {
      taskId: 'task-1',
    });
    expect(ipc.invokeOnce).toHaveBeenCalledOnce();
    expect(ipc.invoke).toHaveBeenCalledOnce();
  });

  it('rejects malformed responses at the transport boundary', async () => {
    ipc.invokeOnce.mockResolvedValue({ ok: true, result: { kind: 'issued' } });
    await expect(
      desktopTaskNotesTransport.issue({ taskId: 'task-1', taskIncarnation: 'A'.repeat(43) }),
    ).rejects.toThrow('Invalid task-notes response');
  });
});
