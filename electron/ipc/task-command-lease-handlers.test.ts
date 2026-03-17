import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';
import { createTaskCommandLeaseIpcHandlers } from './task-command-lease-handlers.js';
import { resetTaskCommandLeasesForTest } from './task-command-leases.js';

function buildContext(): HandlerContext {
  return {
    emitIpcEvent: vi.fn(),
    isPackaged: false,
    sendToChannel: vi.fn(),
    userDataPath: '/tmp/task-command-lease-handlers',
  };
}

describe('task-command lease handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskCommandLeasesForTest();
  });

  it('emits only the typed controller snapshot when a lease changes', () => {
    const context = buildContext();
    const handlers = createTaskCommandLeaseIpcHandlers(context);

    const acquired = handlers[IPC.AcquireTaskCommandLease]?.({
      action: 'merge this task',
      clientId: 'client-a',
      taskId: 'task-1',
    });
    const denied = handlers[IPC.AcquireTaskCommandLease]?.({
      action: 'push this task',
      clientId: 'client-b',
      taskId: 'task-1',
    });
    const released = handlers[IPC.ReleaseTaskCommandLease]?.({
      clientId: 'client-a',
      taskId: 'task-1',
    });

    expect(acquired).toMatchObject({
      acquired: true,
      controllerId: 'client-a',
      taskId: 'task-1',
      version: 1,
    });
    expect(denied).toMatchObject({
      acquired: false,
      controllerId: 'client-a',
      taskId: 'task-1',
      version: 1,
    });
    expect(released).toEqual({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 2,
    });
    expect(context.emitIpcEvent).toHaveBeenNthCalledWith(1, IPC.TaskCommandControllerChanged, {
      action: 'merge this task',
      controllerId: 'client-a',
      taskId: 'task-1',
      version: 1,
    });
    expect(context.emitIpcEvent).toHaveBeenNthCalledWith(2, IPC.TaskCommandControllerChanged, {
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 2,
    });
  });

  it('lists the current task command controllers', () => {
    const context = buildContext();
    const handlers = createTaskCommandLeaseIpcHandlers(context);

    handlers[IPC.AcquireTaskCommandLease]?.({
      action: 'merge this task',
      clientId: 'client-a',
      taskId: 'task-1',
    });
    handlers[IPC.AcquireTaskCommandLease]?.({
      action: 'push this task',
      clientId: 'client-b',
      taskId: 'task-2',
    });

    expect(handlers[IPC.GetTaskCommandControllers]?.()).toEqual({
      controllers: [
        {
          action: 'merge this task',
          controllerId: 'client-a',
          taskId: 'task-1',
          version: 2,
        },
        {
          action: 'push this task',
          controllerId: 'client-b',
          taskId: 'task-2',
          version: 2,
        },
      ],
      version: 2,
    });
  });
});
