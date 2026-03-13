import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTaskPortRegistry,
  exposeTaskPort,
  getExposedTaskPort,
  getTaskPortSnapshots,
  observeTaskPortsFromOutput,
  removeTaskPorts,
  subscribeTaskPorts,
  unexposeTaskPort,
} from './task-ports.js';

describe('task port registry', () => {
  beforeEach(() => {
    clearTaskPortRegistry();
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
});
