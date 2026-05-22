import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { observeTaskPortsFromOutputMock, spawnMock } = vi.hoisted(() => ({
  observeTaskPortsFromOutputMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

vi.mock('./task-ports.js', () => ({
  observeTaskPortsFromOutput: observeTaskPortsFromOutputMock,
}));

import {
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
  killAllAgents,
  spawnAgent,
} from './pty.js';
import { TerminalStateMirror } from './terminal-state-mirror.js';

type MockProc = {
  cols: number;
  rows: number;
  pause: () => void;
  resume: () => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number | null; signal?: number | null }) => void) => void;
  emitData: (data: string) => void;
};

function createMockProc(): MockProc {
  let onDataCb: ((data: string) => void) | undefined;
  let onExitCb: ((info: { exitCode: number | null; signal?: number | null }) => void) | undefined;

  const proc: MockProc = {
    cols: 96,
    rows: 32,
    pause: vi.fn(),
    resume: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      proc.cols = cols;
      proc.rows = rows;
    }),
    write: vi.fn(),
    kill: vi.fn(() => onExitCb?.({ exitCode: 0, signal: null })),
    onData: vi.fn((cb) => {
      onDataCb = cb;
    }),
    onExit: vi.fn((cb) => {
      onExitCb = cb;
    }),
    emitData: (data: string) => {
      onDataCb?.(data);
    },
  };

  return proc;
}

function createControlHeavyTuiChunks(options: {
  cols: number;
  frames: number;
  rows: number;
}): Buffer[] {
  const promptRow = Math.max(3, Math.floor(options.rows / 2));
  const statusRow = Math.max(1, options.rows - 2);
  const footerRow = options.rows;
  const chunks: Buffer[] = [
    Buffer.from(
      [
        '\x1b[?1049h',
        '\x1b[?25l',
        '\x1b[2J',
        '\x1b[1;1Hcontrol-redraw fixture',
        `\x1b[${statusRow};1Hstatus: starting`,
        `\x1b[${promptRow};4Hinput>`,
      ].join(''),
      'utf8',
    ),
  ];

  for (let frame = 0; frame < options.frames; frame += 1) {
    const spinner = ['|', '/', '-', '\\'][frame % 4] ?? '|';
    chunks.push(
      Buffer.from(
        [
          '\x1b[s',
          `\x1b[2;1Hframe ${String(frame).padStart(3, '0')} ${spinner}`,
          `\x1b[${statusRow};1H`,
          '\x1b[2K',
          `status: ${String(frame).padStart(3, '0')} `.padEnd(Math.max(10, options.cols - 1), '.'),
          `\x1b[${promptRow};4H`,
          '\x1b[2K',
          `input> cursor-target-${String(frame).padStart(3, '0')}`,
          `\x1b[${footerRow};1H`,
          '\x1b[2K',
          'footer',
          '\x1b[u',
        ].join(''),
        'utf8',
      ),
    );
  }

  chunks.push(Buffer.from(`\x1b[?25h\x1b[${promptRow};11H`, 'utf8'));
  return chunks;
}

function getChunkBoundaryCursors(chunks: Buffer[], ratios: number[]): number[] {
  const totalBytes = Buffer.concat(chunks).length;
  const boundaries: number[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    cursor += chunk.length;
    boundaries.push(cursor);
  }

  return ratios.map((ratio) => {
    const target = totalBytes * ratio;
    return (
      boundaries.find((boundary) => boundary >= target && boundary < totalBytes) ??
      boundaries[0] ??
      0
    );
  });
}

async function replayIntoMirror(chunks: readonly Buffer[]): Promise<Buffer> {
  const mirror = new TerminalStateMirror(96, 32);
  try {
    for (const chunk of chunks) {
      mirror.enqueueOutput(chunk);
    }
    const state = await mirror.serialize();
    if (!state) {
      throw new Error('expected serialized terminal state');
    }
    return state.data;
  } finally {
    mirror.dispose();
  }
}

beforeEach(() => {
  spawnMock.mockReset();
  observeTaskPortsFromOutputMock.mockReset();
});

afterEach(() => {
  killAllAgents();
});

describe('cursor-addressed TUI recovery', () => {
  it('returns serialized terminal state for startup recovery instead of scrollback snapshots', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const chunks = createControlHeavyTuiChunks({ cols: 96, frames: 96, rows: 32 });

    spawnAgent(vi.fn(), {
      taskId: 'task-tui-startup',
      agentId: 'agent-tui-startup',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 96,
      rows: 32,
      onOutput: { __CHANNEL_ID__: 'startup-channel' },
    });

    for (const chunk of chunks) {
      proc.emitData(chunk.toString('utf8'));
    }

    const expectedState = await replayIntoMirror(chunks);
    const recovery = await getAgentTerminalStartupRecovery(
      'agent-tui-startup',
      Buffer.from('stale-renderer-tail', 'utf8'),
      1,
      'selected',
      1,
    );

    expect(recovery.kind).toBe('terminal-state');
    if (recovery.kind !== 'terminal-state') {
      throw new Error('expected terminal-state recovery');
    }
    expect(recovery.cols).toBe(96);
    expect(recovery.rows).toBe(32);
    expect(recovery.outputCursor).toBe(Buffer.concat(chunks).length);
    expect(recovery.data).toEqual(expectedState);
  });

  it('reconstructs cursor-addressed TUI state from retained cursor deltas', async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValueOnce(proc);
    const chunks = createControlHeavyTuiChunks({ cols: 96, frames: 180, rows: 32 });
    const allOutput = Buffer.concat(chunks);

    spawnAgent(vi.fn(), {
      taskId: 'task-tui-delta',
      agentId: 'agent-tui-delta',
      command: '/bin/sh',
      args: [],
      cwd: '/',
      env: {},
      cols: 96,
      rows: 32,
      onOutput: { __CHANNEL_ID__: 'delta-channel' },
    });

    for (const chunk of chunks) {
      proc.emitData(chunk.toString('utf8'));
    }

    const expectedState = await replayIntoMirror(chunks);
    for (const cutCursor of getChunkBoundaryCursors(chunks, [0.25, 0.5, 0.8])) {
      const stalePrefix = allOutput.subarray(0, cutCursor);
      const recovery = getAgentTerminalRecovery('agent-tui-delta', null, cutCursor, null);

      expect(recovery.kind).toBe('delta');
      if (recovery.kind !== 'delta') {
        throw new Error('expected cursor delta recovery');
      }
      expect(recovery.source).toBe('cursor');
      expect(recovery.overlapBytes).toBe(0);
      expect(recovery.outputCursor).toBe(allOutput.length);
      expect(recovery.data).toEqual(allOutput.subarray(cutCursor));

      const restoredState = await replayIntoMirror([stalePrefix, recovery.data]);
      expect(restoredState).toEqual(expectedState);
    }
  }, 15_000);
});
