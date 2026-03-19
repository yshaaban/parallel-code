import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from './channels.js';

const { notificationClickHandlers, notificationIsSupportedMock, notificationShowMock } = vi.hoisted(
  () => ({
    notificationClickHandlers: [] as Array<() => void>,
    notificationIsSupportedMock: vi.fn(() => true),
    notificationShowMock: vi.fn(),
  }),
);

vi.mock('electron', () => {
  class NotificationMock {
    on = (event: string, handler: () => void) => {
      if (event === 'click') {
        notificationClickHandlers.push(handler);
      }

      return this;
    };

    show = notificationShowMock;

    constructor(options: { body: string; title: string }) {
      void options;
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
    notificationClickHandlers.length = 0;
    notificationIsSupportedMock.mockReturnValue(true);
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

    notificationClickHandlers[0]?.();

    expect(context.window?.show).toHaveBeenCalledTimes(1);
    expect(context.window?.focus).toHaveBeenCalledTimes(1);
    expect(context.emitIpcEvent).toHaveBeenCalledWith(IPC.NotificationClicked, {
      taskIds: ['task-1'],
    });
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
