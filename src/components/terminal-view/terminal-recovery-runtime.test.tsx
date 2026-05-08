import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../../electron/ipc/channels';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../../app/runtime-diagnostics';
import { resetTerminalPerformanceExperimentConfigForTests } from '../../lib/terminal-performance-experiments';
import type { TerminalRecoveryBatchEntry } from '../../ipc/types';

const {
  invokeMock,
  requestAttachTerminalRecoveryMock,
  requestReconnectTerminalRecoveryMock,
  requestStartupTerminalRecoveryMock,
  requestTerminalRecoveryMock,
  switchWindowState,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestAttachTerminalRecoveryMock: vi.fn(),
  requestReconnectTerminalRecoveryMock: vi.fn(),
  requestStartupTerminalRecoveryMock: vi.fn(),
  requestTerminalRecoveryMock: vi.fn(),
  switchWindowState: {
    listener: undefined as (() => void) | undefined,
    startupPaintListener: undefined as (() => void) | undefined,
    snapshot: {
      active: false,
      ageMs: 0,
      firstPaintDurationMs: null as number | null,
      inputReadyDurationMs: null as number | null,
      lastCompletion: null,
      phase: 'inactive' as
        | 'inactive'
        | 'first-paint-pending'
        | 'input-ready-pending'
        | 'settled-pending',
      remainingMs: 0,
      selectedRecoveryActive: false,
      targetTaskId: null as string | null,
    },
  },
}));

vi.mock('../../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('../../lib/scrollbackRestore', () => ({
  requestAttachTerminalRecovery: requestAttachTerminalRecoveryMock,
  requestReconnectTerminalRecovery: requestReconnectTerminalRecoveryMock,
  requestStartupTerminalRecovery: requestStartupTerminalRecoveryMock,
  requestTerminalRecovery: requestTerminalRecoveryMock,
}));

vi.mock('../../app/terminal-switch-window', () => ({
  getTerminalSwitchWindowSnapshot: vi.fn(() => switchWindowState.snapshot),
  subscribeTerminalSwitchWindowChanges: vi.fn((listener: () => void) => {
    switchWindowState.listener = listener;
    return () => {
      if (switchWindowState.listener === listener) {
        switchWindowState.listener = undefined;
      }
    };
  }),
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
    agentId?: string;
    currentStatus?: 'attaching' | 'binding' | 'error' | 'ready' | 'restoring';
    initialBrowserTransportState?: 'connected' | 'disconnected' | 'reconnecting';
    isDisposed?: () => boolean;
    isRenderHibernating?: () => boolean;
    isShell?: boolean;
    isSelectedRecoveryProtected?: () => boolean;
    isSpawnFailed?: () => boolean;
    isSpawnReady?: () => boolean;
    hasPendingFlowTransitions?: (() => boolean) | boolean;
    hasWriteInFlight?: (() => boolean) | boolean;
    renderedOutputCursor?: number;
    renderedOutputHistory?: Uint8Array;
    recoveryRequestState?: {
      outputCursor: number;
      renderedTail: Uint8Array | null;
    };
    termCols?: number;
    termRows?: number;
    startupPaintSnapshot?: () => {
      hiddenPendingCount: number;
      hiddenReadyCount: number;
      selectedPaintReady: boolean;
      selectedPendingCount: number;
      visiblePendingCount: number;
      visibleReadyCount: number;
    };
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
  onStartupWriteRenderedMock: ReturnType<typeof vi.fn>;
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
  inputPipelineMock: {
    drainInputQueue: ReturnType<typeof vi.fn>;
    flushPendingInput: ReturnType<typeof vi.fn>;
    flushPendingResize: ReturnType<typeof vi.fn>;
    flushPendingResizeForRecoveryAlignment: ReturnType<typeof vi.fn>;
  };
  term: {
    cols: number;
    refresh: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    rows: number;
    scrollToBottom: ReturnType<typeof vi.fn>;
    write: (chunk: Uint8Array, callback?: () => void) => void;
  };
  termRefreshMock: ReturnType<typeof vi.fn>;
  termScrollToBottomMock: ReturnType<typeof vi.fn>;
  termWriteMock: ReturnType<typeof vi.fn>;
} {
  const termWriteMock = vi.fn();
  const termScrollToBottomMock = vi.fn();
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
  const onStartupWriteRenderedMock = vi.fn();
  const setStatusMock = vi.fn();
  const appendRenderedOutputHistoryMock = vi.fn();
  const setRenderedOutputHistoryMock = vi.fn();
  const term = {
    cols: options.termCols ?? 80,
    refresh: termRefreshMock,
    reset: vi.fn(),
    rows: options.termRows ?? 24,
    scrollToBottom: termScrollToBottomMock,
    write: handleTermWrite,
  };
  const inputPipelineMock = {
    drainInputQueue: vi.fn(),
    flushPendingInput: vi.fn(),
    flushPendingResize: vi.fn(),
    flushPendingResizeForRecoveryAlignment: vi.fn(),
  };

  function createRetainedChunkReference(chunk: Uint8Array): Uint8Array {
    if (chunk.length <= 256) {
      return chunk.slice();
    }

    return chunk.length === 0 ? chunk : new Uint8Array(1);
  }

  const outputPipelineMock = {
    appendRenderedOutputHistory: (chunk: Uint8Array) => {
      appendRenderedOutputHistoryMock(createRetainedChunkReference(chunk));
    },
    appendRenderedOutputHistoryMock,
    dropQueuedOutputForRecovery: vi.fn(),
    getRecoveryRequestState: vi.fn(() => {
      if (options.recoveryRequestState) {
        return {
          outputCursor: options.recoveryRequestState.outputCursor,
          renderedTail: options.recoveryRequestState.renderedTail?.slice() ?? null,
        };
      }

      return {
        outputCursor: options.renderedOutputCursor ?? 0,
        renderedTail: (options.renderedOutputHistory ?? new Uint8Array(0)).slice(),
      };
    }),
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
    onStartupWriteRenderedMock,
    inputPipelineMock,
    runtime: createTerminalRecoveryRuntime({
      agentId: options.agentId ?? 'agent-1',
      channelId: 'channel-1',
      ensureTerminalFitReady: ensureTerminalFitReadyMock,
      getCurrentStatus: vi.fn(() => options.currentStatus ?? 'attaching'),
      getOutputPriority: vi.fn(() => options.outputPriority ?? 'focused'),
      initialBrowserTransportState: options.initialBrowserTransportState,
      getStartupPaintCoordinationSnapshot: options.startupPaintSnapshot,
      inputPipeline: inputPipelineMock as never,
      isShell: options.isShell === true,
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
      onStartupWriteRendered: onStartupWriteRenderedMock,
      outputPipeline: outputPipelineMock as never,
      setStatus: setStatusMock,
      subscribeStartupPaintCoordinationChanges: (listener) => {
        switchWindowState.startupPaintListener = listener;
        return () => {
          if (switchWindowState.startupPaintListener === listener) {
            switchWindowState.startupPaintListener = undefined;
          }
        };
      },
      taskId: 'task-1',
      term: term as never,
    }),
    term,
    termRefreshMock,
    termScrollToBottomMock,
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

async function flushRecoveryRuntimeMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve();
  }
}

const LARGE_HIDDEN_ATTACH_RECOVERY_BYTES = 384 * 1024 + 1;
const LARGE_FOCUSED_ATTACH_RECOVERY_BYTES = 1024 * 1024 + 1;
const LARGE_FOCUSED_RECONNECT_RECOVERY_BYTES = 256 * 1024 + 1;

describe('createTerminalRecoveryRuntime', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
    resetRendererRuntimeDiagnostics();
    resetTerminalPerformanceExperimentConfigForTests();
    delete window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;
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
    requestStartupTerminalRecoveryMock.mockReset();
    requestTerminalRecoveryMock.mockReset();
    switchWindowState.listener = undefined;
    switchWindowState.startupPaintListener = undefined;
    switchWindowState.snapshot = {
      active: false,
      ageMs: 0,
      firstPaintDurationMs: null,
      inputReadyDurationMs: null,
      lastCompletion: null,
      phase: 'inactive',
      remainingMs: 0,
      selectedRecoveryActive: false,
      targetTaskId: null,
    };
    invokeMock.mockResolvedValue(undefined);
    requestAttachTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    requestReconnectTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    requestStartupTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
    requestTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.restoreAllMocks();
    resetTerminalPerformanceExperimentConfigForTests();
    delete window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;
  });

  it('uses the startup recovery helper for visible initial attach restores', async () => {
    const { runtime } = createRecoveryRuntimeFixture();

    await runtime.restoreTerminalOutput('attach');

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'selected');
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
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

  it('keeps visible shell attach restores on the ordinary attach helper without local tail replay', async () => {
    const { runtime } = createRecoveryRuntimeFixture({
      isShell: true,
      renderedOutputCursor: 12,
      renderedOutputHistory: Buffer.from('painted-tail', 'utf8'),
    });

    await runtime.restoreTerminalOutput('attach');

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 12,
      renderedTail: null,
      snapshotByteLimit: 512 * 1024,
    });
    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
  });

  it('uses the shared terminal-recovery helper for backpressure restores', async () => {
    await createRecoveryRuntimeFixture().runtime.restoreTerminalOutput('backpressure');

    expect(requestTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 0,
      renderedTail: null,
      snapshotByteLimit: null,
    });
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestReconnectTerminalRecoveryMock).not.toHaveBeenCalled();
  });

  it('uses the reconnect recovery helper for direct reconnect requests', async () => {
    const { runtime } = createRecoveryRuntimeFixture({ renderedOutputCursor: 7 });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      {
        outputCursor: 7,
        renderedTail: null,
        snapshotByteLimit: null,
      },
      { immediate: true },
    );
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(requestTerminalRecoveryMock).not.toHaveBeenCalled();
  });

  it('requests selected reconnect recovery immediately for the visible protected terminal', async () => {
    const { runtime } = createRecoveryRuntimeFixture({
      isSelectedRecoveryProtected: () => true,
      renderedOutputCursor: 7,
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      {
        outputCursor: 7,
        renderedTail: null,
        snapshotByteLimit: null,
      },
      { immediate: true },
    );
  });

  it('requests focused reconnect recovery immediately for the selected visible terminal', async () => {
    const { runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 7,
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      {
        outputCursor: 7,
        renderedTail: null,
        snapshotByteLimit: null,
      },
      { immediate: true },
    );
  });

  it('keeps startup recovery role-owned while non-startup recovery still uses local cursor metadata', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
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

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'selected');
    expect(requestTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 33,
      renderedTail: renderedOutputHistory.toString('base64'),
      snapshotByteLimit: null,
    });
    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      {
        outputCursor: 33,
        renderedTail: renderedOutputHistory.toString('base64'),
        snapshotByteLimit: null,
      },
      { immediate: true },
    );
  });

  it('does not force scroll-to-bottom after snapshot recovery replay', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 128),
    );
    const { runtime, termScrollToBottomMock } = createRecoveryRuntimeFixture();

    await runtime.restoreTerminalOutput('attach');

    expect(termScrollToBottomMock).not.toHaveBeenCalled();
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
      snapshotByteLimit: null,
    });
    expect(outputPipelineMock.dropQueuedOutputForRecovery).not.toHaveBeenCalled();
  });

  it('does not include local queued recovery state in startup attach requests', async () => {
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      renderedOutputCursor: 12,
      renderedOutputHistory: Buffer.from('painted-tail', 'utf8'),
      hasQueuedOutput: true,
    });
    outputPipelineMock.getRecoveryRequestState.mockReturnValue({
      outputCursor: 20,
      renderedTail: Buffer.from('painted-tailqueued', 'utf8'),
    });

    await runtime.restoreTerminalOutput('attach');

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'selected');
  });

  it('routes visible sibling startup recovery through the startup helper without client-side caps', async () => {
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'visible-background',
      renderedOutputCursor: 20,
      renderedOutputHistory: Buffer.from('painted-tail', 'utf8'),
      hasQueuedOutput: true,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.getRecoveryRequestState).not.toHaveBeenCalled();
    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'visible-sibling');
  });

  it('routes dense active-visible startup recovery through the startup helper without client-side caps', async () => {
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'active-visible',
      renderedOutputCursor: 20,
      renderedOutputHistory: Buffer.from('painted-tail', 'utf8'),
      hasQueuedOutput: true,
      startupPaintSnapshot: () => ({
        hiddenPendingCount: 0,
        hiddenReadyCount: 0,
        selectedPaintReady: false,
        selectedPendingCount: 1,
        visiblePendingCount: 4,
        visibleReadyCount: 0,
      }),
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.getRecoveryRequestState).not.toHaveBeenCalled();
    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'visible-sibling');
  });

  it('keeps hidden attach recovery on the legacy attach helper', async () => {
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'hidden',
      renderedOutputCursor: 20,
      renderedOutputHistory: Buffer.from('painted-tail', 'utf8'),
      hasQueuedOutput: true,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.getRecoveryRequestState).toHaveBeenCalledWith(32 * 1024);
    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 20,
      renderedTail: Buffer.from('painted-tail', 'utf8').toString('base64'),
      snapshotByteLimit: 64 * 1024,
    });
  });

  it('keeps hidden shell attach recovery on the legacy attach helper', async () => {
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      isShell: true,
      outputPriority: 'hidden',
      renderedOutputCursor: 20,
      renderedOutputHistory: Buffer.from('painted-tail', 'utf8'),
      hasQueuedOutput: true,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.getRecoveryRequestState).toHaveBeenCalledWith(32 * 1024);
    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', {
      outputCursor: 20,
      renderedTail: Buffer.from('painted-tail', 'utf8').toString('base64'),
      snapshotByteLimit: 64 * 1024,
    });
    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
  });

  it.each([
    ['focused', 2],
    ['switch-target-visible', 2],
    ['active-visible', 2],
    ['visible-background', 7],
    ['hidden', 4],
  ] as const)(
    'replays attach snapshot restore chunks with the production %s chunk size',
    async (outputPriority, expectedWriteCount) => {
      if (outputPriority === 'hidden') {
        requestAttachTerminalRecoveryMock.mockResolvedValue(
          createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
        );
      } else {
        requestStartupTerminalRecoveryMock.mockResolvedValue(
          createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
        );
      }
      const { runtime, termWriteMock } = createRecoveryRuntimeFixture({ outputPriority });

      await runtime.restoreTerminalOutput('attach');

      expect(termWriteMock).toHaveBeenCalledTimes(expectedWriteCount);
    },
  );

  it('uses smaller selected attach chunks during dense startup', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_FOCUSED_ATTACH_RECOVERY_BYTES),
    );
    const { runtime, termWriteMock } = createRecoveryRuntimeFixture({
      isSelectedRecoveryProtected: () => true,
      outputPriority: 'focused',
      startupPaintSnapshot: () => ({
        hiddenPendingCount: 0,
        hiddenReadyCount: 0,
        selectedPaintReady: false,
        selectedPendingCount: 1,
        visiblePendingCount: 4,
        visibleReadyCount: 0,
      }),
    });

    await runtime.restoreTerminalOutput('attach');

    expect(termWriteMock).toHaveBeenCalledTimes(9);
    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'selected');
  });

  it('yields between large attach snapshot chunks for focused startup restore', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_FOCUSED_ATTACH_RECOVERY_BYTES),
    );
    const requestAnimationFrameMock = vi.mocked(window.requestAnimationFrame);
    requestAnimationFrameMock.mockClear();
    const { runtime, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(termWriteMock).toHaveBeenCalledTimes(5);
    expect(requestAnimationFrameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips the fixed reveal-settle timeout for selected attach recovery', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 32),
    );
    const setTimeoutMock = vi.mocked(window.setTimeout);
    setTimeoutMock.mockClear();
    const { runtime } = createRecoveryRuntimeFixture({
      isSelectedRecoveryProtected: () => true,
      outputPriority: 'focused',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(setTimeoutMock.mock.calls.some(([, delay]) => Number(delay) === 32)).toBe(false);
  });

  it('defers active-visible attach recovery until selected startup recovery settles', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    switchWindowState.snapshot = {
      active: true,
      ageMs: 10,
      firstPaintDurationMs: null,
      inputReadyDurationMs: null,
      lastCompletion: null,
      phase: 'first-paint-pending',
      remainingMs: 250,
      selectedRecoveryActive: true,
      targetTaskId: 'task-1',
    };
    let timeoutCallCount = 0;
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      timeoutCallCount += 1;
      if (timeoutCallCount > 1) {
        queueMicrotask(() => {
          if (typeof callback === 'function') {
            callback();
          }
        });
      }
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
    const requestAnimationFrameMock = vi.mocked(window.requestAnimationFrame);
    requestAnimationFrameMock.mockClear();
    const fitReady = createDeferredPromise<boolean>();
    const { ensureTerminalFitReadyMock, onStartupWriteRenderedMock, runtime, termWriteMock } =
      createRecoveryRuntimeFixture({
        outputPriority: 'active-visible',
      });
    ensureTerminalFitReadyMock.mockImplementationOnce(() => fitReady.promise);

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await Promise.resolve();

    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    fitReady.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    switchWindowState.snapshot = {
      ...switchWindowState.snapshot,
      phase: 'input-ready-pending',
    };
    switchWindowState.listener?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    switchWindowState.snapshot = {
      ...switchWindowState.snapshot,
      phase: 'settled-pending',
      selectedRecoveryActive: false,
    };
    switchWindowState.listener?.();
    await restorePromise;

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock.mock.calls.length).toBeGreaterThan(0);
    expect(requestAnimationFrameMock).toHaveBeenCalled();
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.startupFirstPaintDeferredCounts[
        'active-visible'
      ],
    ).toBe(1);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.startupFirstPaintDeferredWaitMs,
    ).toBeGreaterThanOrEqual(0);
    expect(onStartupWriteRenderedMock).toHaveBeenCalled();
  });

  it('keeps active-visible attach recovery blocked when startup begins during input-ready-pending', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    switchWindowState.snapshot = {
      active: true,
      ageMs: 10,
      firstPaintDurationMs: 25,
      inputReadyDurationMs: null,
      lastCompletion: null,
      phase: 'input-ready-pending',
      remainingMs: 250,
      selectedRecoveryActive: false,
      targetTaskId: 'task-1',
    };
    let timeoutCallCount = 0;
    vi.spyOn(window, 'setTimeout').mockImplementation((callback) => {
      timeoutCallCount += 1;
      if (timeoutCallCount > 1) {
        queueMicrotask(() => {
          if (typeof callback === 'function') {
            callback();
          }
        });
      }
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
    const fitReady = createDeferredPromise<boolean>();
    const { ensureTerminalFitReadyMock, runtime, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'active-visible',
    });
    ensureTerminalFitReadyMock.mockImplementationOnce(() => fitReady.promise);

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await Promise.resolve();

    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    fitReady.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    switchWindowState.snapshot = {
      ...switchWindowState.snapshot,
      phase: 'settled-pending',
    };
    switchWindowState.listener?.();
    await restorePromise;

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('defers hidden attach recovery until visible startup paint settles', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    let startupPaintSnapshot = {
      hiddenPendingCount: 1,
      hiddenReadyCount: 0,
      selectedPaintReady: false,
      selectedPendingCount: 1,
      visiblePendingCount: 2,
      visibleReadyCount: 0,
    };
    const fitReady = createDeferredPromise<boolean>();
    const { ensureTerminalFitReadyMock, onStartupWriteRenderedMock, runtime, termWriteMock } =
      createRecoveryRuntimeFixture({
        outputPriority: 'hidden',
        startupPaintSnapshot: () => startupPaintSnapshot,
      });
    ensureTerminalFitReadyMock.mockImplementationOnce(() => fitReady.promise);

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await Promise.resolve();

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    fitReady.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    startupPaintSnapshot = {
      ...startupPaintSnapshot,
      hiddenPendingCount: 0,
      selectedPaintReady: true,
      selectedPendingCount: 0,
      visiblePendingCount: 0,
      visibleReadyCount: 2,
    };
    switchWindowState.startupPaintListener?.();
    await restorePromise;

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock.mock.calls.length).toBeGreaterThan(0);
    expect(onStartupWriteRenderedMock).toHaveBeenCalled();
  });

  it('does not defer non-selected visible attach recovery behind selected startup paint', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    const startupPaintSnapshot = {
      hiddenPendingCount: 0,
      hiddenReadyCount: 0,
      selectedPaintReady: false,
      selectedPendingCount: 1,
      visiblePendingCount: 3,
      visibleReadyCount: 0,
    };
    const fitReady = createDeferredPromise<boolean>();
    const { ensureTerminalFitReadyMock, runtime, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'visible-background',
      startupPaintSnapshot: () => startupPaintSnapshot,
    });
    ensureTerminalFitReadyMock.mockImplementationOnce(() => fitReady.promise);

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await Promise.resolve();

    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    fitReady.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    await restorePromise;

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('allows visible startup attach recovery requests to begin concurrently across terminals', async () => {
    const firstRecovery = createDeferredPromise<TerminalRecoveryBatchEntry>();
    requestStartupTerminalRecoveryMock
      .mockImplementationOnce(() => firstRecovery.promise)
      .mockResolvedValueOnce(createRecoveryEntry('agent-2'));

    const startupPaintSnapshot = () => ({
      hiddenPendingCount: 0,
      hiddenReadyCount: 0,
      selectedPaintReady: true,
      selectedPendingCount: 0,
      visiblePendingCount: 2,
      visibleReadyCount: 1,
    });

    const { runtime: firstRuntime } = createRecoveryRuntimeFixture({
      agentId: 'agent-1',
      outputPriority: 'visible-background',
      startupPaintSnapshot,
    });
    const { runtime: secondRuntime } = createRecoveryRuntimeFixture({
      agentId: 'agent-2',
      outputPriority: 'visible-background',
      startupPaintSnapshot,
    });

    const firstRestorePromise = firstRuntime.restoreTerminalOutput('attach');
    await vi.waitFor(() => {
      expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    });

    const secondRestorePromise = secondRuntime.restoreTerminalOutput('attach');
    await vi.waitFor(() => {
      expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(2);
    });

    firstRecovery.resolve(createRecoveryEntry('agent-1'));
    await firstRestorePromise;
    await secondRestorePromise;

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(2);
  });

  it('unblocks hidden attach recovery on selected paint when configured for selected-paint', async () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      startupHiddenReplayUnblockPhase: 'selected-paint',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    requestAttachTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    let startupPaintSnapshot = {
      hiddenPendingCount: 1,
      hiddenReadyCount: 0,
      selectedPaintReady: false,
      selectedPendingCount: 1,
      visiblePendingCount: 2,
      visibleReadyCount: 0,
    };
    const fitReady = createDeferredPromise<boolean>();
    const { ensureTerminalFitReadyMock, runtime, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'hidden',
      startupPaintSnapshot: () => startupPaintSnapshot,
    });
    ensureTerminalFitReadyMock.mockImplementationOnce(() => fitReady.promise);

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await Promise.resolve();

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    fitReady.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    startupPaintSnapshot = {
      ...startupPaintSnapshot,
      selectedPaintReady: true,
      selectedPendingCount: 0,
      visiblePendingCount: 1,
      visibleReadyCount: 1,
    };
    switchWindowState.startupPaintListener?.();
    await restorePromise;

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('cancels hidden startup paint waits when the runtime is disposed', async () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      startupHiddenReplayUnblockPhase: 'selected-paint',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    vi.spyOn(window, 'setTimeout').mockImplementation(
      () => 1 as unknown as ReturnType<typeof globalThis.setTimeout>,
    );
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const startupPaintSnapshot = {
      hiddenPendingCount: 1,
      hiddenReadyCount: 0,
      selectedPaintReady: false,
      selectedPendingCount: 1,
      visiblePendingCount: 0,
      visibleReadyCount: 0,
    };
    const { runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'hidden',
      startupPaintSnapshot: () => startupPaintSnapshot,
    });

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await flushRecoveryRuntimeMicrotasks();

    expect(switchWindowState.startupPaintListener).toBeTypeOf('function');

    runtime.dispose();
    await restorePromise;

    expect(switchWindowState.startupPaintListener).toBeUndefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(runtime.isRestoreBlocked()).toBe(false);
  });

  it('keeps hidden attach recovery blocked by selected paint even when no visible siblings are pending', async () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      startupHiddenReplayUnblockPhase: 'selected-paint',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    requestAttachTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', LARGE_HIDDEN_ATTACH_RECOVERY_BYTES),
    );
    let startupPaintSnapshot = {
      hiddenPendingCount: 1,
      hiddenReadyCount: 0,
      selectedPaintReady: false,
      selectedPendingCount: 1,
      visiblePendingCount: 0,
      visibleReadyCount: 0,
    };
    const fitReady = createDeferredPromise<boolean>();
    const { ensureTerminalFitReadyMock, runtime, termWriteMock } = createRecoveryRuntimeFixture({
      outputPriority: 'hidden',
      startupPaintSnapshot: () => startupPaintSnapshot,
    });
    ensureTerminalFitReadyMock.mockImplementationOnce(() => fitReady.promise);

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await Promise.resolve();

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    fitReady.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(requestAttachTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(termWriteMock).not.toHaveBeenCalled();

    startupPaintSnapshot = {
      ...startupPaintSnapshot,
      hiddenPendingCount: 0,
      selectedPaintReady: true,
      selectedPendingCount: 0,
    };
    switchWindowState.startupPaintListener?.();
    await restorePromise;

    expect(requestAttachTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(termWriteMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('cancels visible sibling startup readiness waits when the runtime is disposed', async () => {
    vi.spyOn(window, 'setTimeout').mockImplementation(
      () => 2 as unknown as ReturnType<typeof globalThis.setTimeout>,
    );
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    switchWindowState.snapshot = {
      ...switchWindowState.snapshot,
      active: true,
      phase: 'first-paint-pending',
      selectedRecoveryActive: true,
    };
    const { runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'visible-background',
      startupPaintSnapshot: () => ({
        hiddenPendingCount: 0,
        hiddenReadyCount: 0,
        selectedPaintReady: false,
        selectedPendingCount: 1,
        visiblePendingCount: 1,
        visibleReadyCount: 0,
      }),
    });

    const restorePromise = runtime.restoreTerminalOutput('attach');
    await flushRecoveryRuntimeMicrotasks();

    expect(switchWindowState.listener).toBeTypeOf('function');

    runtime.dispose();
    await restorePromise;

    expect(switchWindowState.listener).toBeUndefined();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(2);
    expect(requestStartupTerminalRecoveryMock).not.toHaveBeenCalled();
    expect(runtime.isRestoreBlocked()).toBe(false);
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
    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledWith(
      'agent-1',
      {
        outputCursor: 12,
        renderedTail: renderedOutputHistory.toString('base64'),
        snapshotByteLimit: null,
      },
      { immediate: true },
    );
    expect(outputPipelineMock.dropQueuedOutputForRecovery).not.toHaveBeenCalled();
  });

  it('records reconnect replay phase timings for selected visible recovery traces', async () => {
    window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = [];
    const { runtime } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
    });

    await runtime.restoreTerminalOutput('reconnect');

    const traceEntries = window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ ?? [];
    const replayTrace = traceEntries[traceEntries.length - 1];
    expect(replayTrace).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        postApplyFitMs: expect.any(Number),
        preRecoveryFitMs: expect.any(Number),
        primaryReadinessWaitMs: expect.any(Number),
        reason: 'reconnect',
        revealSettleMs: expect.any(Number),
        selectedVisibleFastPath: true,
        visiblePaintWaitMs: expect.any(Number),
      }),
    );
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

  it('rebuilds rendered history for tail-overlap delta recovery', async () => {
    requestReconnectTerminalRecoveryMock.mockResolvedValue(
      createDeltaRecoveryEntryWithSource('agent-1', 3, 'tail', 4),
    );
    const { runtime, outputPipelineMock } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      renderedOutputCursor: 12,
      renderedOutputHistory: Buffer.from('history-tail', 'utf8'),
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(outputPipelineMock.appendRenderedOutputHistoryMock).not.toHaveBeenCalled();
    const rebuiltHistory = outputPipelineMock.setRenderedOutputHistoryMock.mock.calls[0]?.[0];
    expect(rebuiltHistory).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(rebuiltHistory as Uint8Array)).toEqual(Buffer.from('tailaaa', 'utf8'));
  });

  it('retries reconnect recovery until backend geometry matches the live terminal width', async () => {
    let recoveryCols = 80;
    requestReconnectTerminalRecoveryMock.mockImplementation(async () => ({
      ...createDeltaRecoveryEntry('agent-1', 3),
      cols: recoveryCols,
    }));
    const {
      ensureTerminalFitReadyMock,
      inputPipelineMock,
      outputPipelineMock,
      runtime,
      termWriteMock,
    } = createRecoveryRuntimeFixture({
      outputPriority: 'focused',
      termCols: 120,
    });
    inputPipelineMock.flushPendingResizeForRecoveryAlignment.mockImplementation(async () => {
      recoveryCols = 120;
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(2);
    expect(ensureTerminalFitReadyMock).toHaveBeenCalledTimes(3);
    expect(inputPipelineMock.flushPendingResizeForRecoveryAlignment).toHaveBeenCalledTimes(1);
    expect(termWriteMock).toHaveBeenCalledTimes(1);
    expect(outputPipelineMock.appendRenderedOutputHistoryMock).not.toHaveBeenCalled();
    expect(outputPipelineMock.setRenderedOutputHistoryMock).toHaveBeenCalledTimes(1);
  });

  it('does not consume geometry-alignment retry budget while the live terminal width is still changing', async () => {
    let recoveryCols = 80;
    requestReconnectTerminalRecoveryMock.mockImplementation(async () => ({
      ...createDeltaRecoveryEntry('agent-1', 3),
      cols: recoveryCols,
    }));
    const { ensureTerminalFitReadyMock, inputPipelineMock, runtime, term, termWriteMock } =
      createRecoveryRuntimeFixture({
        outputPriority: 'focused',
        termCols: 120,
      });
    inputPipelineMock.flushPendingResizeForRecoveryAlignment.mockImplementation(async () => {
      term.cols = 132;
      recoveryCols = 132;
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(2);
    expect(ensureTerminalFitReadyMock).toHaveBeenCalledTimes(3);
    expect(inputPipelineMock.flushPendingResizeForRecoveryAlignment).toHaveBeenCalledTimes(1);
    expect(termWriteMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the latest recovery entry after exhausting stable geometry-alignment retries', async () => {
    requestReconnectTerminalRecoveryMock.mockResolvedValue({
      ...createDeltaRecoveryEntry('agent-1', 3),
      cols: 80,
    });
    const {
      inputPipelineMock,
      markTerminalReadyMock,
      onRestoreSettledMock,
      outputPipelineMock,
      runtime,
      termWriteMock,
    } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
      outputPriority: 'focused',
      renderedOutputCursor: 12,
      termCols: 120,
    });

    await runtime.restoreTerminalOutput('reconnect');

    expect(requestReconnectTerminalRecoveryMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(inputPipelineMock.flushPendingResizeForRecoveryAlignment.mock.calls.length).toBe(
      requestReconnectTerminalRecoveryMock.mock.calls.length,
    );
    expect(termWriteMock).toHaveBeenCalledTimes(1);
    expect(outputPipelineMock.appendRenderedOutputHistoryMock).not.toHaveBeenCalled();
    expect(outputPipelineMock.setRenderedOutputHistoryMock).toHaveBeenCalledTimes(1);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRestoreBlocked()).toBe(false);
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalRecovery.geometryAlignmentFallbacks,
    ).toBe(1);
  });

  it('treats noop recovery as a cursor-only transition', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
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
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 32),
    );
    const { runtime, setStatusMock } = createRecoveryRuntimeFixture({
      currentStatus: 'attaching',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(setStatusMock).not.toHaveBeenCalledWith('restoring');
  });

  it('schedules queued output flush after a restore if output remained queued', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
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

  it('marks the terminal ready after scheduling any queued output flush left after recovery', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(createRecoveryEntry('agent-1'));
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

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'selected');
  });

  it('does not wait for queued local output to drain before requesting attach recovery', async () => {
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: true,
      hasWriteInFlight: () => false,
      hasPendingFlowTransitions: () => false,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'selected');
    expect(requestStartupTerminalRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(
      outputPipelineMock.scheduleOutputFlush.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('does not thread queued local recovery state into attach startup requests', async () => {
    const queuedTail = new TextEncoder().encode('queued-output');
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: true,
      hasWriteInFlight: () => false,
      hasPendingFlowTransitions: () => false,
      recoveryRequestState: {
        outputCursor: queuedTail.length,
        renderedTail: queuedTail,
      },
    });

    await runtime.restoreTerminalOutput('attach');

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledWith('agent-1', 'selected');
    expect(requestStartupTerminalRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(
      outputPipelineMock.scheduleOutputFlush.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('keeps output flushing unblocked while attach recovery bypasses queued startup output', async () => {
    const { runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: true,
      hasWriteInFlight: () => false,
      hasPendingFlowTransitions: () => false,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(runtime.isOutputFlushBlocked()).toBe(false);
  });

  it('drops queued local output before applying attach delta recovery', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(createDeltaRecoveryEntry('agent-1', 128));
    const { outputPipelineMock, runtime } = createRecoveryRuntimeFixture({
      hasQueuedOutput: true,
      outputPriority: 'focused',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(outputPipelineMock.dropQueuedOutputForRecovery).toHaveBeenCalledTimes(1);
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

  it('treats a late-mounted connected transport as already connected for the next reconnect cycle', async () => {
    const { runtime } = createRecoveryRuntimeFixture({
      initialBrowserTransportState: 'connected',
      outputPriority: 'focused',
    });

    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await vi.waitFor(() => {
      expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    });
  });

  it('starts a pending reconnect restore once spawn-ready is reached after reconnect returns', async () => {
    let spawnReady = false;
    const { runtime } = createRecoveryRuntimeFixture({
      initialBrowserTransportState: 'connected',
      isSpawnReady: () => spawnReady,
      outputPriority: 'focused',
    });

    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');
    await Promise.resolve();

    expect(requestReconnectTerminalRecoveryMock).not.toHaveBeenCalled();

    spawnReady = true;
    runtime.notifySpawnReady();
    await vi.waitFor(() => {
      expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    });
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

  it('clears stale reconnect restore blocking while disconnected and preserves the pending restore', async () => {
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
    const firstRestoreSettled = createDeferredPromise<undefined>();
    const secondRestoreSettled = createDeferredPromise<undefined>();
    let restoreSettledCount = 0;
    onRestoreSettledMock.mockImplementation(() => {
      restoreSettledCount += 1;
      if (restoreSettledCount === 1) {
        firstRestoreSettled.resolve(undefined);
      }
      if (restoreSettledCount === 2) {
        secondRestoreSettled.resolve(undefined);
      }
    });

    runtime.handleBrowserTransportConnectionState('connected');
    runtime.handleBrowserTransportConnectionState('disconnected');
    runtime.handleBrowserTransportConnectionState('connected');

    await firstRestoreRequested.promise;
    expect(runtime.isRestoreBlocked()).toBe(true);

    runtime.handleBrowserTransportConnectionState('disconnected');
    firstRestore.resolve(createRecoveryEntry('agent-1'));
    await firstRestoreSettled.promise;

    expect(runtime.isRestoreBlocked()).toBe(false);
    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).not.toHaveBeenCalled();

    runtime.handleBrowserTransportConnectionState('connected');
    await secondRestoreRequested.promise;

    expect(requestReconnectTerminalRecoveryMock).toHaveBeenCalledTimes(2);
    expect(markTerminalReadyMock).not.toHaveBeenCalled();

    secondRestore.resolve(createRecoveryEntry('agent-1'));
    await secondRestoreSettled.promise;
    await vi.waitFor(() => {
      expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    });
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
    requestStartupTerminalRecoveryMock.mockImplementationOnce(() => deferred.promise);
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
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 32),
    );
    const { runtime, setStatusMock } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
    });

    await runtime.restoreTerminalOutput('attach');

    expect(setStatusMock).toHaveBeenCalledWith('restoring');
  });

  it('keeps restore blocked when backend resume fails after recovery', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 32),
    );
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

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(1);
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
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 32),
    );
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
    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(1);
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

  it('uses hidden-tab-safe reveal settling instead of waiting for requestAnimationFrame callbacks', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 32),
    );
    const queuedRafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queuedRafCallbacks.push(callback);
      return queuedRafCallbacks.length;
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const { markTerminalReadyMock, onRestoreSettledMock, runtime } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
      outputPriority: 'visible-background',
    });

    let restoreResolved = false;
    const restorePromise = runtime.restoreTerminalOutput('attach').then(() => {
      restoreResolved = true;
    });
    await Promise.resolve();

    expect(restoreResolved).toBe(false);
    expect(markTerminalReadyMock).not.toHaveBeenCalled();
    expect(onRestoreSettledMock).not.toHaveBeenCalled();
    expect(queuedRafCallbacks).toHaveLength(0);

    await Promise.resolve();
    await Promise.resolve();
    await restorePromise;

    expect(restoreResolved).toBe(true);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(onRestoreSettledMock).toHaveBeenCalledTimes(1);
    expect(queuedRafCallbacks).toHaveLength(0);
  });

  it('retries a blocked restore after resume failure and clears the block once resume succeeds', async () => {
    requestStartupTerminalRecoveryMock.mockResolvedValue(
      createSnapshotRecoveryEntry('agent-1', 32),
    );
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

    expect(requestStartupTerminalRecoveryMock).toHaveBeenCalledTimes(2);
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

    expect(termWriteMock).toHaveBeenCalledTimes(2);
    expect(onSelectedRecoveryStartMock).toHaveBeenCalledTimes(1);
    expect(onSelectedRecoverySettleMock).toHaveBeenCalledTimes(1);
  });

  it('keeps selected recovery staged until the terminal is marked ready after the first paint settles', async () => {
    requestAttachTerminalRecoveryMock.mockResolvedValue(createSnapshotRecoveryEntry('agent-1', 32));
    const {
      markTerminalReadyMock,
      onSelectedRecoverySettleMock,
      onSelectedRecoveryStartMock,
      runtime,
    } = createRecoveryRuntimeFixture({
      currentStatus: 'ready',
      isSelectedRecoveryProtected: () => true,
    });

    await runtime.restoreTerminalOutput('attach');

    expect(onSelectedRecoveryStartMock).toHaveBeenCalledTimes(1);
    expect(markTerminalReadyMock).toHaveBeenCalledTimes(1);
    expect(onSelectedRecoverySettleMock).toHaveBeenCalledTimes(1);
    expect(onSelectedRecoveryStartMock.mock.invocationCallOrder[0]).toBeLessThan(
      markTerminalReadyMock.mock.invocationCallOrder[0],
    );
    expect(markTerminalReadyMock.mock.invocationCallOrder[0]).toBeLessThan(
      onSelectedRecoverySettleMock.mock.invocationCallOrder[0],
    );
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

    expect(termWriteMock).toHaveBeenCalledTimes(4);
    expect(onSelectedRecoveryStartMock).not.toHaveBeenCalled();
    expect(onSelectedRecoverySettleMock).not.toHaveBeenCalled();
  });
});
