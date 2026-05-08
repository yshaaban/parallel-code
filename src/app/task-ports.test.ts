import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemovedTaskPortsEvent, createTaskPortsSnapshotEvent } from '../domain/server-state';

const { isElectronRuntimeMock } = vi.hoisted(() => ({
  isElectronRuntimeMock: vi.fn(),
}));

vi.mock('../lib/browser-auth', () => ({
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

import {
  applyTaskPortsEvent,
  buildTaskPreviewUrl,
  getTaskPortSnapshot,
  replaceTaskPortSnapshots,
  resetTaskPortsProjectionStateForTests,
} from './task-ports';

describe('task preview urls', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    resetTaskPortsProjectionStateForTests();
    replaceTaskPortSnapshots([]);
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
    resetTaskPortsProjectionStateForTests();
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
            availability: 'available',
            host: 'localhost',
            label: 'Secure app',
            lastVerifiedAt: 1_000,
            port: 3443,
            protocol: 'https',
            statusMessage: null,
            source: 'observed',
            updatedAt: 1_000,
            verifiedHost: 'localhost',
          },
        ],
        observed: [],
        updatedAt: 1_000,
      },
    ]);

    expect(buildTaskPreviewUrl('task-1', 3443)).toBe('https://localhost:3443/');
  });

  it('prefers the verified host for electron previews', () => {
    isElectronRuntimeMock.mockReturnValue(true);
    replaceTaskPortSnapshots([
      {
        taskId: 'task-1',
        exposed: [
          {
            availability: 'available',
            host: null,
            label: 'Verified app',
            lastVerifiedAt: 1_000,
            port: 4173,
            protocol: 'http',
            statusMessage: null,
            source: 'manual',
            updatedAt: 1_000,
            verifiedHost: '::1',
          },
        ],
        observed: [],
        updatedAt: 1_000,
      },
    ]);

    expect(buildTaskPreviewUrl('task-1', 4173)).toBe('http://[::1]:4173/');
  });

  it('uses the browser preview proxy for browser mode', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    expect(buildTaskPreviewUrl('task-1', 5173)).toBe('http://127.0.0.1:3000/_preview/task-1/5173/');
  });

  it('falls back to loopback for electron previews when the detected host is not local', () => {
    isElectronRuntimeMock.mockReturnValue(true);
    replaceTaskPortSnapshots([
      {
        taskId: 'task-1',
        exposed: [
          {
            availability: 'available',
            host: '10.0.0.5',
            label: 'Suspicious app',
            lastVerifiedAt: 1_000,
            port: 3000,
            protocol: 'http',
            statusMessage: null,
            source: 'observed',
            updatedAt: 1_000,
            verifiedHost: null,
          },
        ],
        observed: [],
        updatedAt: 1_000,
      },
    ]);

    expect(buildTaskPreviewUrl('task-1', 3000)).toBe('http://127.0.0.1:3000/');
  });

  it('ignores stale versioned task-port snapshot and removal events after a newer replacement', () => {
    replaceTaskPortSnapshots(
      [
        {
          taskId: 'task-1',
          exposed: [],
          observed: [],
          updatedAt: 2_000,
        },
      ],
      { replaceVersion: 2 },
    );

    applyTaskPortsEvent({
      ...createTaskPortsSnapshotEvent({
        taskId: 'task-1',
        exposed: [],
        observed: [],
        updatedAt: 1_000,
      }),
      stateVersion: 1,
    });
    applyTaskPortsEvent({
      ...createRemovedTaskPortsEvent('task-1'),
      stateVersion: 1,
    });

    expect(getTaskPortSnapshot('task-1')).toEqual({
      taskId: 'task-1',
      exposed: [],
      observed: [],
      updatedAt: 2_000,
    });
  });

  it('ignores stale unversioned task-port invoke echoes after versioned backend truth', () => {
    applyTaskPortsEvent({
      ...createTaskPortsSnapshotEvent({
        taskId: 'task-1',
        exposed: [
          {
            availability: 'available',
            host: '127.0.0.1',
            label: 'Fresh app',
            lastVerifiedAt: 1_000,
            port: 5173,
            protocol: 'http',
            source: 'manual',
            statusMessage: null,
            updatedAt: 1_000,
            verifiedHost: '127.0.0.1',
          },
        ],
        observed: [],
        updatedAt: 1_000,
      }),
      stateVersion: 2,
    });

    applyTaskPortsEvent(
      createTaskPortsSnapshotEvent({
        taskId: 'task-1',
        exposed: [],
        observed: [],
        updatedAt: 1_000,
      }),
    );

    expect(getTaskPortSnapshot('task-1')?.exposed).toEqual([
      expect.objectContaining({
        label: 'Fresh app',
        port: 5173,
      }),
    ]);

    applyTaskPortsEvent({
      ...createRemovedTaskPortsEvent('task-1'),
      stateVersion: 3,
    });
    applyTaskPortsEvent(
      createTaskPortsSnapshotEvent({
        taskId: 'task-1',
        exposed: [
          {
            availability: 'available',
            host: '127.0.0.1',
            label: 'Stale app',
            lastVerifiedAt: 1_000,
            port: 5173,
            protocol: 'http',
            source: 'manual',
            statusMessage: null,
            updatedAt: 1_000,
            verifiedHost: '127.0.0.1',
          },
        ],
        observed: [],
        updatedAt: 1_000,
      }),
    );

    expect(getTaskPortSnapshot('task-1')).toBeUndefined();
  });
});
