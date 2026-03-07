import { afterEach, describe, expect, it, vi } from 'vitest';

const resizeMock = vi.fn();
const writeMock = vi.fn();
const killMock = vi.fn();
const pauseMock = vi.fn();
const resumeMock = vi.fn();

let onDataHandler: ((data: string) => void) | undefined;
let onExitHandler:
  | ((event: { exitCode: number; signal?: number | string | undefined }) => void)
  | undefined;

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    resize: resizeMock,
    write: writeMock,
    kill: killMock,
    pause: pauseMock,
    resume: resumeMock,
    onData: (cb: (data: string) => void) => {
      onDataHandler = cb;
    },
    onExit: (cb: (event: { exitCode: number; signal?: number | string | undefined }) => void) => {
      onExitHandler = cb;
    },
  })),
}));

vi.mock('./command-resolver.js', () => ({
  validateCommand: vi.fn(),
}));

import { spawnAgent } from './pty.js';

function buildSpawnArgs(channelId: string, channelBindSeq: number) {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    command: '/bin/sh',
    args: [],
    cwd: '/',
    env: {},
    cols: 80,
    rows: 24,
    channelBindSeq,
    onOutput: { __CHANNEL_ID__: channelId },
  };
}

afterEach(() => {
  onExitHandler?.({ exitCode: 0, signal: 0 });
  onDataHandler = undefined;
  onExitHandler = undefined;
  vi.clearAllMocks();
});

describe('spawnAgent attach ordering', () => {
  it('keeps routing output to the newest bound channel', () => {
    const sent: Array<{ channelId: string; msg: unknown }> = [];
    const sendToChannel = (channelId: string, msg: unknown) => {
      sent.push({ channelId, msg });
    };

    spawnAgent(sendToChannel, buildSpawnArgs('channel-old', 1));
    spawnAgent(sendToChannel, buildSpawnArgs('channel-new', 3));

    expect(() => spawnAgent(sendToChannel, buildSpawnArgs('channel-stale', 2))).toThrow(
      /Stale terminal attach request ignored/,
    );

    onDataHandler?.('hello');

    expect(sent).toContainEqual({
      channelId: 'channel-new',
      msg: {
        type: 'Data',
        data: Buffer.from('hello', 'utf8').toString('base64'),
      },
    });
    expect(sent).not.toContainEqual(
      expect.objectContaining({
        channelId: 'channel-stale',
      }),
    );
  });
});
