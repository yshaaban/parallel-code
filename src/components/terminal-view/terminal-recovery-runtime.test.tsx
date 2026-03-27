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
    isRenderHibernating?: () => boolean;
    isSelectedRecoveryProtected?: () => boolean;
    isSpawnFailed?: () => boolean;
    isSpawnReady?: () => boolean;
    hasPendingFlowTransitions?: (() => boolean) | boolean;
    hasWriteInFlight?: (() => boolean) | boolean;
    renderedOutputCursor?: number;
    renderedOutputHistory?: Uint8Array;
    outputPriority?:
      | 'focused'
      | 'switch-target-visible'
      | 'active-visible'
      | 'visible-background'
      | 'hidden';
    hasQueuedOutput?: (() => boolean) | boolean;
  } = {},
): {
  ensureTerminalFitReadyMock: ReturnType<typeof vi.fn>;
  markTerminalReadyMock: ReturnType<typeof vi.fn>;
  onRestoreBlockedChangeMock: ReturnType<typeof vi.fn>;
  onSelectedRecoverySettleMock: ReturnType<typeof vi.fn>;
  onSelectedRecoveryStartMock: ReturnType<typeof vi.fn>;
  onRestoreSettledMock: ReturnType<typeof vi.fn>;
  runtime: ReturnType<typeof createTerminalRecoveryRuntime>;
  setStatusMock: ReturnType<typeof vi.fn>;
  outputPipelineMock: {
    appendRenderedOutputHistory: (chunk: Uint8Array) => void;
    appendRenderedOutputHistoryMock: ReturnType<typeof vi.fn>;
    dropQueuedOutputForRecovery: ReturnType<typeof vi.fn>;
    getRecoveryRequestState: ReturnType<typeof vi.fn>;
    getRenderedOutputCursor: ReturnType<typeof vi.fn>;
    getRenderedOutputHistory: ReturnType<typeof vi.fn>;
    hasPendingFlowTransitions: ReturnType<typeof vi.fn>;
    hasQueuedOutput: ReturnType<typeof vi.fn>;
    hasWriteInFlight: ReturnType<typeof vi.fn>;
    recoverFlowControlIfIdle: ReturnType<typeof vi.fn>;
    scheduleOutputFlush: ReturnType<typeof vi.fn>;
    setRenderedOutputCursor: ReturnType<typeof vi.fn>;
    setRenderedOutputHistory: (chunk: Uint8Array) => void;
    setRenderedOutputHistoryMock: ReturnType<typeof vi.fn>;
  };
  termRefreshMock: ReturnType<typeof vi.fn>;
  termWriteMock: ReturnType<typeof vi.fn>;
} {
  const termWriteMock = vi.fn();
  function handleTermWrite(_chunk: Uint8Array, callback?: () => void): void {
    termWriteMock();
    callback?.();
  }
  const termRefreshMock = vi.fn();
  const ensureTerminalFitReadyMock = vi.fn().mockResolvedValue(true);
  const markTerminalReadyMock = vi.fn();
  const onRestoreBlockedChangeMock = vi.fn();
  const onRestoreSettledMock = vi.fn();
  const onSelectedRecoverySettleMock = vi.fn();
  const onSelectedRecoveryStartMock = vi.fn();
  const setStatusMock = vi.fn();
  const appendRenderedOutputHistoryMock = vi.fn();
  const setRenderedOutputHistoryMock = vi.fn();

  function createRetainedChunkReference(chunk: Uint8Array): Uint8Array {
    return chunk.length === 0 ? chunk : new Uint8Array(1);
  }

  const outputPipelineMock = {
    appendRenderedOutputHistory: (chunk: Uint8Array) => {
      appendRenderedOutputHistoryMock(createRetainedChunkReference(chunk));
    },
    appendRenderedOutputHistoryMock,
    dropQueuedOutputForRecovery: vi.fn(),
    getRecoveryRequestState: vi.fn(() => ({
      outputCursor: options.renderedOutputCursor ?? 0,
      renderedTail: (options.renderedOutputHistory ?? new Uint8Array(0)).slice(),
    })),
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
    setRenderedOutputHistory: (chunk: Uint8Array) => {
      setRenderedOutputHistoryMock(createRetainedChunkReference(chunk));
    },
    setRenderedOutputHistoryMock,
  };

  return {
    ensureTerminalFitReadyMock,
    markTerminalReadyMock,
    onRestoreBlockedChangeMock,
    onSelectedRecoverySettleMock,
    onRestoreSettledMock,
    onSelectedRecoveryStartMock,
    runtime: createTerminalRecoveryRuntime({
      agentId: 'agent-1',
      channelId: 'channel-1',
      ensureTerminalFitReady: ensureTerminalFitReadyMock,
      getCurrentStatus: vi.fn(() => options.currentStatus ?? 'attaching'),
      getOutputPriority: vi.fn(() => options.outputPriority ?? 'focused'),
      inputPipeline: {
        drainInputQueue: vi.fn(),
        flushPendingInput: vi.fn(),
        flushPendingResize: vi.fn(),
      } as never,
      isRenderHibernating: vi.fn(() => options.isRenderHibernating?.() ?? false),
      isSelectedRecoveryProtected: vi.fn(() => options.isSelectedRecoveryProtected?.() ?? false),
      isDisposed: vi.fn(() => options.isDisposed?.() ?? false),
      isSpawnFailed: vi.fn(() => options.isSpawnFailed?.() ?? false),
      isSpawnReady: vi.fn(() => options.isSpawnReady?.() ?? true),
      markTerminalReady: markTerminalReadyMock,
      onRestoreBlockedChange: onRestoreBlockedChangeMock,
      onRestoreSettled: onRestoreSettledMock,
      onSelectedRecoverySettle: onSelectedRecoverySettleMock,
      onSelectedRecoveryStart: onSelectedRecoveryStartMock,
      outputPipeline: outputPipelineMock as never,
      setStatus: setStatusMock,
      taskId: 'task-1',
      term: {
        refresh: termRefreshMock,
        reset: vi.fn(),
        rows: 24,
        scrollToBottom: vi.fn(),
        write: handleTermWrite,
      } as never,
    }),
    termRefreshMock,
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

const LARGE_HIDDEN_ATTACH_RECOVERY_BYTES = 384 * 1024 + 1;
const LARGE_FOCUSED_ATTACH_RECOVERY_BYTES = 1024 * 1024 + 1;
const LARGE_FOCUSED_RECONNECT_RECOVERY_BYTES = 256 * 1024 + 1;

describe('createTerminalRecoveryRuntime', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      queueMicrotask(() => {
        if (typeof callback === 'function') {
          callback();
        }
      });

      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
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
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
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

  it('requests backpressure recovery against the local buffered tail, not only painted bytes', async () => {
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      renderedOutputCursor: 12,
      renderedOutputHistory: Buffer.from('painted-tail', 'utf8'),
    });
    outputPipelineMock.getRecoveryRequestState.mockReturnValue({
      outputCursor: 20,
      renderedTail: Buffer.from('painted-tailqueued', 'utf8'),
    });

    await runtime.restoreTerminalOutput('backpressure');

    expect(requestTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 20,
      renderedTail: Buffer.from('painted-tailqueued', 'utf8').toString('base64'),
    });
    expect(outputPipelineMock.dropQueuedOutputForRecovery).not.toHaveBeenCalled();
  });

  it.each([
    ['focused', 1],
    ['switch-target-visible', 1],
    ['active-visible', 1],
    ['visible-background', 2],
    ['hidden', 7],
  ] as const)(
    'replays attach snapshot restore chunks with the production %s chunk size',
    async (outputPriority, expectedWriteCount) => {
      requestAttachTerminalRecoveryMock.mockResolvedValue(
        createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
      );
      const { runtime, termWriteMock } = createRecoveryRuntimeFixture({ outputPriority });

      await runtime.restoreTerminalOutput('attach');

      expect(termWriteMock).toHaveBeenCalledTimes(expectedWriteCount);
    },
  );

  it('does not yield between large attach snapshot chunks for focused startup restore', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_FOCUSED_ATTACH_RECOVERY_BYTES),
    );
    const requestAnimationFrameMock = vi.mocked(window.requestAnimationFrame);
    requestAnimationFrameMock.mockClear();
    const { runtime, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(termWriteMock).toHaveBeenCalledTimes(2);
    expect(requestAnimationFrameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('still yields between reconnect replay chunks for large focused restores', async () => {
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createDeltaRecoveryEntry('agent-1', LARGE_FOCUSED_RECONNECT_RECOVERY_BYTES),
    );
    const requestAnimationFrameMock = vi.mocked(window.requestAnimationFrame);
    requestAnimationFrameMock.mockClear();
    const { markTerminalReadyMock, onRestoreSettledMock, runtime, termWriteMock } =
      createRecoveryRuntimeFixture({
        outputPriority: 'focused',
        renderedOutputCursor: 12,
      });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock).toHaveBeenCalledTimes(2);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRestoreBlocked()).toBe(false);
    expect(requestAnimationFrameMock).toHaveBeenCalled();
  });

  it('replays reconnect restores with the live rendered tail and priority-sized delta chunks', async () => {
    const renderedOutputHistory = Buffer.from('restore-tail', 'utf8');
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createDeltaRecoveryEntry('agent-1', LARGE_FOCUSED_RECONNECT_RECOVERY_BYTES),
    );
    const {
      markTerminalReadyMock,
      onRestoreSettledMock,
      runtime,
      outputPipelineMock,
      termWriteMock,
    } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 12,
      renderedOutputHistory,
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock).toHaveBeenCalledTimes(2);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRestoreBlocked()).toBe(false);
    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 12,
      renderedTail: renderedOutputHistory.toString('base64'),
    });
    expect(outputPipelineMock.dropQueuedOutputForRecovery).not.toHaveBeenCalled();
  });

  it('replays cursor-delimited delta recovery without overlapping history', async () => {
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createDeltaRecoveryEntryWithSource('agent-1', 128, 'cursor'),
    );
    const { markTerminalReadyMock, onRestoreSettledMock, runtime, outputPipelineMock } =
      createRecoveryRuntimeFixture({
        outputPriority: 'focused',
        renderedOutputCursor: 12,
        renderedOutputHistory: Buffer.from('existing-prefix', 'utf8'),
      });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRestoreBlocked()).toBe(false);
    expect(outputPipelineMock.appendRenderedOutputHistoryMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
    );
    expect(outputPipelineMock.setRenderedOutputHistoryMock).not.toHaveBeenCalled();
  });

  it('treats noop recovery as a cursor-only transition', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    const {
      onRestoreBlockedChangeMock,
      runtime,
      outputPipelineMock,
      termRefreshMock,
      termWriteMock,
    } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 17,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.setRenderedOutputCursor).toHaveBeenCalledWith(0);
    expect(outputPipelineMock.appendRenderedOutputHistoryMock).not.toHaveBeenCalled();
    expect(outputPipelineMock.setRenderedOutputHistoryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();
    expect(termRefreshMock).toHaveBeenCalledWith(0, 23);
    expect(outputPipelineMock.dropQueuedOutputForRecovery).not.toHaveBeenCalled();
    expect(onRestoreBlockedChangeMock.mock.calls).toEqual([[true], [false]]);
  });

  it('refreshes the visible terminal after delta recovery to resync the cursor layer', async () => {
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createDeltaRecoveryEntryWithSource('agent-1', 128, 'cursor'),
    );
    const { runtime, termRefreshMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 12,
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(termRefreshMock).toHaveBeenCalledWith(0, 23);
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
    let hasQueuedOutput = false;
    const { runtime, outputPipelineMock, markTerminalReadyMock } = createRecoveryRuntimeFixture({
      hasQueuedOutput: () => hasQueuedOutput,
    });
    outputPipelineMock.setRenderedOutputCursor.mockImplementation(() => {
      hasQueuedOutput = true;
    });
    outputPipelineMock.scheduleOutputFlush.mockImplementation(() => {
      hasQueuedOutput = false;
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.scheduleOutputFlush).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
  });

  it('waits for queued output to drain before marking the terminal ready after recovery', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    let hasQueuedOutput = false;
    const flushScheduled = createDeferredPromise<undefined>();
    const { runtime, outputPipelineMock, markTerminalReadyMock } = createRecoveryRuntimeFixture({
      hasQueuedOutput: () => hasQueuedOutput,
    });
    outputPipelineMock.setRenderedOutputCursor.mockImplementation(() => {
      hasQueuedOutput = true;
    });
    outputPipelineMock.scheduleOutputFlush.mockImplementation(() => {
      hasQueuedOutput = false;
      flushScheduled.resolve(undefined);
    });

    const restorePromise = runtime.restoreTerminalOutput('attach');

    await flushScheduled.promise;
    expect(markTerminalReadyMock).not.toHaveBeenCalled();

    await restorePromise;

    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
  });

  it('waits for output pipeline flow and output writes to settle before recovery starts', async () => {
    let writeCheckCount = 0;
    const { runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: () => false,
      hasWriteInFlight: () => {
        writeCheckCount += 1;
        return writeCheckCount === 1;
      },
      hasPendingFlowTransitions: () => false,
    });

    await runtime.restoreTerminalOutput('attach');
    expect(writeCheckCount).toBeGreaterThanOrEqual(2);

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 0,
      renderedTail: null,
    });
  });

  it('waits for queued local output to drain before requesting recovery', async () => {
    let hasQueuedOutput = true;
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: () => hasQueuedOutput,
      hasWriteInFlight: () => false,
      hasPendingFlowTransitions: () => false,
    });
    outputPipelineMock.scheduleOutputFlush.mockImplementation(() => {
      hasQueuedOutput = false;
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.scheduleOutputFlush).toHaveBeenCalledTimes(1);
    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 0,
      renderedTail: null,
    });
  });

  it('does not block queued output flushing while waiting for attach output to go idle', async () => {
    let hasQueuedOutput = true;
    const flushObserved = createDeferredPromise<undefined>();
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: () => hasQueuedOutput,
      hasWriteInFlight: () => false,
      hasPendingFlowTransitions: () => false,
    });
    outputPipelineMock.scheduleOutputFlush.mockImplementation(() => {
      hasQueuedOutput = false;
      flushObserved.resolve(undefined);
    });

    const restorePromise = runtime.restoreTerminalOutput('attach');

    await flushObserved.promise;
    expect(runtime.isOutputFlushBlocked()).toBe(false);

    await restorePromise;
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
    const reconnectRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    const reconnectRestoreRequested = createDeferredPromise<undefined>();
    requestReconnectTerminalRecoveryMock.mockImplementationOnce(() => {
      reconnectRestoreRequested.resolve(undefined);
      return reconnectRestore.promise;
    });
    const { markTerminalReadyMock, onRestoreSettledMock, runtime, termWriteMock } =
      createRecoveryRuntimeFixture();
    const reconnectRestoreSettled = createDeferredPromise<undefined>();
    onRestoreSettledMock.mockImplementation(() => {
      reconnectRestoreSettled.resolve(undefined);
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('reconnecting');
    runtime.handleBrowserTransportConnectionState('connected');

    await reconnectRestoreRequested.promise;
    reconnectRestore.resolve(createRecoveryEntry('agent-1'));
    await reconnectRestore.promise;
    await reconnectRestoreSettled.promise;

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock).toHaveBeenCalledTimes(0);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRestoreBlocked()).toBe(false);
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
    const firstRestoreRequested = createDeferredPromise<undefined>();
    const secondRestoreRequested = createDeferredPromise<undefined>();
    requestReconnectTerminalRecoveryMock
      .mockImplementationOnce(() => {
        firstRestoreRequested.resolve(undefined);
        return firstRestore.promise;
      })
      .mockImplementationOnce(() => {
        secondRestoreRequested.resolve(undefined);
        return secondRestore.promise;
      });
    const { markTerminalReadyMock, onRestoreSettledMock, runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 12,
    });
    const secondRestoreSettled = createDeferredPromise<undefined>();
    let restoreSettledCount = 0;
    onRestoreSettledMock.mockImplementation(() => {
      restoreSettledCount += 1;
      if (restoreSettledCount === 2) {
        secondRestoreSettled.resolve(undefined);
      }
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await firstRestoreRequested.promise;

    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);

    firstRestore.resolve(createRecoveryEntry('agent-1'));
    await firstRestore.promise;

    await secondRestoreRequested.promise;
    expect(markTerminalReadyMock).not.toHaveBeenCalled();
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);

    secondRestore.resolve(createRecoveryEntry('agent-1'));
    await secondRestore.promise;
    await secondRestoreSettled.promise;

    expect(onRestoreSettledMock).toHaveBeenCalledTimes(2);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRestoreBlocked()).toBe(false);
  });

  it('does not flush queued output between a stale reconnect restore and its replacement restore', async () => {
    const firstRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    const secondRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    const firstRestoreRequested = createDeferredPromise<undefined>();
    const secondRestoreRequested = createDeferredPromise<undefined>();
    const secondRestoreSettled = createDeferredPromise<undefined>();
    requestReconnectTerminalRecoveryMock
      .mockImplementationOnce(() => {
        firstRestoreRequested.resolve(undefined);
        return firstRestore.promise;
      })
      .mockImplementationOnce(() => {
        secondRestoreRequested.resolve(undefined);
        return secondRestore.promise;
      });
    let hasQueuedOutput = false;
    const { onRestoreSettledMock, outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: () => hasQueuedOutput,
      outputPriority: 'focused',
      renderedOutputCursor: 12,
    });
    let restoreSettledCount = 0;
    onRestoreSettledMock.mockImplementation(() => {
      restoreSettledCount += 1;
      if (restoreSettledCount === 2) {
        secondRestoreSettled.resolve(undefined);
      }
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await firstRestoreRequested.promise;

    hasQueuedOutput = true;
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    firstRestore.resolve(createRecoveryEntry('agent-1'));
    await firstRestore.promise;

    await secondRestoreRequested.promise;
    expect(outputPipelineMock.scheduleOutputFlush).not.toHaveBeenCalled();

    secondRestore.resolve(createRecoveryEntry('agent-1'));
    await secondRestore.promise;

    await secondRestoreSettled.promise;
    expect(outputPipelineMock.scheduleOutputFlush).toHaveBeenCalledTimes(1);
    expect(runtime.isRestoreBlocked()).toBe(false);
  });

  it('does not settle selected recovery from a stale reconnect restore replacement', async () => {
    const firstRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    const secondRestore = createDeferredPromise<TerminalRecoveryBatchEntry>();
    const firstRestoreRequested = createDeferredPromise<undefined>();
    const secondRestoreRequested = createDeferredPromise<undefined>();
    const secondSelectedRecoverySettled = createDeferredPromise<undefined>();
    requestReconnectTerminalRecoveryMock
      .mockImplementationOnce(() => {
        firstRestoreRequested.resolve(undefined);
        return firstRestore.promise;
      })
      .mockImplementationOnce(() => {
        secondRestoreRequested.resolve(undefined);
        return secondRestore.promise;
      });
    const { onSelectedRecoverySettleMock, onSelectedRecoveryStartMock, runtime } =
      createRecoveryRuntimeFixture({
        isSelectedRecoveryProtected: () => true,
        outputPriority: 'focused',
        renderedOutputCursor: 12,
      });
    onSelectedRecoverySettleMock.mockImplementation(() => {
      secondSelectedRecoverySettled.resolve(undefined);
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await firstRestoreRequested.promise;

    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    firstRestore.resolve(createRecoveryEntry('agent-1'));
    await firstRestore.promise;

    await secondRestoreRequested.promise;
    expect(onSelectedRecoverySettleMock).not.toHaveBeenCalled();

    secondRestore.resolve(createRecoveryEntry('agent-1'));
    await secondRestore.promise;
    await secondSelectedRecoverySettled.promise;

    expect(onSelectedRecoveryStartMock).toHaveBeenCalledTimes(2);
    expect(runtime.isRestoreBlocked()).toBe(false);
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

  it('keeps restore blocked when backend resume fails after recovery', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    invokeMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('resume failed'));
    const {
      markTerminalReadyMock,
      onRestoreBlockedChangeMock,
      onRestoreSettledMock,
      runtime,
      setStatusMock,
    } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledTimes(1);
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
    expect(markTerminalReadyMock).not.toHaveBeenCalled();
    expect(onRestoreSettledMock).not.toHaveBeenCalled();
    expect(onRestoreBlockedChangeMock.mock.calls).toEqual([[true]]);
    expect(setStatusMock).toHaveBeenCalledWith('restoring');
    expect(runtime.isRestoreBlocked()).toBe(true);
  });

  it('keeps waiting for fit readiness before applying restore state', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    const { ensureTerminalFitReadyMock, markTerminalReadyMock, onRestoreSettledMock, runtime } =
      createRecoveryRuntimeFixture({
        currentStatus: 'ready',
      });
    ensureTerminalFitReadyMock
      .mockResolvedValue(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await runtime.restoreTerminalOutput('attach');

    expect(ensureTerminalFitReadyMock).toHaveBeenNthCalledWith(1, 'restore');
    expect(ensureTerminalFitReadyMock).toHaveBeenNthCalledWith(2, 'restore');
    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting for fit readiness before refreshing after renderer loss', async () => {
    const { ensureTerminalFitReadyMock, markTerminalReadyMock, runtime, termRefreshMock } =
      createRecoveryRuntimeFixture({
        currentStatus: 'ready',
      });
    ensureTerminalFitReadyMock
      .mockResolvedValue(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await runtime.restoreTerminalOutput('renderer-loss');

    expect(ensureTerminalFitReadyMock).toHaveBeenNthCalledWith(1, 'renderer-loss');
    expect(ensureTerminalFitReadyMock).toHaveBeenNthCalledWith(2, 'renderer-loss');
    expect(termRefreshMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
  });

  it('retries a blocked restore after resume failure and clears the block once resume succeeds', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('resume failed'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const { markTerminalReadyMock, onRestoreBlockedChangeMock, onRestoreSettledMock, runtime } =
      createRecoveryRuntimeFixture({
        currentStatus: 'ready',
      });

    await runtime.restoreTerminalOutput('attach');
    expect(runtime.isRestoreBlocked()).toBe(true);

    await runtime.restoreTerminalOutput('attach');

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledTimes(2);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
    expect(onRestoreBlockedChangeMock.mock.calls).toEqual([[true], [false]]);
    expect(runtime.isRestoreBlocked()).toBe(false);
  });

  it('keeps the frozen handoff visible for hibernate snapshot restores', async () => {
    requestTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    const { runtime, setStatusMock } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
      isRenderHibernating: () => true,
      outputPriority: 'hidden',
    });

    await runtime.restoreTerminalOutput('hibernate');

    expect(setStatusMock).not.toHaveBeenCalledWith('restoring');
  });

  it('suppresses blocking restore UI for hibernate recovery while the session is waking', async () => {
    requestTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    const { runtime, setStatusMock } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
      isRenderHibernating: () => false,
      outputPriority: 'hidden',
    });

    await runtime.restoreTerminalOutput('hibernate');

    expect(setStatusMock).not.toHaveBeenCalledWith('restoring');
  });

  it('uses the selected-recovery protection path to speed up hidden restores', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    const { onSelectedRecoverySettleMock, onSelectedRecoveryStartMock, runtime, termWriteMock } =
      createRecoveryRuntimeFixture({
        isSelectedRecoveryProtected: () => true,
        outputPriority: 'hidden',
      });

    await runtime.restoreTerminalOutput('attach');

    expect(termWriteMock).toHaveBeenCalledTimes(1);
    expect(onSelectedRecoveryStartMock).toHaveBeenCalledTimes(1);
    expect(onSelectedRecoverySettleMock).toHaveBeenCalledTimes(1);
  });

  it('arms selected-recovery protection before waiting for local output idle', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    let waitPollCount = 0;
    let sawSelectedRecoveryStartDuringWait = false;

    const fixture = createRecoveryRuntimeFixture({
      hasWriteInFlight: () => {
        waitPollCount += 1;
        if (fixture.onSelectedRecoveryStartMock.mock.calls.length > 0) {
          sawSelectedRecoveryStartDuringWait = true;
        }

        return waitPollCount < 2;
      },
      isSelectedRecoveryProtected: () => true,
      outputPriority: 'hidden',
    });

    await fixture.runtime.restoreTerminalOutput('attach');

    expect(sawSelectedRecoveryStartDuringWait).toBe(true);
    expect(fixture.onSelectedRecoveryStartMock).toHaveBeenCalledTimes(1);
    expect(fixture.onSelectedRecoverySettleMock).toHaveBeenCalledTimes(1);
  });

  it('does not activate selected-recovery callbacks for unrelated hidden restores', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    const { onSelectedRecoverySettleMock, onSelectedRecoveryStartMock, runtime, termWriteMock } =
      createRecoveryRuntimeFixture({
        isSelectedRecoveryProtected: () => false,
        outputPriority: 'hidden',
      });

    await runtime.restoreTerminalOutput('attach');

    expect(termWriteMock).toHaveBeenCalledTimes(7);
    expect(onSelectedRecoveryStartMock).not.toHaveBeenCalled();
    expect(onSelectedRecoverySettleMock).not.toHaveBeenCalled();
  });
});
