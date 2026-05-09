import { describe, expect, it, vi } from 'vitest';

import { IPC } from './channels.js';

const {
  exposeTaskPortMock,
  getTaskPortExposureCandidatesMock,
  getTaskPortSnapshotsMock,
  revalidateTaskPortPreviewMock,
  unexposeTaskPortMock,
} = vi.hoisted(() => ({
  exposeTaskPortMock: vi.fn(),
  getTaskPortExposureCandidatesMock: vi.fn(),
  getTaskPortSnapshotsMock: vi.fn(),
  revalidateTaskPortPreviewMock: vi.fn(),
  unexposeTaskPortMock: vi.fn(),
}));

vi.mock('./task-ports.js', () => ({
  exposeTaskPort: exposeTaskPortMock,
  getTaskPortExposureCandidates: getTaskPortExposureCandidatesMock,
  getTaskPortSnapshots: getTaskPortSnapshotsMock,
  revalidateTaskPortPreview: revalidateTaskPortPreviewMock,
  unexposeTaskPort: unexposeTaskPortMock,
}));

import { createTaskPortIpcHandlers } from './task-port-handlers.js';

describe('createTaskPortIpcHandlers', () => {
  it('rejects invalid TCP ports before reaching the task-port owner', async () => {
    const handlers = createTaskPortIpcHandlers();

    expect(() =>
      handlers[IPC.ExposePort]?.({
        taskId: 'task-1',
        port: 0,
      }),
    ).toThrow('port must be an integer between 1 and 65535');
    await expect(
      handlers[IPC.RefreshTaskPortPreview]?.({
        taskId: 'task-1',
        port: 65_536,
      }),
    ).rejects.toThrow('port must be an integer between 1 and 65535');
    expect(() =>
      handlers[IPC.UnexposePort]?.({
        taskId: 'task-1',
        port: -1,
      }),
    ).toThrow('port must be an integer between 1 and 65535');

    expect(exposeTaskPortMock).not.toHaveBeenCalled();
    expect(revalidateTaskPortPreviewMock).not.toHaveBeenCalled();
    expect(unexposeTaskPortMock).not.toHaveBeenCalled();
  });
});
