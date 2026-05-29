import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isElectronRuntimeMock } = vi.hoisted(() => ({
  isElectronRuntimeMock: vi.fn(),
}));

vi.mock('../lib/browser-auth', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

import { buildTaskContainerPreviewUrl } from './task-containers';

describe('task container preview urls', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    isElectronRuntimeMock.mockReset();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          origin: 'http://127.0.0.1:43117',
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('uses a distinct browser preview namespace from exposed task ports', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    expect(
      buildTaskContainerPreviewUrl('task-1', {
        port: 3000,
        protocol: 'http',
      }),
    ).toBe('http://127.0.0.1:43117/_container_preview/task-1/3000/');
  });

  it('uses the published loopback port directly in Electron', () => {
    isElectronRuntimeMock.mockReturnValue(true);

    expect(
      buildTaskContainerPreviewUrl('task-1', {
        port: 3443,
        protocol: 'https',
      }),
    ).toBe('https://127.0.0.1:3443/');
  });
});
