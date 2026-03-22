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
    currentStatus?: 'attaching' | 'binding' | 'error' | 'ready' | 'restoring';
    isDisposed?: () => boolean;
    isSpawnFailed?: () => boolean;
    isSpawnReady?: () => boolean;
    hasPendingFlowTransitions?: (() => boolean) | boolean;
    hasWriteInFlight?: (() => boolean) | boolean;
    renderedOutputCursor?: number;
    renderedOutputHistory?: Uint8Array;
    outputPriority?: 'focused' | 'active-visible' | 'visible-background' | 'hidden';
    hasQueuedOutput?: (() => boolean) | boolean;
  } = {},
): {
  markTerminalReadyMock: ReturnType<typeof vi.fn>;
  onRestoreSettledMock: ReturnType<typeof vi.fn>;
  runtime: ReturnType<typeof createTerminalRecoveryRuntime>;
  setStatusMock: ReturnType<typeof vi.fn>;
  outputPipelineMock: {
    appendRenderedOutputHistory: ReturnType<typeof vi.fn>;
    dropQueuedOutputForRecovery: ReturnType<typeof vi.fn>;
    getRenderedOutputCursor: ReturnType<typeof vi.fn>;
    getRenderedOutputHistory: ReturnType<typeof vi.fn>;
    hasPendingFlowTransitions: ReturnType<typeof vi.fn>;
    hasQueuedOutput: ReturnType<typeof vi.fn>;
    hasWriteInFlight: ReturnType<typeof vi.fn>;
    recoverFlowControlIfIdle: ReturnType<typeof vi.fn>;
    scheduleOutputFlush: ReturnType<typeof vi.fn>;
    setRenderedOutputCursor: ReturnType<typeof vi.fn>;
    setRenderedOutputHistory: ReturnType<typeof vi.fn>;
  };
  termWriteMock: ReturnType<typeof vi.fn>;
} {
  const termWriteMock = vi.fn((_: Uint8Array, callback?: () => void) => {
    callback?.();
  });
  const markTerminalReadyMock = vi.fn();
  const onRestoreSettledMock = vi.fn();
  const setStatusMock = vi.fn();
  const outputPipelineMock = {
    appendRenderedOutputHistory: vi.fn(),
    dropQueuedOutputForRecovery: vi.fn(),
    getRenderedOutputCursor: vi.fn(() => options.renderedOutputCursor ?? 0),
    getRenderedOutputHistory: vi.fn(() => options.renderedOutputHistory ?? new Uint8Array(0)),
    hasPendingFlowTransitions: vi.fn(() =>
      typeof options.hasPendingFlowTransitions === 'function'
        ? options.hasPendingFlowTransitions()
        : (options.hasPendingFlowTransitions ?? false),
    ),
    hasQueuedOutput: vi.fn(() =>
      typeof options.hasQueuedOutput === 'function'
        ? options.hasQueuedOutput()
        : (options.hasQueuedOutput ?? false),
    ),
    hasWriteInFlight: vi.fn(() =>
      typeof options.hasWriteInFlight === 'function'
        ? options.hasWriteInFlight()
        : (options.hasWriteInFlight ?? false),
    ),
    recoverFlowControlIfIdle: vi.fn(),
    scheduleOutputFlush: vi.fn(),
    setRenderedOutputCursor: vi.fn(),
    setRenderedOutputHistory: vi.fn(),
  };

  return {
    markTerminalReadyMock,
    onRestoreSettledMock,
    runtime: createTerminalRecoveryRuntime({
      agentId: 'agent-1',
      channelId: 'channel-1',
      ensureTerminalFitReady: vi.fn().mockResolvedValue(true),
      getCurrentStatus: vi.fn(() => options.currentStatus ?? 'attaching'),
      getOutputPriority: vi.fn(() => options.outputPriority ?? 'focused'),
      inputPipeline: {
        drainInputQueue: vi.fn(),
        flushPendingInput: vi.fn(),
        flushPendingResize: vi.fn(),
      } as never,
      isDisposed: vi.fn(() => options.isDisposed?.() ?? false),
      isSpawnFailed: vi.fn(() => options.isSpawnFailed?.() ?? false),
      isSpawnReady: vi.fn(() => options.isSpawnReady?.() ?? true),
      markTerminalReady: markTerminalReadyMock,
      onRestoreSettled: onRestoreSettledMock,
      outputPipeline: outputPipelineMock as never,
      setStatus: setStatusMock,
      term: {
        refresh: vi.fn(),
        reset: vi.fn(),
        scrollToBottom: vi.fn(),
        write: termWriteMock,
      } as never,
    }),
    setStatusMock,
    outputPipelineMock,
    termWriteMock,
  };
}

function createDeltaRecoveryEntry(agentId: string, byteLength: number): TerminalRecoveryBatchEntry {
  return {
    agentId,
    cols: 80,
    outputCursor: byteLength,
    recovery: {
      data: Buffer.alloc(byteLength, 97).toString('base64'),
      kind: 'delta',
      overlapBytes: 0,
      source: 'tail',
    },
    requestId: 'req-delta',
  };
}

function createDeltaRecoveryEntryWithSource(
  agentId: string,
  byteLength: number,
  source: 'cursor' | 'tail',
  overlapBytes = 0,
): TerminalRecoveryBatchEntry {
  return {
    agentId,
    cols: 80,
    outputCursor: byteLength,
    recovery: {
      data: Buffer.alloc(byteLength, 97).toString('base64'),
      kind: 'delta',
      overlapBytes,
      source,
    },
    requestId: 'req-delta-source',
  };
}

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
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

  it('uses the shared terminal-recovery helper for backpressure restores', async () => {
    await createRecoveryRuntimeFixture().runtime.restoreTerminalOutput('backpressure');

    expect(requestTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 0,
      renderedTail: null,
    });
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestReconnectTerminalRecoveryMock).not.toHaveBeenCalled();
  });

  it('uses the reconnect recovery helper for direct reconnect requests', async () => {
    const { runtime } = createRecoveryRuntimeFixture({ renderedOutputCursor: 7 });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 7,
      renderedTail: null,
    });
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestTerminalRecoveryMock).not.toHaveBeenCalled();
  });

  it('uses snapshot history and cursor metadata for each recovery reason except renderer-loss', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 16 * 1024),
    );
    requestTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 16 * 1024),
    );
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 16 * 1024),
    );
    const renderedOutputHistory = Buffer.from('restore-tail', 'utf8');
    const { runtime } = createRecoveryRuntimeFixture({
      renderedOutputHistory,
      renderedOutputCursor: 33,
    });

    await runtime.restoreTerminalOutput('attach');
    await runtime.restoreTerminalOutput('backpressure');
    await runtime.restoreTerminalOutput('reconnect');

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 33,
      renderedTail: renderedOutputHistory.toString('base64'),
    });
    expect(requestTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 33,
      renderedTail: renderedOutputHistory.toString('base64'),
    });
    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 33,
      renderedTail: renderedOutputHistory.toString('base64'),
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

  it('replays reconnect restores with the live rendered tail and priority-sized delta chunks', async () => {
    const renderedOutputHistory = Buffer.from('restore-tail', 'utf8');
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createDeltaRecoveryEntry('agent-1', 400 * 1024),
    );
    const { runtime, outputPipelineMock, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 12,
      renderedOutputHistory,
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await expect.poll(() => requestReconnectTerminalRecoveryMock.mock.calls.length).toBe(1);
    await expect.poll(() => termWriteMock.mock.calls.length).toBe(2);

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 12,
      renderedTail: renderedOutputHistory.toString('base64'),
    });
    expect(outputPipelineMock.dropQueuedOutputForRecovery).toHaveBeenCalledTimes(1);
  });

  it('replays cursor-delimited delta recovery without overlapping history', async () => {
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createDeltaRecoveryEntryWithSource('agent-1', 128, 'cursor'),
    );
    const { runtime, outputPipelineMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 12,
      renderedOutputHistory: Buffer.from('existing-prefix', 'utf8'),
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await expect.poll(() => requestReconnectTerminalRecoveryMock.mock.calls.length).toBe(1);

    expect(outputPipelineMock.appendRenderedOutputHistory).toHaveBeenCalledWith(
      expect.any(Uint8Array),
    );
    expect(outputPipelineMock.setRenderedOutputHistory).not.toHaveBeenCalled();
  });

  it('treats noop recovery as a cursor-only transition', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    const { runtime, outputPipelineMock, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 17,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.setRenderedOutputCursor).toHaveBeenCalledWith(0);
    expect(outputPipelineMock.appendRenderedOutputHistory).not.toHaveBeenCalled();
    expect(outputPipelineMock.setRenderedOutputHistory).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();
    expect(outputPipelineMock.dropQueuedOutputForRecovery).toHaveBeenCalled();
  });

  it('does not switch into blocking restore state for attach when not ready', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    const { runtime, setStatusMock } = createRecoveryRuntimeFixture({
      currentStatus: 'attaching',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(setStatusMock).not.toHaveBeenCalledWith('restoring');
  });

  it('schedules queued output flush after a restore if output remained queued', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    const { runtime, outputPipelineMock } = createRecoveryRuntimeFixture({
      hasQueuedOutput: true,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.scheduleOutputFlush).toHaveBeenCalledTimes(1);
  });

  it('waits for output pipeline flow and output writes to settle before recovery starts', async () => {
    const pipelineChecks: Array<{
      hasWriteInFlight: boolean;
      hasPendingFlowTransitions: boolean;
    }> = [
      { hasWriteInFlight: true, hasPendingFlowTransitions: false },
      { hasWriteInFlight: false, hasPendingFlowTransitions: false },
    ];
    let waitCallCount = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        setTimeout(callback, 0);
      } else {
        callback(0);
      }

      return 0;
    });
    const { runtime } = createRecoveryRuntimeFixture({
      hasWriteInFlight: () => pipelineChecks.shift()?.hasWriteInFlight ?? false,
      hasPendingFlowTransitions: () => pipelineChecks.shift()?.hasPendingFlowTransitions ?? false,
    });

    const restore = runtime.restoreTerminalOutput('attach');
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await restore;

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 0,
      renderedTail: null,
    });
  });

  it('does not request reconnect recovery before the transport has ever connected', async () => {
    const { runtime, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
    });

    runtime.handleBrowserTransportConnectionState('reconnecting');
    runtime.handleBrowserTransportConnectionState('connected');

    await Promise.resolve();

    expect(requestReconnectTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();
  });

  it('requests a reconnect restore after a reconnect event on an already-connected transport', async () => {
    requestReconnectTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    const { runtime, termWriteMock } = createRecoveryRuntimeFixture();

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('reconnecting');
    runtime.handleBrowserTransportConnectionState('connected');

    await expect.poll(() => requestReconnectTerminalRecoveryMock.mock.calls.length).toBe(1);
    await expect.poll(() => termWriteMock.mock.calls.length).toBe(0);
  });

  it('restores renderer-loss without requesting backend recovery state', async () => {
    const { markTerminalReadyMock, runtime, setStatusMock, termWriteMock } =
      createRecoveryRuntimeFixture({
        outputPriority: 'focused',
      });

    await runtime.restoreTerminalOutput('renderer-loss');

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestReconnectTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
  });

  it('replays a second reconnect restore after the transport drops again mid-restore', async () => {
    const firstRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    const secondRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    requestReconnectTerminalRecoveryMock
      .mockReturnValueOnce(firstRestore.promise)
      .mockReturnValueOnce(secondRestore.promise);
    const { markTerminalReadyMock, onRestoreSettledMock, runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 12,
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await expect.poll(() => requestReconnectTerminalRecoveryMock.mock.calls.length).toBe(1);

    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);

    firstRestore.resolve(createRecoveryEntry('agent-1'));
    await firstRestore.promise;

    await expect.poll(() => requestReconnectTerminalRecoveryMock.mock.calls.length).toBe(2);
    expect(markTerminalReadyMock).not.toHaveBeenCalled();
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);

    secondRestore.resolve(createRecoveryEntry('agent-1'));
    await secondRestore.promise;

    await expect.poll(() => onRestoreSettledMock.mock.calls.length).toBe(2);
    await expect.poll(() => markTerminalReadyMock.mock.calls.length).toBe(1);
  });

  it('does not flush queued output between a stale reconnect restore and its replacement restore', async () => {
    const firstRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    const secondRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    requestReconnectTerminalRecoveryMock
      .mockReturnValueOnce(firstRestore.promise)
      .mockReturnValueOnce(secondRestore.promise);
    let hasQueuedOutput = false;
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: () => hasQueuedOutput,
      outputPriority: 'focused',
      renderedOutputCursor: 12,
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await expect.poll(() => requestReconnectTerminalRecoveryMock.mock.calls.length).toBe(1);

    hasQueuedOutput = true;
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    firstRestore.resolve(createRecoveryEntry('agent-1'));
    await firstRestore.promise;

    await expect.poll(() => requestReconnectTerminalRecoveryMock.mock.calls.length).toBe(2);
    expect(outputPipelineMock.scheduleOutputFlush).not.toHaveBeenCalled();

    secondRestore.resolve(createRecoveryEntry('agent-1'));
    await secondRestore.promise;

    await expect.poll(() => outputPipelineMock.scheduleOutputFlush.mock.calls.length).toBe(1);
  });

  it('does not mark the terminal ready after a late restore settles on a disposed view', async () => {
    const deferred = createDeferredPromise<TerminalRecoveryBatchEntry>();
    requestAttachTerminalRecoveryMock.mockImplementationOnce(() => deferred.promise);
    let disposed = false;
    const { markTerminalReadyMock, onRestoreSettledMock, runtime } = createRecoveryRuntimeFixture({
      isDisposed: () => disposed,
    });

    const restorePromise = runtime.restoreTerminalOutput('attach');
    disposed = true;
    deferred.resolve(createRecoveryEntry('agent-1'));
    await restorePromise;

    expect(markTerminalReadyMock).not.toHaveBeenCalled();
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
  });

  it('shows the blocking restoring state for snapshot recovery after attach completes', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    const { runtime, setStatusMock } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(setStatusMock).toHaveBeenCalledWith('restoring');
  });
});
