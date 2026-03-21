import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from './channels.js';

const {
  notificationClickHandlers,
  notificationInstances,
  notificationIsSupportedMock,
  notificationShowMock,
} = vi.hoisted(() => ({
  notificationInstances: [] as Array<{ emit: (event: 'click' | 'close') => void }>,
  notificationClickHandlers: [] as Array<() => void>,
  notificationIsSupportedMock: vi.fn(() => true),
  notificationShowMock: vi.fn(),
}));

vi.mock('electron', () => {
  class NotificationMock {
    handlers = {
      click: [] as Array<() => void>,
      close: [] as Array<() => void>,
    };

    on = (event: string, handler: () => void) => {
      if (event === 'click') {
        this.handlers.click.push(handler);
        notificationClickHandlers.push(handler);
      }

      if (event === 'close') {
        this.handlers.close.push(handler);
      }

      return this;
    };

    show = notificationShowMock;

    emit = (event: 'click' | 'close') => {
      this.handlers[event].forEach((handler) => handler());
    };

    close = () => {
      this.emit('close');
    };

    constructor(options: { body: string; title: string }) {
      void options;
      notificationInstances.push(this);
    }
  }

  const electronModule = {
    Notification: Object.assign(NotificationMock, {
      isSupported: notificationIsSupportedMock,
    }),
  };

  return {
    ...electronModule,
    default: electronModule,
  };
});

import { BadRequestError, createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(): HandlerContext {
  return {
    dialog: undefined,
    emitIpcEvent: vi.fn(),
    isPackaged: false,
    remoteAccess: undefined,
    sendToChannel: vi.fn(),
    shell: undefined,
    userDataPath: '/tmp/parallel-code-tests',
    window: {
      close: vi.fn(),
      focus: vi.fn(),
      forceClose: vi.fn(),
      getPosition: vi.fn(() => ({ x: 0, y: 0 })),
      getSize: vi.fn(() => ({ height: 720, width: 1280 })),
      hide: vi.fn(),
      isFocused: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      maximize: vi.fn(),
      minimize: vi.fn(),
      setPosition: vi.fn(),
      setSize: vi.fn(),
      show: vi.fn(),
      toggleMaximize: vi.fn(),
      unmaximize: vi.fn(),
    },
  };
}

describe('notification IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    notificationInstances.length = 0;
    notificationClickHandlers.length = 0;
    notificationIsSupportedMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows a desktop notification and focuses the window on click', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.ShowNotification]?.({
      body: 'Task 1 is ready for review',
      taskIds: ['task-1'],
      title: 'Task Ready',
    });

    expect(notificationShowMock).toHaveBeenCalledTimes(1);

    notificationInstances[0]?.emit('click');

    expect(context.window?.show).toHaveBeenCalledTimes(1);
    expect(context.window?.focus).toHaveBeenCalledTimes(1);
    expect(context.emitIpcEvent).toHaveBeenCalledWith(IPC.NotificationClicked, {
      taskIds: ['task-1'],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the notification until it is closed', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.ShowNotification]?.({
      body: 'Task 1 is ready for review',
      taskIds: ['task-1'],
      title: 'Task Ready',
    });

    expect(notificationShowMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    notificationInstances[0]?.emit('close');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the retained notification after the ttl expires', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.ShowNotification]?.({
      body: 'Task 1 is ready for review',
      taskIds: ['task-1'],
      title: 'Task Ready',
    });

    expect(notificationShowMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the retained notification if show fails', () => {
    notificationShowMock.mockImplementationOnce(() => {
      throw new Error('show failed');
    });

    const handlers = createIpcHandlers(buildContext());

    expect(() =>
      handlers[IPC.ShowNotification]?.({
        body: 'Task 1 is ready for review',
        taskIds: ['task-1'],
        title: 'Task Ready',
      }),
    ).toThrow('show failed');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports whether native desktop notifications are supported', () => {
    notificationIsSupportedMock.mockReturnValue(false);
    const handlers = createIpcHandlers(buildContext());

    expect(handlers[IPC.GetNotificationCapability]?.(undefined)).toBe(false);
  });

  it('skips the native notification call when the platform does not support it', () => {
    notificationIsSupportedMock.mockReturnValue(false);
    const handlers = createIpcHandlers(buildContext());

    handlers[IPC.ShowNotification]?.({
      body: 'Task 1 is ready for review',
      taskIds: ['task-1'],
      title: 'Task Ready',
    });

    expect(notificationShowMock).not.toHaveBeenCalled();
  });

  it('rejects blank titles and invalid task id payloads', () => {
    const handlers = createIpcHandlers(buildContext());

    expect(() =>
      handlers[IPC.ShowNotification]?.({
        body: 'Task 1 is ready for review',
        taskIds: ['task-1'],
        title: '   ',
      }),
    ).toThrow(BadRequestError);

    expect(() =>
      handlers[IPC.ShowNotification]?.({
        body: 'Task 1 is ready for review',
        taskIds: ['task-1', 42],
        title: 'Task Ready',
      }),
    ).toThrow(BadRequestError);
  });
});
