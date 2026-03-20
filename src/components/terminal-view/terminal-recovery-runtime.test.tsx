import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../../electron/ipc/channels';
import type { TerminalRecoveryBatchEntry } from '../../ipc/types';

const {
  invokeMock,
  requestAttachTerminalRecoveryMock,
  requestReconnectTerminalRecoveryMock,
  requestTerminalRecoveryMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestAttachTerminalRecoveryMock: vi.fn(),
  requestReconnectTerminalRecoveryMock: vi.fn(),
  requestTerminalRecoveryMock: vi.fn(),
}));

vi.mock('../../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../../lib/scrollbackRestore', () => ({
  requestAttachTerminalRecovery: requestAttachTerminalRecoveryMock,
  requestReconnectTerminalRecovery: requestReconnectTerminalRecoveryMock,
  requestTerminalRecovery: requestTerminalRecoveryMock,
}));

import { createTerminalRecoveryRuntime } from './terminal-recovery-runtime';

function createRecoveryEntry(agentId: string): TerminalRecoveryBatchEntry {
  return {
    agentId,
    cols: 80,
    outputCursor: 0,
    recovery: { kind: 'noop' },
    requestId: 'req-1',
  };
}

function createSnapshotRecoveryEntry(
  agentId: string,
  byteLength: number,
): TerminalRecoveryBatchEntry {
  return {
    agentId,
    cols: 80,
    outputCursor: byteLength,
    recovery: {
      data: Buffer.alloc(byteLength, 97).toString('base64'),
      kind: 'snapshot',
    },
    requestId: 'req-snapshot',
  };
}

function createRecoveryRuntimeFixture(
  options: {
    outputPriority?: 'focused' | 'active-visible' | 'visible-background' | 'hidden';
  } = {},
): {
  runtime: ReturnType<typeof createTerminalRecoveryRuntime>;
  termWriteMock: ReturnType<typeof vi.fn>;
} {
  const termWriteMock = vi.fn((_: Uint8Array, callback?: () => void) => {
    callback?.();
  });

  return {
    runtime: createTerminalRecoveryRuntime({
      agentId: 'agent-1',
      channelId: 'channel-1',
      ensureTerminalFitReady: vi.fn().mockResolvedValue(true),
      getCurrentStatus: vi.fn<() => 'attaching'>(() => 'attaching'),
      getOutputPriority: vi.fn(() => options.outputPriority ?? 'focused'),
      inputPipeline: {
        drainInputQueue: vi.fn(),
        flushPendingInput: vi.fn(),
        flushPendingResize: vi.fn(),
      } as never,
      isDisposed: vi.fn(() => false),
      isSpawnFailed: vi.fn(() => false),
      isSpawnReady: vi.fn(() => true),
      markTerminalReady: vi.fn(),
      onRestoreSettled: vi.fn(),
      outputPipeline: {
        appendRenderedOutputHistory: vi.fn(),
        dropQueuedOutputForRecovery: vi.fn(),
        getRenderedOutputCursor: vi.fn(() => 0),
        getRenderedOutputHistory: vi.fn(() => new Uint8Array(0)),
        hasPendingFlowTransitions: vi.fn(() => false),
        hasQueuedOutput: vi.fn(() => false),
        hasWriteInFlight: vi.fn(() => false),
        recoverFlowControlIfIdle: vi.fn(),
        scheduleOutputFlush: vi.fn(),
        setRenderedOutputCursor: vi.fn(),
        setRenderedOutputHistory: vi.fn(),
      } as never,
      setStatus: vi.fn(),
      term: {
        reset: vi.fn(),
        scrollToBottom: vi.fn(),
        write: termWriteMock,
      } as never,
    }),
    termWriteMock,
  };
}

describe('createTerminalRecoveryRuntime', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    invokeMock.mockReset();
    requestAttachTerminalRecoveryMock.mockReset();
    requestReconnectTerminalRecoveryMock.mockReset();
    requestTerminalRecoveryMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    requestAttachTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    requestReconnectTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    requestTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the batched attach recovery helper for initial attach restores', async () => {
    const { runtime } = createRecoveryRuntimeFixture();

    await runtime.restoreTerminalOutput('attach');

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 0,
      renderedTail: null,
    });
    expect(requestReconnectTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenNthCalledWith(1, IPC.PauseAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'restore',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'restore',
    });
  });

  it.each([
    ['focused', 2],
    ['active-visible', 2],
    ['visible-background', 4],
    ['hidden', 7],
  ] as const)(
    'replays snapshot restore chunks with the production %s chunk size',
    async (outputPriority, expectedWriteCount) => {
      requestAttachTerminalRecoveryMock.mockResolvedValue(
        createSnapshotRecoveryEntry('agent-1', 400 * 1024),
      );
      const { runtime, termWriteMock } = createRecoveryRuntimeFixture({ outputPriority });

      await runtime.restoreTerminalOutput('attach');

      expect(termWriteMock).toHaveBeenCalledTimes(expectedWriteCount);
    },
  );
});
