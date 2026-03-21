import { beforeEach, describe, expect, it } from 'vitest';

import {
  getTerminalOutputDiagnosticsSnapshot,
  recordTerminalOutputRoute,
  recordTerminalOutputWrite,
  resetTerminalOutputDiagnostics,
} from './terminal-output-diagnostics';

describe('terminal-output-diagnostics', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __TERMINAL_OUTPUT_DIAGNOSTICS__: true,
      },
    });
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: {
        now: (() => {
          let now = 0;
          return () => {
            now += 5;
            return now;
          };
        })(),
      },
    });
    resetTerminalOutputDiagnostics();
  });

  it('tracks routed chunks, write cadence, and redraw control sequences', () => {
    recordTerminalOutputRoute({
      agentId: 'agent-1',
      chunkLength: 32,
      priority: 'focused',
      route: 'direct',
      taskId: 'task-1',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-1',
      chunk: new TextEncoder().encode('\x1b[s\x1b[20;1H\x1b[2Kstatus\x1b[u'),
      priority: 'focused',
      source: 'direct',
      taskId: 'task-1',
    });
    recordTerminalOutputRoute({
      agentId: 'agent-1',
      chunkLength: 64,
      priority: 'focused',
      route: 'queued',
      taskId: 'task-1',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-1',
      chunk: new TextEncoder().encode('\r\nsteady output\r\n'),
      priority: 'focused',
      source: 'queued',
      taskId: 'task-1',
    });

    expect(getTerminalOutputDiagnosticsSnapshot()).toEqual({
      terminals: [
        {
          agentId: 'agent-1',
          control: expect.objectContaining({
            carriageReturnChunks: 1,
            carriageReturnCount: 2,
            clearLineChunks: 1,
            clearLineCount: 1,
            cursorPositionChunks: 1,
            cursorPositionCount: 1,
            redrawChunks: 2,
            saveRestoreChunks: 1,
            saveRestoreCount: 2,
          }),
          key: 'task-1:agent-1',
          priority: 'focused',
          routed: expect.objectContaining({
            directBytes: 32,
            directChunks: 1,
            queuedBytes: 64,
            queuedChunks: 1,
            sizeBytes: expect.objectContaining({
              count: 2,
              p50: 32,
              p95: 64,
            }),
          }),
          taskId: 'task-1',
          writes: expect.objectContaining({
            calls: 2,
            directCalls: 1,
            directWriteBytes: 23,
            queuedCalls: 1,
            queuedWriteBytes: 17,
            intervalMs: expect.objectContaining({
              count: 1,
              p50: 5,
            }),
            sizeBytes: expect.objectContaining({
              count: 2,
            }),
          }),
        },
      ],
    });
  });
});
