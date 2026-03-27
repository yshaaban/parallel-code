import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', () => ({
  BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE: 'cancelled',
  cancelBrowserAgentCommandRequest: vi.fn(),
  invoke: vi.fn(),
  sendTerminalInput: vi.fn(async () => undefined),
  sendTerminalInputTraceUpdate: vi.fn(),
}));

vi.mock('../../app/task-command-lease', () => ({
  createTaskCommandLeaseSession: vi.fn(() => ({
    acquire: vi.fn(async () => true),
    cleanup: vi.fn(),
    touch: vi.fn(() => true),
  })),
  hasTaskCommandLeaseTransportAvailability: vi.fn(() => true),
}));

import { IPC } from '../../../electron/ipc/channels';
import {
  createTaskCommandLeaseSession,
  hasTaskCommandLeaseTransportAvailability,
} from '../../app/task-command-lease';
import { invoke, sendTerminalInput, sendTerminalInputTraceUpdate } from '../../lib/ipc';
import {
  beginTerminalSwitchEchoGrace,
  getTerminalSwitchEchoGraceSnapshot,
  resetTerminalSwitchEchoGraceForTests,
} from '../../app/terminal-switch-echo-grace';
import {
  resetTerminalTraceClockAlignmentForTests,
  setTerminalTraceClockAlignment,
} from '../../lib/terminal-trace-clock';
import { createTerminalInputPipeline } from './terminal-input-pipeline';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

describe('terminal-input-pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalTraceClockAlignmentForTests();
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(hasTaskCommandLeaseTransportAvailability).mockReturnValue(true);
  });

  afterEach(() => {
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalTraceClockAlignmentForTests();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('activates the post-input-ready echo grace on the first local interactive input', async () => {
    const armInteractiveEchoFastPath = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    beginTerminalSwitchEchoGrace('task-1', 120);

    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        targetTaskId: 'task-1',
      }),
    );

    pipeline.handleTerminalData('a');
    await Promise.resolve();
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(armInteractiveEchoFastPath).toHaveBeenCalledTimes(1);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('allows newer trace echoes to complete even when an older pending echo never matched', async () => {
    setTerminalTraceClockAlignment(0, 0);

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    pipeline.handleTerminalData('b');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const requestIds = vi
      .mocked(sendTerminalInput)
      .mock.calls.map(([request]) => request.requestId)
      .filter((requestId): requestId is string => typeof requestId === 'string');
    expect(requestIds).toHaveLength(2);

    pipeline.detectPendingInputTraceEcho(new TextEncoder().encode('b'), 100);
    pipeline.finalizePendingInputTraceEchoes(110);

    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenCalledWith({
      agentId: 'agent-1',
      outputReceivedAtMs: 100,
      outputRenderedAtMs: 110,
      requestId: requestIds[1],
    });

    pipeline.cleanup();
  });

  it('drops terminal input while the terminal is not allowed to accept stdin', async () => {
    const onBlockedInputAttempt = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => false,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onBlockedInputAttempt,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalData('blocked input');
    await vi.advanceTimersByTimeAsync(20);

    expect(onBlockedInputAttempt).toHaveBeenCalledTimes(1);
    expect(sendTerminalInput).not.toHaveBeenCalled();
    pipeline.cleanup();
  });

  it('buffers terminal input while restore is blocked and flushes it after restore settles', async () => {
    let restoreBlocked = true;
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => true,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => restoreBlocked,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalData('buffered while restoring');
    await vi.advanceTimersByTimeAsync(8);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    restoreBlocked = false;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'buffered while restoring',
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('batches the first interactive burst after lease reacquire instead of sending a partial first key', async () => {
    const acquireDeferred = createDeferred<boolean>();
    vi.mocked(createTaskCommandLeaseSession).mockReturnValueOnce({
      acquire: vi.fn(() => acquireDeferred.promise),
      cleanup: vi.fn(),
      release: vi.fn(async () => undefined),
      takeOver: vi.fn(async () => true),
      touch: vi.fn(() => false),
    });

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => true,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalData('a');
    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    await vi.advanceTimersByTimeAsync(1);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    acquireDeferred.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'abc',
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('keeps queued input buffered while task-command transport is temporarily unavailable', async () => {
    vi.mocked(createTaskCommandLeaseSession).mockReturnValueOnce({
      acquire: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      cleanup: vi.fn(),
      release: vi.fn(async () => undefined),
      takeOver: vi.fn(async () => true),
      touch: vi.fn(() => false),
    });
    vi.mocked(hasTaskCommandLeaseTransportAvailability).mockReturnValue(false);

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => true,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalData('echo retry after reconnect');
    await vi.advanceTimersByTimeAsync(20);
    expect(sendTerminalInput).not.toHaveBeenCalled();

    vi.mocked(hasTaskCommandLeaseTransportAvailability).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'echo retry after reconnect',
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('keeps buffered interactive input when controller ownership is temporarily null during lease reacquire', async () => {
    const acquireDeferred = createDeferred<boolean>();
    vi.mocked(createTaskCommandLeaseSession).mockReturnValueOnce({
      acquire: vi.fn(() => acquireDeferred.promise),
      cleanup: vi.fn(),
      release: vi.fn(async () => undefined),
      takeOver: vi.fn(async () => true),
      touch: vi.fn(() => false),
    });

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => true,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalData('a');
    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    pipeline.handleControllerChange(null);
    await vi.advanceTimersByTimeAsync(1);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    acquireDeferred.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'abc',
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('coalesces resize bursts to the latest geometry before sending one PTY resize', async () => {
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalResize(100, 30);
    pipeline.handleTerminalResize(110, 34);
    pipeline.handleTerminalResize(120, 40);

    await vi.advanceTimersByTimeAsync(47);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 120, rows: 40 }),
    );

    await vi.advanceTimersByTimeAsync(1);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.ResizeAgent, {
      agentId: 'agent-1',
      cols: 120,
      controllerId: 'runtime-client-1',
      requestId: expect.any(String),
      rows: 40,
      taskId: 'task-1',
    });

    pipeline.cleanup();
  });

  it('uses a longer resize transaction window for alternate-buffer terminals', async () => {
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: {
        buffer: {
          active: {
            type: 'alternate',
          },
        },
        cols: 80,
        rows: 24,
      } as never,
    });

    pipeline.handleTerminalResize(90, 28);

    await vi.advanceTimersByTimeAsync(119);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 90, rows: 28 }),
    );

    pipeline.cleanup();
  });

  it('does not immediately chain another PTY resize when a new geometry arrives during an in-flight resize', async () => {
    let resolveResize: ((value: undefined) => void) | undefined;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveResize = resolve;
        }),
    );

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    pipeline.handleTerminalResize(120, 40);
    await Promise.resolve();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    resolveResize?.(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(47);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 120, rows: 40 }),
    );

    pipeline.cleanup();
  });

  it('ignores duplicate resize geometries that match the in-flight or last-sent size', async () => {
    let resolveResize: ((value: undefined) => void) | undefined;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveResize = resolve;
        }),
    );

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    resolveResize?.(undefined);
    await Promise.resolve();
    await Promise.resolve();

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(120);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    pipeline.cleanup();
  });

  it('defers PTY resize commits until the terminal becomes geometry-live again', async () => {
    let shouldCommitResize = false;
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      shouldCommitResize: () => shouldCommitResize,
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(200);

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 120, rows: 40 }),
    );

    shouldCommitResize = true;
    pipeline.flushPendingResize();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.ResizeAgent, {
      agentId: 'agent-1',
      cols: 120,
      controllerId: 'runtime-client-1',
      requestId: expect.any(String),
      rows: 40,
      taskId: 'task-1',
    });

    pipeline.cleanup();
  });

  it('notifies when resize transactions start and finish', async () => {
    let resolveResize: ((value: undefined) => void) | undefined;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveResize = resolve;
        }),
    );

    const onResizeTransactionChange = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onResizeTransactionChange,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalResize(100, 30);

    expect(onResizeTransactionChange).toHaveBeenNthCalledWith(1, true);

    await vi.advanceTimersByTimeAsync(48);
    resolveResize?.(undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onResizeTransactionChange).toHaveBeenNthCalledWith(2, false);

    pipeline.cleanup();
  });

  it('notifies the session when a resize commit succeeds', async () => {
    const onResizeCommitted = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onResizeCommitted,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);
    await Promise.resolve();
    await Promise.resolve();

    expect(onResizeCommitted).toHaveBeenCalledTimes(1);
    expect(onResizeCommitted).toHaveBeenCalledWith({ cols: 100, rows: 30 });
    pipeline.cleanup();
  });

  it('does not send a final resize while the terminal session is cleaning up', async () => {
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => true,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: { cols: 80, rows: 24 } as never,
    });

    pipeline.handleTerminalResize(100, 30);
    pipeline.cleanup();
    await vi.advanceTimersByTimeAsync(60);

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 100, rows: 30 }),
    );
  });
});
