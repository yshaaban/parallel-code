import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', () => ({
  BROWSER_AGENT_COMMAND_CANCELED_ERROR_MESSAGE: 'cancelled',
  cancelBrowserAgentCommandRequest: vi.fn(),
  invoke: vi.fn(),
  sendTerminalInput: vi.fn(async () => undefined),
  sendTerminalInputTraceUpdate: vi.fn(),
}));

vi.mock('../../app/task-command-lease-session', () => ({
  createTaskCommandLeaseSession: vi.fn(() => ({
    acquire: vi.fn(async () => true),
    cleanup: vi.fn(),
    release: vi.fn(async () => undefined),
    takeOver: vi.fn(async () => true),
    touch: vi.fn(() => true),
  })),
  hasTaskCommandLeaseTransportAvailability: vi.fn(() => true),
}));

import { IPC } from '../../../electron/ipc/channels';
import {
  createTaskCommandLeaseSession,
  hasTaskCommandLeaseTransportAvailability,
  type TaskCommandLeaseSession,
} from '../../app/task-command-lease-session';
import {
  cancelBrowserAgentCommandRequest,
  invoke,
  sendTerminalInput,
  sendTerminalInputTraceUpdate,
} from '../../lib/ipc';
import {
  beginTerminalSwitchEchoGrace,
  getTerminalSwitchEchoGraceSnapshot,
  resetTerminalSwitchEchoGraceForTests,
} from '../../app/terminal-switch-echo-grace';
import {
  getRendererRuntimeDiagnosticsSnapshot,
  resetRendererRuntimeDiagnostics,
} from '../../app/runtime-diagnostics';
import { getInputStageStats, resetInputStageSamples } from '../../lib/terminalLatency';
import {
  resetTerminalTraceClockAlignmentForTests,
  setTerminalTraceClockAlignment,
} from '../../lib/terminal-trace-clock';
import {
  applyTaskCommandControllerChanged,
  replaceTaskCommandControllers,
  resetTaskCommandControllerStateForTests,
} from '../../store/task-command-controllers';
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

function mockNextTaskCommandLeaseSession(
  overrides: Partial<TaskCommandLeaseSession> = {},
): TaskCommandLeaseSession {
  const session = {
    acquire: vi.fn(async () => true),
    cleanup: vi.fn(),
    release: vi.fn(async () => undefined),
    takeOver: vi.fn(async () => true),
    touch: vi.fn(() => false),
    ...overrides,
  } satisfies TaskCommandLeaseSession;
  vi.mocked(createTaskCommandLeaseSession).mockReturnValueOnce(session);
  return session;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function resetTaskCommandControllersForPipelineTests(): void {
  resetTaskCommandControllerStateForTests();
  replaceTaskCommandControllers([], { replaceVersion: 0 });
}

type TerminalInputPipelineOptions = Parameters<typeof createTerminalInputPipeline>[0];
type TestTerminal = TerminalInputPipelineOptions['term'];
type TestTerminalBufferType = 'alternate' | 'normal';

function createTestTerminal(
  options: {
    bufferType?: TestTerminalBufferType;
    cols?: number;
    rows?: number;
  } = {},
): TestTerminal {
  const terminal = {
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
  };

  if (!options.bufferType) {
    return terminal as TestTerminal;
  }

  return {
    ...terminal,
    buffer: {
      active: {
        type: options.bufferType,
      },
    },
  } as TestTerminal;
}

describe('terminal-input-pipeline', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
    resetRendererRuntimeDiagnostics();
    resetInputStageSamples();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalTraceClockAlignmentForTests();
    resetTaskCommandControllersForPipelineTests();
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(hasTaskCommandLeaseTransportAvailability).mockReturnValue(true);
  });

  afterEach(() => {
    resetRendererRuntimeDiagnostics();
    resetInputStageSamples();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalTraceClockAlignmentForTests();
    vi.runOnlyPendingTimers();
    resetTaskCommandControllersForPipelineTests();
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('activates the post-input-ready echo grace on the first local interactive input', async () => {
    const armInteractiveEchoFastPath = vi.fn();
    const onInputActivity = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onInputActivity,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: createTestTerminal(),
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
    expect(onInputActivity).toHaveBeenCalledTimes(1);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: true,
        targetTaskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('reports local input feedback when user input is locally admitted', () => {
    const onLocalInputFeedback = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onLocalInputFeedback,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');

    expect(onLocalInputFeedback).toHaveBeenCalledWith('a');
    expect(onLocalInputFeedback).toHaveBeenCalledTimes(1);

    pipeline.cleanup();
  });

  it('does not report local input feedback for restoration-buffered input', async () => {
    let canAcceptInput = false;
    const onLocalInputFeedback = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => canAcceptInput,
      canBufferInputWhileInteractionPending: () => true,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onLocalInputFeedback,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('buffered while restoring');
    await vi.advanceTimersByTimeAsync(2);

    expect(onLocalInputFeedback).not.toHaveBeenCalled();

    canAcceptInput = true;
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(onLocalInputFeedback).not.toHaveBeenCalled();

    pipeline.cleanup();
  });

  it('reports accepted input only after the backend accepts the sent batch', async () => {
    const sendDeferred = createDeferred<undefined>();
    const onInputAccepted = vi.fn();
    const onInputActivity = vi.fn();
    vi.mocked(sendTerminalInput).mockImplementationOnce(() => sendDeferred.promise);
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onInputAccepted,
      onInputActivity,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(onInputActivity).toHaveBeenCalledTimes(1);
    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(onInputAccepted).not.toHaveBeenCalled();

    sendDeferred.resolve(undefined);
    await flushMicrotasks();

    expect(onInputAccepted).toHaveBeenCalledTimes(1);

    pipeline.cleanup();
  });

  it('does not report accepted input when the backend rejects the sent batch', async () => {
    const sendDeferred = createDeferred<undefined>();
    const onInputAccepted = vi.fn();
    sendDeferred.promise.catch(() => undefined);
    vi.mocked(sendTerminalInput).mockImplementationOnce(() => sendDeferred.promise);
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onInputAccepted,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    sendDeferred.reject(new Error('backend rejected input'));
    await flushMicrotasks();

    expect(onInputAccepted).not.toHaveBeenCalled();

    pipeline.cleanup();
  });

  it('marks local input activity for programmatic terminal input', async () => {
    const onInputActivity = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => false,
      isSpawnReady: () => true,
      onInputActivity,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'claude',
        cwd: '/tmp/project',
        taskId: 'task-1',
      },
      runtimeClientId: 'runtime-client-1',
      taskId: 'task-1',
      term: createTestTerminal(),
    });

    pipeline.enqueueProgrammaticInput('start\n');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(onInputActivity).toHaveBeenCalledTimes(1);
    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'start\n',
        taskId: 'task-1',
      }),
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
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
      term: createTestTerminal(),
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

    pipeline.detectPendingInputTraceEcho(new TextEncoder().encode('b'), 100, 95);
    pipeline.finalizePendingInputTraceEchoes(110);

    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenCalledWith({
      agentId: 'agent-1',
      outputReceivedAtMs: 100,
      outputRenderedAtMs: 110,
      outputTransportReceivedAtMs: 95,
      requestId: requestIds[1],
    });

    pipeline.cleanup();
  });

  it('does not create echo trace expectations for ANSI control input', async () => {
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('\x1b[A');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const request = vi.mocked(sendTerminalInput).mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        data: '\x1b[A',
        taskId: 'task-1',
      }),
    );
    expect(request).not.toHaveProperty('trace');

    pipeline.detectPendingInputTraceEcho(new TextEncoder().encode('[A'), 100, 95);
    pipeline.finalizePendingInputTraceEchoes(110);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).not.toHaveBeenCalled();

    pipeline.cleanup();
  });

  it('does not create echo trace expectations for DEL backspace input', async () => {
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('\x7f');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    const request = vi.mocked(sendTerminalInput).mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        data: '\x7f',
        taskId: 'task-1',
      }),
    );
    expect(request).not.toHaveProperty('trace');

    pipeline.detectPendingInputTraceEcho(new TextEncoder().encode('\x7f'), 100, 95);
    pipeline.finalizePendingInputTraceEchoes(110);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).not.toHaveBeenCalled();

    pipeline.cleanup();
  });

  it('matches input trace echoes split across UTF-8 output chunks', async () => {
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('é');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    const requestId = vi.mocked(sendTerminalInput).mock.calls[0]?.[0].requestId;
    expect(requestId).toBeTruthy();

    const encodedEcho = new TextEncoder().encode('é');
    pipeline.detectPendingInputTraceEcho(encodedEcho.slice(0, 1), 100, 95);
    pipeline.finalizePendingInputTraceEchoes(110);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).not.toHaveBeenCalled();

    pipeline.detectPendingInputTraceEcho(encodedEcho.slice(1), 101, 96);
    pipeline.finalizePendingInputTraceEchoes(111);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenCalledWith({
      agentId: 'agent-1',
      outputReceivedAtMs: 101,
      outputRenderedAtMs: 111,
      outputTransportReceivedAtMs: 96,
      requestId,
    });

    pipeline.cleanup();
  });

  it('evicts oldest unmatched trace echo expectations when the cap is reached', async () => {
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
      term: createTestTerminal(),
    });

    const inputChars = Array.from({ length: 260 }, (_, index) =>
      String.fromCodePoint(0x100 + index),
    );
    for (const inputChar of inputChars) {
      pipeline.handleTerminalData(inputChar);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
    }

    const requestIds = vi
      .mocked(sendTerminalInput)
      .mock.calls.map(([request]) => request.requestId)
      .filter((requestId): requestId is string => typeof requestId === 'string');
    expect(requestIds).toHaveLength(260);

    pipeline.detectPendingInputTraceEcho(new TextEncoder().encode(inputChars[0] ?? ''), 100, 95);
    pipeline.finalizePendingInputTraceEchoes(110);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).not.toHaveBeenCalled();

    pipeline.detectPendingInputTraceEcho(
      new TextEncoder().encode(inputChars.at(-1) ?? ''),
      101,
      96,
    );
    pipeline.finalizePendingInputTraceEchoes(111);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenCalledWith({
      agentId: 'agent-1',
      outputReceivedAtMs: 101,
      outputRenderedAtMs: 111,
      outputTransportReceivedAtMs: 96,
      requestId: requestIds.at(-1),
    });

    pipeline.cleanup();
  });

  it('does not reuse stale keyboard trace starts for later terminal input', async () => {
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
      term: createTestTerminal(),
    });

    const staleStartedAtMs = performance.timeOrigin + performance.now();
    pipeline.recordKeyboardTraceStart({
      altKey: false,
      ctrlKey: true,
      key: 'u',
      metaKey: false,
      shiftKey: false,
    });
    await vi.advanceTimersByTimeAsync(500);

    const freshStartedAtFloorMs = performance.timeOrigin + performance.now();
    pipeline.recordKeyboardTraceStart({
      altKey: false,
      ctrlKey: false,
      key: 'x',
      metaKey: false,
      shiftKey: false,
    });
    pipeline.handleTerminalData('x');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    const request = vi.mocked(sendTerminalInput).mock.calls[0]?.[0] as
      | {
          trace?: {
            bufferedAtMs: number;
            startedAtMs: number;
          };
        }
      | undefined;

    expect(request?.trace?.startedAtMs).not.toBe(staleStartedAtMs);
    expect(request?.trace?.startedAtMs).toBeGreaterThanOrEqual(freshStartedAtFloorMs);
    expect(
      (request?.trace?.bufferedAtMs ?? Number.POSITIVE_INFINITY) -
        (request?.trace?.startedAtMs ?? 0),
    ).toBeLessThan(5);

    pipeline.cleanup();
  });

  it('attributes immediately flushed keyboard input as unbuffered client-side', async () => {
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
      term: createTestTerminal(),
    });

    pipeline.recordKeyboardTraceStart({
      altKey: false,
      ctrlKey: false,
      key: 'x',
      metaKey: false,
      shiftKey: false,
    });
    pipeline.handleTerminalData('x');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    const request = vi.mocked(sendTerminalInput).mock.calls[0]?.[0] as
      | {
          trace?: {
            bufferedAtMs: number;
            startedAtMs: number;
          };
        }
      | undefined;

    expect(request?.trace?.bufferedAtMs).toBe(request?.trace?.startedAtMs);

    pipeline.cleanup();
  });

  it('marks split interactive echoes at their earliest visible match instead of waiting for a final suffix', async () => {
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('l');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    pipeline.handleTerminalData('atencyprobe');
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    const requestIds = vi
      .mocked(sendTerminalInput)
      .mock.calls.map(([request]) => request.requestId)
      .filter((requestId): requestId is string => typeof requestId === 'string');
    expect(requestIds).toHaveLength(2);

    pipeline.detectPendingInputTraceEcho(new TextEncoder().encode('latencyprobe'), 100);
    pipeline.finalizePendingInputTraceEchoes(105);

    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-1',
      outputReceivedAtMs: 100,
      outputRenderedAtMs: 105,
      requestId: requestIds[0],
    });
    expect(vi.mocked(sendTerminalInputTraceUpdate)).toHaveBeenNthCalledWith(2, {
      agentId: 'agent-1',
      outputReceivedAtMs: 100,
      outputRenderedAtMs: 105,
      requestId: requestIds[1],
    });

    pipeline.cleanup();
  });

  it('skips buffered-char queue scans when renderer runtime diagnostics are disabled', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    resetRendererRuntimeDiagnostics();
    const reduceSpy = vi.spyOn(Array.prototype, 'reduce');

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
      term: createTestTerminal(),
    });

    reduceSpy.mockClear();

    pipeline.handleTerminalData('abc');
    await flushMicrotasks();

    expect(reduceSpy).not.toHaveBeenCalled();

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('blocked input');
    await vi.advanceTimersByTimeAsync(20);

    expect(onBlockedInputAttempt).toHaveBeenCalledTimes(1);
    expect(sendTerminalInput).not.toHaveBeenCalled();
    pipeline.cleanup();
  });

  it('buffers terminal input while interaction is pending and flushes it after input is accepted', async () => {
    let canAcceptInput = false;
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => canAcceptInput,
      canBufferInputWhileInteractionPending: () => true,
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('buffered while restoring');
    await vi.advanceTimersByTimeAsync(2);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    canAcceptInput = true;
    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'buffered while restoring',
        taskId: 'task-1',
      }),
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
      }),
    );

    pipeline.cleanup();
  });

  it('coalesces restore-buffered keystrokes into one ordered batch after input is accepted', async () => {
    let canAcceptInput = false;
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => canAcceptInput,
      canBufferInputWhileInteractionPending: () => true,
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
      term: createTestTerminal(),
    });

    for (const data of ['R', 'E', 'S', 'T', 'O', 'R', 'E', '\r']) {
      pipeline.handleTerminalData(data);
      await vi.advanceTimersByTimeAsync(2);
    }

    expect(sendTerminalInput).not.toHaveBeenCalled();

    canAcceptInput = true;
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        data: 'RESTORE\r',
        inputSeq: 0,
      }),
    );

    pipeline.cleanup();
  });

  it('drops terminal input while interaction is pending if the terminal cannot buffer it safely', async () => {
    const onBlockedInputAttempt = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => false,
      canBufferInputWhileInteractionPending: () => false,
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => true,
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('blocked restore input');
    await vi.advanceTimersByTimeAsync(50);

    expect(onBlockedInputAttempt).toHaveBeenCalledTimes(1);
    expect(sendTerminalInput).not.toHaveBeenCalled();

    pipeline.cleanup();
  });

  it('batches the first interactive burst after lease reacquire instead of sending a partial first key', async () => {
    const acquireDeferred = createDeferred<boolean>();
    mockNextTaskCommandLeaseSession({
      acquire: vi.fn(() => acquireDeferred.promise),
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    await vi.advanceTimersByTimeAsync(2);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    acquireDeferred.resolve(true);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'abc',
        taskId: 'task-1',
      }),
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
      }),
    );

    pipeline.cleanup();
  });

  it('does not send queued input when lease reacquire resolves after disposal', async () => {
    const acquireDeferred = createDeferred<boolean>();
    let disposed = false;
    mockNextTaskCommandLeaseSession({
      acquire: vi.fn(() => acquireDeferred.promise),
    });

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      canAcceptInput: () => true,
      isDisposed: () => disposed,
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('abc');
    await vi.advanceTimersByTimeAsync(2);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    disposed = true;
    acquireDeferred.resolve(true);
    await flushMicrotasks();

    expect(sendTerminalInput).not.toHaveBeenCalled();

    pipeline.cleanup();
  });

  it('dispatches sustained interactive typing concurrently without dropping suffix input', async () => {
    const firstSendDeferred = createDeferred<undefined>();
    const secondSendDeferred = createDeferred<undefined>();
    const thirdSendDeferred = createDeferred<undefined>();
    vi.mocked(sendTerminalInput)
      .mockImplementationOnce(() => firstSendDeferred.promise)
      .mockImplementationOnce(() => secondSendDeferred.promise)
      .mockImplementationOnce(() => thirdSendDeferred.promise);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'a',
        taskId: 'task-1',
      }),
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
      }),
    );

    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(3);
    secondSendDeferred.resolve(undefined);
    thirdSendDeferred.resolve(undefined);
    firstSendDeferred.resolve(undefined);
    await flushMicrotasks();
    expect(
      vi
        .mocked(sendTerminalInput)
        .mock.calls.map(([request]) => request.data)
        .join(''),
    ).toBe('abc');

    pipeline.cleanup();
  });

  it('caps the first interactive send batch to a small burst after queued input builds up', async () => {
    const acquireDeferred = createDeferred<boolean>();
    const firstSendDeferred = createDeferred<undefined>();
    const secondSendDeferred = createDeferred<undefined>();
    let leaseAcquired = false;
    mockNextTaskCommandLeaseSession({
      acquire: vi.fn(() =>
        acquireDeferred.promise.then((acquired) => {
          leaseAcquired = acquired;
          return acquired;
        }),
      ),
      touch: vi.fn(() => leaseAcquired),
    });
    vi.mocked(sendTerminalInput)
      .mockImplementationOnce(() => firstSendDeferred.promise)
      .mockImplementationOnce(() => secondSendDeferred.promise);

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
      term: createTestTerminal(),
    });

    for (const char of 'abcde') {
      pipeline.handleTerminalData(char);
    }
    await vi.advanceTimersByTimeAsync(2);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    acquireDeferred.resolve(true);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'abcd',
        taskId: 'task-1',
      }),
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
      }),
    );
    expect(vi.mocked(sendTerminalInput)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'e',
        taskId: 'task-1',
      }),
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
      }),
    );
    firstSendDeferred.resolve(undefined);
    secondSendDeferred.resolve(undefined);
    await flushMicrotasks();

    pipeline.cleanup();
  });

  it('retries queued interactive input after an earlier in-flight batch fails', async () => {
    const firstSendDeferred = createDeferred<undefined>();
    const secondSendDeferred = createDeferred<undefined>();
    const thirdSendDeferred = createDeferred<undefined>();
    firstSendDeferred.promise.catch(() => undefined);
    vi.mocked(sendTerminalInput)
      .mockImplementationOnce(() => firstSendDeferred.promise)
      .mockImplementationOnce(() => secondSendDeferred.promise)
      .mockImplementationOnce(() => thirdSendDeferred.promise);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(3);
    const initialRequests = vi.mocked(sendTerminalInput).mock.calls.map(([request]) => request);
    expect(initialRequests.map((request) => request.data).join('')).toBe('abc');

    firstSendDeferred.reject(new Error('socket unavailable'));
    await flushMicrotasks();

    expect(vi.mocked(cancelBrowserAgentCommandRequest)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cancelBrowserAgentCommandRequest)).toHaveBeenNthCalledWith(
      1,
      initialRequests[1]?.requestId,
    );
    expect(vi.mocked(cancelBrowserAgentCommandRequest)).toHaveBeenNthCalledWith(
      2,
      initialRequests[2]?.requestId,
    );

    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(6);
    const retryRequests = vi
      .mocked(sendTerminalInput)
      .mock.calls.slice(3)
      .map(([request]) => request);
    expect(retryRequests.map((request) => request.data).join('')).toBe('abc');
    for (const [index, retryRequest] of retryRequests.entries()) {
      expect(retryRequest.inputEpoch).toBe(initialRequests[index]?.inputEpoch);
      expect(retryRequest.inputSeq).toBe(initialRequests[index]?.inputSeq);
    }

    secondSendDeferred.resolve(undefined);
    thirdSendDeferred.resolve(undefined);
    await flushMicrotasks();

    pipeline.cleanup();
  });

  it('retries accepted suffix input after an earlier ordered batch fails', async () => {
    const firstSendDeferred = createDeferred<undefined>();
    const secondSendDeferred = createDeferred<undefined>();
    const thirdSendDeferred = createDeferred<undefined>();
    firstSendDeferred.promise.catch(() => undefined);
    vi.mocked(sendTerminalInput)
      .mockImplementationOnce(() => firstSendDeferred.promise)
      .mockImplementationOnce(() => secondSendDeferred.promise)
      .mockImplementationOnce(() => thirdSendDeferred.promise)
      .mockResolvedValue(undefined);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(3);
    const initialRequests = vi.mocked(sendTerminalInput).mock.calls.map(([request]) => request);
    expect(initialRequests.map((request) => request.data).join('')).toBe('abc');

    secondSendDeferred.resolve(undefined);
    thirdSendDeferred.resolve(undefined);
    await flushMicrotasks();

    firstSendDeferred.reject(new Error('socket unavailable'));
    await flushMicrotasks();

    expect(vi.mocked(cancelBrowserAgentCommandRequest)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(6);
    const retryRequests = vi
      .mocked(sendTerminalInput)
      .mock.calls.slice(3)
      .map(([request]) => request);
    expect(retryRequests.map((request) => request.data).join('')).toBe('abc');
    for (const [index, retryRequest] of retryRequests.entries()) {
      expect(retryRequest.inputEpoch).toBe(initialRequests[index]?.inputEpoch);
      expect(retryRequest.inputSeq).toBe(initialRequests[index]?.inputSeq);
    }

    pipeline.cleanup();
  });

  it('dispatches later interactive input while an earlier batch is in flight', async () => {
    const firstSendDeferred = createDeferred<undefined>();
    vi.mocked(sendTerminalInput)
      .mockImplementationOnce(() => firstSendDeferred.promise)
      .mockResolvedValueOnce(undefined);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(3);
    expect(
      vi
        .mocked(sendTerminalInput)
        .mock.calls.map(([request]) => request.data)
        .join(''),
    ).toBe('abc');
    expect(vi.mocked(cancelBrowserAgentCommandRequest)).not.toHaveBeenCalled();

    firstSendDeferred.resolve(undefined);
    await flushMicrotasks();

    pipeline.cleanup();
  });

  it('preserves a long interactive burst while sends resolve between key events', async () => {
    vi.mocked(sendTerminalInput).mockResolvedValue(undefined);
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
      term: createTestTerminal(),
    });

    const input = `browser-input-burst-${'xyz123'.repeat(12)}`;
    for (const char of input) {
      pipeline.handleTerminalData(char);
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
    }

    expect(
      vi
        .mocked(sendTerminalInput)
        .mock.calls.map(([request]) => request.data)
        .join(''),
    ).toBe(input);

    pipeline.cleanup();
  });

  it('preserves a long same-tick interactive burst across concurrent send waves', async () => {
    vi.mocked(sendTerminalInput).mockResolvedValue(undefined);
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
      term: createTestTerminal(),
    });

    const input = `browser-input-burst-${'xyz123'.repeat(12)}`;
    for (const char of input) {
      pipeline.handleTerminalData(char);
    }

    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(
      vi
        .mocked(sendTerminalInput)
        .mock.calls.map(([request]) => request.data)
        .join(''),
    ).toBe(input);

    pipeline.cleanup();
  });

  it('keeps control input queued behind active interactive sends', async () => {
    const firstSendDeferred = createDeferred<undefined>();
    vi.mocked(sendTerminalInput)
      .mockImplementationOnce(() => firstSendDeferred.promise)
      .mockResolvedValueOnce(undefined);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    pipeline.handleTerminalData('\r');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput).mock.calls[0]?.[0].data).toBe('a');

    firstSendDeferred.resolve(undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendTerminalInput).mock.calls[1]?.[0].data).toBe('\r');

    pipeline.cleanup();
  });

  it('keeps control input separate from pending printable input while earlier sends are active', async () => {
    const firstSendDeferred = createDeferred<undefined>();
    const secondSendDeferred = createDeferred<undefined>();
    vi.mocked(sendTerminalInput)
      .mockImplementationOnce(() => firstSendDeferred.promise)
      .mockImplementationOnce(() => secondSendDeferred.promise)
      .mockResolvedValueOnce(undefined);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('\r');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendTerminalInput).mock.calls.map(([request]) => request.data)).toEqual([
      'a',
      'b',
    ]);

    firstSendDeferred.resolve(undefined);
    secondSendDeferred.resolve(undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(3);
    expect(vi.mocked(sendTerminalInput).mock.calls[2]?.[0].data).toBe('\r');

    pipeline.cleanup();
  });

  it('keeps same-tick interactive request-tracked input below the in-flight cap', async () => {
    const sendDeferreds = Array.from({ length: 3 }, () => createDeferred<undefined>());
    const queuedSendDeferreds = [...sendDeferreds];
    vi.mocked(sendTerminalInput).mockImplementation(
      () => queuedSendDeferreds.shift()?.promise ?? Promise.resolve(undefined),
    );

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
      term: createTestTerminal(),
    });

    for (const char of 'abc') {
      pipeline.handleTerminalData(char);
    }
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(getRendererRuntimeDiagnosticsSnapshot().terminalInput.inFlightBatchesMax).toBe(1);

    for (const deferred of sendDeferreds) {
      deferred?.resolve(undefined);
    }
    await flushMicrotasks();
    expect(
      vi
        .mocked(sendTerminalInput)
        .mock.calls.map(([request]) => request.data)
        .join(''),
    ).toBe('abc');

    pipeline.cleanup();
  });

  it('keeps queued input buffered while task-command transport is temporarily unavailable', async () => {
    mockNextTaskCommandLeaseSession({
      acquire: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
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
      term: createTestTerminal(),
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
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
      }),
    );

    pipeline.cleanup();
  });

  it('retries failed terminal input with the same ordering token for backend idempotency', async () => {
    vi.mocked(sendTerminalInput)
      .mockRejectedValueOnce(new Error('socket closed after partial input'))
      .mockResolvedValue(undefined);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('retry-safe\r');
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    const inputRequests = vi.mocked(sendTerminalInput).mock.calls.map(([request]) => request);
    expect(inputRequests).toHaveLength(2);
    expect(inputRequests[0]).toEqual(
      expect.objectContaining({
        data: 'retry-safe\r',
        inputEpoch: expect.any(String),
        inputSeq: 0,
      }),
    );
    expect(inputRequests[1]).toEqual(
      expect.objectContaining({
        data: 'retry-safe\r',
        inputEpoch: inputRequests[0]?.inputEpoch,
        inputSeq: inputRequests[0]?.inputSeq,
      }),
    );

    pipeline.cleanup();
  });

  it('records task-command lease wait separately from input dispatch timing', async () => {
    window.__TERMINAL_PERF__ = true;
    const acquireDeferred = createDeferred<boolean>();
    mockNextTaskCommandLeaseSession({
      acquire: vi.fn(() => acquireDeferred.promise),
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    await vi.advanceTimersByTimeAsync(9);
    expect(sendTerminalInput).not.toHaveBeenCalled();

    acquireDeferred.resolve(true);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(getInputStageStats().leaseWait).toEqual(
      expect.objectContaining({
        count: 1,
        p50: 9,
        p95: 9,
      }),
    );

    pipeline.cleanup();
  });

  it('keeps buffered interactive input when controller ownership is temporarily null during lease reacquire', async () => {
    const acquireDeferred = createDeferred<boolean>();
    mockNextTaskCommandLeaseSession({
      acquire: vi.fn(() => acquireDeferred.promise),
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalData('a');
    pipeline.handleTerminalData('b');
    pipeline.handleTerminalData('c');
    pipeline.handleControllerChange(null);
    await vi.advanceTimersByTimeAsync(2);

    expect(sendTerminalInput).not.toHaveBeenCalled();

    acquireDeferred.resolve(true);
    await flushMicrotasks();

    expect(sendTerminalInput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTerminalInput)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        data: 'abc',
        taskId: 'task-1',
      }),
      expect.objectContaining({
        onBrowserCommandResultReceived: expect.any(Function),
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
      term: createTestTerminal(),
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
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 40,
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('does not retain task command ownership solely for a terminal resize', async () => {
    const leaseSession = mockNextTaskCommandLeaseSession({
      acquire: vi.fn(async () => true),
      touch: vi.fn(() => false),
    });
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(48);
    await flushMicrotasks();

    expect(leaseSession.acquire).not.toHaveBeenCalled();
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalResize.commitDeferredCounts['not-live'],
    ).toBeGreaterThan(0);
    expect(pipeline.isResizeTransactionPending()).toBe(false);

    pipeline.cleanup();
  });

  it('rehydrates task command ownership before committing a terminal resize for the controller', async () => {
    const acquireDeferred = createDeferred<boolean>();
    const leaseSession = mockNextTaskCommandLeaseSession({
      acquire: vi.fn(() => acquireDeferred.promise),
      touch: vi.fn(() => false),
    });
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'runtime-client-1',
      taskId: 'task-1',
      version: 1,
    });
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(48);
    await flushMicrotasks();

    expect(leaseSession.acquire).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    acquireDeferred.resolve(true);
    await flushMicrotasks();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 40,
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('preserves only the latest peer-controlled resize and commits it after takeover', async () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 1,
    });

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    pipeline.handleTerminalResize(132, 36);
    await vi.advanceTimersByTimeAsync(48);

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalResize.commitDeferredCounts[
        'peer-controlled'
      ],
    ).toBeGreaterThanOrEqual(2);

    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'runtime-client-1',
      taskId: 'task-1',
      version: 2,
    });
    pipeline.handleControllerChange('runtime-client-1');
    await flushMicrotasks();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 132,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 36,
        taskId: 'task-1',
      }),
    );
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 100, rows: 30 }),
    );

    pipeline.cleanup();
  });

  it('commits the latest peer-deferred resize when task control becomes unowned', async () => {
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 1,
    });

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    pipeline.handleTerminalResize(132, 36);
    await vi.advanceTimersByTimeAsync(48);

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: null,
      taskId: 'task-1',
      version: 2,
    });
    pipeline.handleControllerChange(null);
    await flushMicrotasks();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 132,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 36,
        taskId: 'task-1',
      }),
    );
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 100, rows: 30 }),
    );

    pipeline.cleanup();
  });

  it('does not commit a peer-deferred resize when input takeover resolves after disposal', async () => {
    const takeoverDeferred = createDeferred<boolean>();
    let disposed = false;
    mockNextTaskCommandLeaseSession({
      takeOver: vi.fn(() => takeoverDeferred.promise),
    });
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-client',
      taskId: 'task-1',
      version: 1,
    });

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => disposed,
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(132, 36);
    await vi.advanceTimersByTimeAsync(48);

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    const takeoverPromise = pipeline.requestInputTakeover();
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'runtime-client-1',
      taskId: 'task-1',
      version: 2,
    });
    disposed = true;
    takeoverDeferred.resolve(true);

    await expect(takeoverPromise).resolves.toBe(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60);

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

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
      term: createTestTerminal({ bufferType: 'alternate' }),
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    pipeline.handleTerminalResize(120, 40);
    await Promise.resolve();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(48);
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

  it('keeps a resize back to the last sent geometry while another resize is in flight', async () => {
    const resizeDeferreds: Array<ReturnType<typeof createDeferred<undefined>>> = [];
    vi.mocked(invoke).mockImplementation(() => {
      const deferred = createDeferred<undefined>();
      resizeDeferreds.push(deferred);
      return deferred.promise;
    });

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    resizeDeferreds[0]?.resolve(undefined);
    await flushMicrotasks();

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(48);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);

    resizeDeferreds[1]?.resolve(undefined);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(48);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 100, rows: 30 }),
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
      term: createTestTerminal(),
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
      term: createTestTerminal(),
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
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 40,
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('treats backend-owned recovery geometry as already committed without suppressing later local resizes', async () => {
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
      term: createTestTerminal(),
    });

    pipeline.adoptBackendResizeForRecovery({ cols: 100, rows: 30 });
    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(120);

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    pipeline.handleTerminalResize(101, 30);
    await vi.advanceTimersByTimeAsync(120);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 101,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 30,
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('rotates resize ordering epochs when a committed resize must be retried', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('resize failed'))
      .mockResolvedValue(undefined);
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(120);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(120);
    await flushMicrotasks();

    const resizeRequests = vi
      .mocked(invoke)
      .mock.calls.filter(([channel]) => channel === IPC.ResizeAgent)
      .map(([, request]) => request as { resizeEpoch: string; resizeSeq: number });

    expect(resizeRequests).toHaveLength(2);
    expect(resizeRequests[0]).toEqual(
      expect.objectContaining({
        resizeEpoch: expect.any(String),
        resizeSeq: 0,
      }),
    );
    expect(resizeRequests[1]).toEqual(
      expect.objectContaining({
        resizeEpoch: expect.any(String),
        resizeSeq: 0,
      }),
    );
    expect(resizeRequests[1]?.resizeEpoch).not.toBe(resizeRequests[0]?.resizeEpoch);

    pipeline.cleanup();
  });

  it('records restore-blocked resize deferral and commits once restore settles', async () => {
    let restoreBlocked = true;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });

    const onResizeCommitted = vi.fn();
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => restoreBlocked,
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(60);

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 120, rows: 40 }),
    );
    expect(
      getRendererRuntimeDiagnosticsSnapshot().terminalResize.commitDeferredCounts[
        'restore-blocked'
      ],
    ).toBeGreaterThan(0);

    restoreBlocked = false;
    pipeline.flushPendingResize();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 40,
        taskId: 'task-1',
      }),
    );
    expect(onResizeCommitted).toHaveBeenCalledWith({ cols: 120, rows: 40 });

    pipeline.cleanup();
  });

  it('commits a restore-blocked resize during recovery alignment', async () => {
    let restoreBlocked = true;

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(60);

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 120, rows: 40 }),
    );

    await pipeline.flushPendingResizeForRecoveryAlignment();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 40,
        taskId: 'task-1',
      }),
    );

    restoreBlocked = false;
    pipeline.cleanup();
  });

  it('commits the live terminal geometry during recovery alignment even without a queued resize', async () => {
    const term = createTestTerminal({ cols: 120, rows: 40 });
    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => true,
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
      term,
    });

    await pipeline.flushPendingResizeForRecoveryAlignment();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 40,
        taskId: 'task-1',
      }),
    );

    pipeline.cleanup();
  });

  it('commits recovery alignment resize while the terminal is not geometry-live', async () => {
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
      shouldCommitResize: () => false,
      taskId: 'task-1',
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(120, 40);
    await vi.advanceTimersByTimeAsync(60);

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 120, rows: 40 }),
    );

    await pipeline.flushPendingResizeForRecoveryAlignment();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({
        agentId: 'agent-1',
        cols: 120,
        controllerId: 'runtime-client-1',
        requestId: expect.any(String),
        resizeEpoch: expect.any(String),
        resizeSeq: expect.any(Number),
        rows: 40,
        taskId: 'task-1',
      }),
    );

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
      term: createTestTerminal(),
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

  it('keeps the resize transaction active while an in-flight follow-up resize is deferred', async () => {
    const firstResize = createDeferred<undefined>();
    const secondResize = createDeferred<undefined>();
    vi.mocked(invoke)
      .mockImplementationOnce(() => firstResize.promise)
      .mockImplementationOnce(() => secondResize.promise);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(onResizeTransactionChange).toHaveBeenCalledTimes(1);
    expect(onResizeTransactionChange).toHaveBeenNthCalledWith(1, true);

    pipeline.handleTerminalResize(120, 40);
    firstResize.resolve(undefined);
    await flushMicrotasks();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(onResizeTransactionChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(48);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith(
      IPC.ResizeAgent,
      expect.objectContaining({ cols: 120, rows: 40 }),
    );

    secondResize.resolve(undefined);
    await flushMicrotasks();

    expect(onResizeTransactionChange).toHaveBeenCalledTimes(2);
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);
    await Promise.resolve();
    await Promise.resolve();

    expect(onResizeCommitted).toHaveBeenCalledTimes(1);
    expect(onResizeCommitted).toHaveBeenCalledWith({ cols: 100, rows: 30 });
    pipeline.cleanup();
  });

  it('waits for an in-flight resize commit before flushPendingResize resolves', async () => {
    const deferredResize = createDeferred<undefined>();
    vi.mocked(invoke).mockImplementation(() => deferredResize.promise);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);

    let flushResolved = false;
    const flushPromise = pipeline.flushPendingResize().then(() => {
      flushResolved = true;
    });

    await Promise.resolve();
    expect(flushResolved).toBe(false);

    deferredResize.resolve(undefined);
    await flushPromise;

    expect(flushResolved).toBe(true);
    pipeline.cleanup();
  });

  it('does not spin immediate resize retries when a resize send fails and is deferred', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('socket unavailable'));

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await pipeline.flushPendingResize();
    await flushMicrotasks();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(47);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);

    pipeline.cleanup();
  });

  it('backs off before retrying recovery alignment after an in-flight resize fails', async () => {
    const firstResize = createDeferred<undefined>();
    const secondResize = createDeferred<undefined>();
    vi.mocked(invoke)
      .mockImplementationOnce(() => firstResize.promise)
      .mockImplementationOnce(() => secondResize.promise);

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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);

    let alignmentResolved = false;
    const alignmentPromise = pipeline.flushPendingResizeForRecoveryAlignment().then(() => {
      alignmentResolved = true;
    });

    firstResize.reject(new Error('resize unavailable'));
    await flushMicrotasks();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(alignmentResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(47);
    await flushMicrotasks();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);

    secondResize.resolve(undefined);
    await alignmentPromise;

    expect(alignmentResolved).toBe(true);
    pipeline.cleanup();
  });

  it('stops recovery alignment resize retries after a permanent spawn failure', async () => {
    const firstResize = createDeferred<undefined>();
    firstResize.promise.catch(() => undefined);
    vi.mocked(invoke).mockImplementation(() => firstResize.promise);
    let spawnFailed = false;

    const pipeline = createTerminalInputPipeline({
      agentId: 'agent-1',
      armInteractiveEchoFastPath: vi.fn(),
      isDisposed: () => false,
      isProcessExited: () => false,
      isRestoreBlocked: () => false,
      isSpawnFailed: () => spawnFailed,
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
      term: createTestTerminal(),
    });

    pipeline.handleTerminalResize(100, 30);
    await vi.advanceTimersByTimeAsync(48);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    const alignmentPromise = pipeline.flushPendingResizeForRecoveryAlignment();
    spawnFailed = true;
    firstResize.reject(new Error('spawn failed'));
    await alignmentPromise;
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
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
      term: createTestTerminal(),
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
