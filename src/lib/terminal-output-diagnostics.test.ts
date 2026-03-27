import { beforeEach, describe, expect, it } from 'vitest';

import {
  getTerminalOutputDiagnosticsSnapshot,
  recordTerminalRenderEvent,
  recordTerminalRenderResize,
  recordTerminalOutputRoute,
  recordTerminalOutputSuppressed,
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
      queueAgeMs: 12,
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
      queueAgeMs: 24,
      source: 'queued',
      taskId: 'task-1',
    });
    recordTerminalOutputSuppressed({
      agentId: 'agent-1',
      chunkLength: 19,
      priority: 'hidden',
      taskId: 'task-1',
    });

    expect(getTerminalOutputDiagnosticsSnapshot()).toEqual({
      summary: {
        queueAgeMs: {
          byLane: {
            focused: {
              count: 2,
              max: 24,
              total: 36,
            },
            hidden: {
              count: 0,
              max: 0,
              total: 0,
            },
            visible: {
              count: 0,
              max: 0,
              total: 0,
            },
          },
          byPriority: {
            'active-visible': {
              count: 0,
              max: 0,
              total: 0,
            },
            focused: {
              count: 2,
              max: 24,
              total: 36,
            },
            hidden: {
              count: 0,
              max: 0,
              total: 0,
            },
            'switch-target-visible': {
              count: 0,
              max: 0,
              total: 0,
            },
            'visible-background': {
              count: 0,
              max: 0,
              total: 0,
            },
          },
          bySource: {
            direct: {
              count: 1,
              max: 12,
              total: 12,
            },
            queued: {
              count: 1,
              max: 24,
              total: 24,
            },
          },
        },
        routed: {
          byLane: {
            focused: {
              bytes: 96,
              chunks: 2,
            },
            hidden: {
              bytes: 0,
              chunks: 0,
            },
            visible: {
              bytes: 0,
              chunks: 0,
            },
          },
          byPriority: {
            'active-visible': {
              bytes: 0,
              chunks: 0,
            },
            focused: {
              bytes: 96,
              chunks: 2,
            },
            hidden: {
              bytes: 0,
              chunks: 0,
            },
            'switch-target-visible': {
              bytes: 0,
              chunks: 0,
            },
            'visible-background': {
              bytes: 0,
              chunks: 0,
            },
          },
          bySource: {
            direct: {
              bytes: 32,
              chunks: 1,
            },
            queued: {
              bytes: 64,
              chunks: 1,
            },
          },
        },
        suppressed: {
          byLane: {
            focused: {
              bytes: 0,
              chunks: 0,
            },
            hidden: {
              bytes: 19,
              chunks: 1,
            },
            visible: {
              bytes: 0,
              chunks: 0,
            },
          },
          byPriority: {
            'active-visible': {
              bytes: 0,
              chunks: 0,
            },
            focused: {
              bytes: 0,
              chunks: 0,
            },
            hidden: {
              bytes: 19,
              chunks: 1,
            },
            'switch-target-visible': {
              bytes: 0,
              chunks: 0,
            },
            'visible-background': {
              bytes: 0,
              chunks: 0,
            },
          },
          totalBytes: 19,
          totalChunks: 1,
        },
        writes: {
          byLane: {
            focused: {
              bytes: 40,
              calls: 2,
            },
            hidden: {
              bytes: 0,
              calls: 0,
            },
            visible: {
              bytes: 0,
              calls: 0,
            },
          },
          byPriority: {
            'active-visible': {
              bytes: 0,
              calls: 0,
            },
            focused: {
              bytes: 40,
              calls: 2,
            },
            hidden: {
              bytes: 0,
              calls: 0,
            },
            'switch-target-visible': {
              bytes: 0,
              calls: 0,
            },
            'visible-background': {
              bytes: 0,
              calls: 0,
            },
          },
          bySource: {
            direct: {
              bytes: 23,
              calls: 1,
            },
            queued: {
              bytes: 17,
              calls: 1,
            },
          },
          totalBytes: 40,
          totalCalls: 2,
        },
      },
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
          priority: 'hidden',
          render: expect.objectContaining({
            maxChangedVisibleLines: 0,
            renderCalls: 0,
            resizeEvents: 0,
          }),
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
          suppressed: {
            bytes: 19,
            chunks: 1,
          },
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

  it('tracks switch-target-visible output in the visible lane and by-priority rollups', () => {
    recordTerminalOutputRoute({
      agentId: 'agent-2',
      chunkLength: 48,
      priority: 'switch-target-visible',
      route: 'queued',
      taskId: 'task-2',
    });
    recordTerminalOutputWrite({
      agentId: 'agent-2',
      chunk: new TextEncoder().encode('switch target output'),
      priority: 'switch-target-visible',
      queueAgeMs: 30,
      source: 'queued',
      taskId: 'task-2',
    });

    const snapshot = getTerminalOutputDiagnosticsSnapshot();

    expect(snapshot.summary.queueAgeMs.byPriority['switch-target-visible']).toEqual({
      count: 1,
      max: 30,
      total: 30,
    });
    expect(snapshot.summary.routed.byPriority['switch-target-visible']).toEqual({
      bytes: 48,
      chunks: 1,
    });
    expect(snapshot.summary.writes.byPriority['switch-target-visible']).toEqual({
      bytes: 20,
      calls: 1,
    });
    expect(snapshot.summary.writes.byLane.visible).toEqual({
      bytes: 20,
      calls: 1,
    });
  });

  it('tracks visible line churn, viewport jumps, cursor movement, and resize events', () => {
    const lines = ['one', 'two', 'three', 'four'];
    const activeBuffer = {
      cursorY: 1,
      getLine(y: number) {
        const value = lines[y];
        if (value === undefined) {
          return undefined;
        }

        return {
          translateToString() {
            return value;
          },
        };
      },
      viewportY: 0,
    };
    const term = {
      buffer: {
        active: activeBuffer,
      },
      rows: 3,
    } as unknown as Parameters<typeof recordTerminalRenderEvent>[0]['term'];

    recordTerminalRenderEvent({
      agentId: 'agent-render',
      endRow: 2,
      startRow: 0,
      taskId: 'task-render',
      term,
    });

    lines[1] = 'two updated';
    activeBuffer.cursorY = 2;
    activeBuffer.viewportY = 1;
    recordTerminalRenderResize({
      agentId: 'agent-render',
      taskId: 'task-render',
    });
    recordTerminalRenderEvent({
      agentId: 'agent-render',
      endRow: 2,
      startRow: 1,
      taskId: 'task-render',
      term,
    });

    const terminal = getTerminalOutputDiagnosticsSnapshot().terminals.find(
      (entry) => entry.key === 'task-render:agent-render',
    );

    expect(terminal?.render).toEqual(
      expect.objectContaining({
        maxChangedVisibleLines: 3,
        maxCursorRowJump: 1,
        maxRowSpan: 3,
        maxViewportJumpRows: 1,
        renderCalls: 2,
        resizeEvents: 1,
        changedVisibleLines: expect.objectContaining({
          count: 2,
          max: 3,
          p95: 3,
        }),
        cursorRowJump: expect.objectContaining({
          count: 2,
          max: 1,
          p95: 1,
        }),
        viewportJumpRows: expect.objectContaining({
          count: 2,
          max: 1,
          p95: 1,
        }),
      }),
    );
  });
});
