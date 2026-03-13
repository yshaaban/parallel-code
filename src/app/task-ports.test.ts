import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getBrowserTokenMock, isElectronRuntimeMock } = vi.hoisted(() => ({
  getBrowserTokenMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
}));

vi.mock('../lib/browser-auth', () => ({
  getBrowserToken: getBrowserTokenMock,
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

import { buildTaskPreviewUrl, replaceTaskPortSnapshots } from './task-ports';

describe('task preview urls', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    replaceTaskPortSnapshots([]);
    getBrowserTokenMock.mockReset();
    isElectronRuntimeMock.mockReset();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          origin: 'http://127.0.0.1:3000',
        },
      },
    });
  });

  afterEach(() => {
    replaceTaskPortSnapshots([]);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('uses the detected port protocol for electron previews', () => {
    isElectronRuntimeMock.mockReturnValue(true);
    replaceTaskPortSnapshots([
      {
        taskId: 'task-1',
        exposed: [
          {
            host: 'localhost',
            label: 'Secure app',
            port: 3443,
            protocol: 'https',
            source: 'observed',
            updatedAt: 1_000,
          },
        ],
        observed: [],
        updatedAt: 1_000,
      },
    ]);

    expect(buildTaskPreviewUrl('task-1', 3443)).toBe('https://localhost:3443/');
  });

  it('uses the browser preview proxy for browser mode', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    getBrowserTokenMock.mockReturnValue('secret');

    expect(buildTaskPreviewUrl('task-1', 5173)).toBe(
      'http://127.0.0.1:3000/_preview/task-1/5173/?token=secret',
    );
  });

  it('falls back to loopback for electron previews when the detected host is not local', () => {
    isElectronRuntimeMock.mockReturnValue(true);
    replaceTaskPortSnapshots([
      {
        taskId: 'task-1',
        exposed: [
          {
            host: '10.0.0.5',
            label: 'Suspicious app',
            port: 3000,
            protocol: 'http',
            source: 'observed',
            updatedAt: 1_000,
          },
        ],
        observed: [],
        updatedAt: 1_000,
      },
    ]);

    expect(buildTaskPreviewUrl('task-1', 3000)).toBe('http://127.0.0.1:3000/');
  });
});
