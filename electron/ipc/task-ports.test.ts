import { createServer } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RediscoveredTaskPortMock {
  host: string | null;
  port: number;
  suggestion: string;
  taskId: string;
}

const { rediscoverTaskPortsMock } = vi.hoisted(() => ({
  rediscoverTaskPortsMock: vi.fn<() => RediscoveredTaskPortMock[]>(() => []),
}));

vi.mock('./port-discovery.js', () => ({
  rediscoverTaskPorts: rediscoverTaskPortsMock,
}));
import {
  clearTaskPortRegistry,
  exposeTaskPort,
  getExposedTaskPort,
  getTaskPortSnapshots,
  observeTaskPortsFromOutput,
  restoreSavedTaskPorts,
  revalidateTaskPortPreview,
  removeTaskPorts,
  subscribeTaskPorts,
  unexposeTaskPort,
} from './task-ports.js';

describe('task port registry', () => {
  beforeEach(() => {
    clearTaskPortRegistry();
    rediscoverTaskPortsMock.mockReset();
    rediscoverTaskPortsMock.mockReturnValue([]);
  });

  it('detects observed ports from PTY output once per port', () => {
    const snapshot = observeTaskPortsFromOutput(
      'task-1',
      'VITE v6 ready in 200ms\nLocal: http://127.0.0.1:5173/\n',
    );

    expect(snapshot).toMatchObject({
      taskId: 'task-1',
      observed: [
        expect.objectContaining({
          host: '127.0.0.1',
          port: 5173,
          protocol: 'http',
          source: 'output',
        }),
      ],
    });

    expect(
      observeTaskPortsFromOutput(
        'task-1',
        'Local: http://127.0.0.1:5173/\nAnother line mentioning localhost:5173\n',
      ),
    ).toBeNull();
  });

  it('preserves detected https ports when exposing them', () => {
    observeTaskPortsFromOutput('task-https', 'Local: https://127.0.0.1:3443/\n');

    const exposed = exposeTaskPort('task-https', 3443, 'Secure app');

    expect(exposed.observed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        port: 3443,
        protocol: 'https',
      }),
    ]);
    expect(exposed.exposed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        port: 3443,
        protocol: 'https',
        source: 'observed',
      }),
    ]);
  });

  it('updates an observed port when later output provides stronger protocol details', () => {
    observeTaskPortsFromOutput('task-upgrade', 'Listening on port 3443\n');

    const upgraded = observeTaskPortsFromOutput('task-upgrade', 'Local: https://127.0.0.1:3443/\n');

    expect(upgraded?.observed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        port: 3443,
        protocol: 'https',
      }),
    ]);
  });

  it('keeps generic listening detections hostless for safe loopback exposure', () => {
    const snapshot = observeTaskPortsFromOutput('task-generic', 'Server listening on port 3000\n');

    expect(snapshot?.observed).toEqual([
      expect.objectContaining({
        host: null,
        port: 3000,
        protocol: 'http',
      }),
    ]);
  });

  it('exposes and unexposes task ports', () => {
    observeTaskPortsFromOutput('task-1', 'Local: http://127.0.0.1:3001/');

    const exposed = exposeTaskPort('task-1', 3001, 'Frontend');
    expect(exposed.exposed).toEqual([
      expect.objectContaining({
        host: '127.0.0.1',
        label: 'Frontend',
        port: 3001,
        protocol: 'http',
        source: 'observed',
      }),
    ]);
    expect(getExposedTaskPort('task-1', 3001)).toMatchObject({
      label: 'Frontend',
      port: 3001,
    });

    const afterUnexpose = unexposeTaskPort('task-1', 3001);
    expect(afterUnexpose).toMatchObject({
      taskId: 'task-1',
      exposed: [],
      observed: [expect.objectContaining({ port: 3001 })],
    });
  });

  it('emits removed events when task port state is deleted', () => {
    const events: Array<unknown> = [];
    const unsubscribe = subscribeTaskPorts((event) => {
      events.push(event);
    });

    exposeTaskPort('task-1', 8080, 'App');
    removeTaskPorts('task-1');
    unsubscribe();

    expect(events).toContainEqual({
      taskId: 'task-1',
      removed: true,
    });
    expect(getTaskPortSnapshots()).toEqual([]);
  });

  it('restores exposed port intent from saved state', () => {
    restoreSavedTaskPorts(
      JSON.stringify({
        tasks: {
          'task-1': {
            id: 'task-1',
            worktreePath: '/tmp/worktree-1',
            exposedPorts: [
              {
                port: 4173,
                label: 'Frontend',
                protocol: 'https',
                source: 'manual',
              },
            ],
          },
        },
      }),
    );

    expect(getExposedTaskPort('task-1', 4173)).toMatchObject({
      availability: 'unknown',
      host: null,
      label: 'Frontend',
      port: 4173,
      protocol: 'https',
      source: 'manual',
      statusMessage: null,
      verifiedHost: null,
    });
  });

  it('preserves saved https exposure protocol during restart rediscovery', () => {
    rediscoverTaskPortsMock.mockReturnValue([
      {
        taskId: 'task-1',
        host: '127.0.0.1',
        port: 4173,
        suggestion: 'Rediscovered localhost:4173',
      },
    ]);

    restoreSavedTaskPorts(
      JSON.stringify({
        tasks: {
          'task-1': {
            id: 'task-1',
            worktreePath: '/tmp/worktree-1',
            exposedPorts: [
              {
                port: 4173,
                label: 'Frontend',
                protocol: 'https',
                source: 'manual',
              },
            ],
          },
        },
      }),
    );

    expect(getExposedTaskPort('task-1', 4173)).toMatchObject({
      host: '127.0.0.1',
      port: 4173,
      protocol: 'https',
    });
  });

  it('marks exposed ports available after successful preview revalidation', async () => {
    const server = createServer((_req, res) => {
      res.end('ok');
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind preview test server');
    }

    exposeTaskPort('task-available', address.port, 'Preview');
    const snapshot = await revalidateTaskPortPreview('task-available', address.port);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    expect(snapshot?.exposed).toEqual([
      expect.objectContaining({
        availability: 'available',
        port: address.port,
        verifiedHost: '127.0.0.1',
      }),
    ]);
  });
});
