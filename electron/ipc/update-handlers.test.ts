import { describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';
import { createUpdateIpcHandlers } from './update-handlers.js';

function createContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    isPackaged: false,
    sendToChannel: vi.fn(),
    userDataPath: '/tmp/parallel-code-update-handler-test',
    ...overrides,
  };
}

describe('update IPC handlers', () => {
  it('returns browser unsupported state when no Electron window exists', async () => {
    const handlers = createUpdateIpcHandlers(createContext());

    expect(handlers[IPC.GetUpdateStatus]?.()).toEqual({
      checkedAt: null,
      reason: 'browser',
      status: 'unsupported',
      supported: false,
    });
  });

  it('returns not-configured state for Electron builds without an updater controller', async () => {
    const handlers = createUpdateIpcHandlers(
      createContext({
        window: {
          close: vi.fn(),
          closeHandled: vi.fn(),
          focus: vi.fn(),
          forceClose: vi.fn(),
          getPosition: vi.fn(() => ({ x: 0, y: 0 })),
          getSize: vi.fn(() => ({ height: 600, width: 800 })),
          hide: vi.fn(),
          isFocused: vi.fn(() => true),
          isMaximized: vi.fn(() => false),
          maximize: vi.fn(),
          minimize: vi.fn(),
          setPosition: vi.fn(),
          setSize: vi.fn(),
          show: vi.fn(),
          toggleMaximize: vi.fn(),
          unmaximize: vi.fn(),
        },
      }),
    );

    expect(handlers[IPC.CheckForUpdates]?.()).toEqual({
      checkedAt: null,
      reason: 'not-configured',
      status: 'unsupported',
      supported: false,
    });
  });
});
