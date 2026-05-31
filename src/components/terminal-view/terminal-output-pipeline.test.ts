import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', () => ({
  invoke: vi.fn(),
}));

import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import {
  resetTerminalFramePressureForTests,
  setTerminalFramePressureLevelForTests,
} from '../../app/terminal-frame-pressure';
import {
  isTerminalFocusedInputActive,
  isTerminalFocusedInputEchoReservationActive,
  noteTerminalFocusedInput,
  resetTerminalFocusedInputForTests,
} from '../../app/terminal-focused-input';
import { resetTerminalOutputSchedulerForTests } from '../../app/terminal-output-scheduler';
import {
  activateTerminalSwitchEchoGrace,
  beginTerminalSwitchEchoGrace,
  getTerminalSwitchEchoGraceSnapshot,
  resetTerminalSwitchEchoGraceForTests,
} from '../../app/terminal-switch-echo-grace';
import {
  registerTerminalVisibility,
  resetTerminalVisibleSetForTests,
} from '../../app/terminal-visible-set';
import { syncTerminalHighLoadMode } from '../../app/terminal-high-load-mode';
import {
  getTerminalOutputDiagnosticsSnapshot,
  resetTerminalOutputDiagnostics,
} from '../../lib/terminal-output-diagnostics';
import { resetTerminalPerformanceExperimentConfigForTests } from '../../lib/terminal-performance-experiments';
import { setStore } from '../../store/core';
import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';
import {
  createTerminalOutputPipeline,
  FLOW_HIGH,
  type TerminalOutputPipeline,
} from './terminal-output-pipeline';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type TestTerminalOutputPriority = TerminalOutputPriority;

interface TestPipelineHarness {
  markLocalInputObserved: () => void;
  onData: ReturnType<typeof vi.fn>;
  pipeline: TerminalOutputPipeline;
  setPriority: (nextPriority: TestTerminalOutputPriority) => void;
  writes: string[];
}

interface ManualWritePipelineHarness extends TestPipelineHarness {
  finishNextWrite: () => void;
  getPendingWriteCount: () => number;
}

describe('terminal-output-pipeline', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  function setTerminalHighLoadModeForTest(enabled: boolean): void {
    setStore('terminalHighLoadMode', enabled);
    syncTerminalHighLoadMode(enabled);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
    Reflect.deleteProperty(globalThis, '__PARALLEL_CODE_TERMINAL_EXPERIMENTS__');
    Reflect.deleteProperty(globalThis, '__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__');
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => setTimeout(() => callback(16), 0)),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)),
    );
    vi.mocked(invoke).mockResolvedValue(undefined);
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFramePressureForTests();
    resetTerminalOutputSchedulerForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalVisibleSetForTests();
    resetTerminalOutputDiagnostics();
    setTerminalHighLoadModeForTest(false);
  });

  afterEach(() => {
    resetTerminalOutputSchedulerForTests();
    resetTerminalPerformanceExperimentConfigForTests();
    resetTerminalFramePressureForTests();
    resetTerminalSwitchEchoGraceForTests();
    resetTerminalFocusedInputForTests();
    resetTerminalVisibleSetForTests();
    resetTerminalOutputDiagnostics();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(invoke).mockReset();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Reflect.deleteProperty(globalThis, '__PARALLEL_CODE_TERMINAL_EXPERIMENTS__');
    Reflect.deleteProperty(globalThis, '__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__');
    Reflect.deleteProperty(globalThis, 'window');
  });

  function createPipeline(priority: TestTerminalOutputPriority = 'focused'): TestPipelineHarness {
    return createPipelineWithOptions(priority);
  }

  function expectFlowControlPauseRequest(): void {
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.PauseAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
  }

  function expectFlowControlResumeRequest(): void {
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
  }

  function createPipelineWithOptions(
    priority: TestTerminalOutputPriority,
    options: {
      canFlushOutput?: () => boolean;
      hasObservedLocalInput?: boolean;
    } = {},
  ): TestPipelineHarness {
    const writes: string[] = [];
    const onData = vi.fn();
    let currentPriority = priority;
    let hasObservedLocalInput = options.hasObservedLocalInput ?? false;
    const term = {
      write: (chunk: Uint8Array, callback: () => void) => {
        writes.push(decoder.decode(chunk));
        callback();
      },
    };

    const pipeline = createTerminalOutputPipeline({
      agentId: 'agent-1',
      canFlushOutput: options.canFlushOutput ?? (() => true),
      channelId: 'channel-1',
      getOutputPriority: () => currentPriority,
      hasObservedLocalInput: () => hasObservedLocalInput,
      isDisposed: () => false,
      isSpawnFailed: () => false,
      markTerminalReady: vi.fn(),
      onChunkRendered: vi.fn(),
      onQueueEmpty: vi.fn(),
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'fixture',
        cwd: '/tmp',
        onData,
        taskId: 'task-1',
      },
      taskId: 'task-1',
      term,
    });

    return {
      markLocalInputObserved: () => {
        hasObservedLocalInput = true;
      },
      onData,
      pipeline,
      setPriority: (nextPriority: typeof currentPriority) => {
        currentPriority = nextPriority;
      },
      writes,
    };
  }

  function createPipelineWithManualWrites(
    priority: TestTerminalOutputPriority = 'focused',
    options: {
      hasObservedLocalInput?: boolean;
    } = {},
  ): ManualWritePipelineHarness {
    const writes: string[] = [];
    const onData = vi.fn();
    const pendingWriteCallbacks: Array<() => void> = [];
    let currentPriority = priority;
    let hasObservedLocalInput = options.hasObservedLocalInput ?? false;
    const term = {
      write: (chunk: Uint8Array, callback: () => void) => {
        writes.push(decoder.decode(chunk));
        pendingWriteCallbacks.push(callback);
      },
    };

    const pipeline = createTerminalOutputPipeline({
      agentId: 'agent-1',
      canFlushOutput: () => true,
      channelId: 'channel-1',
      getOutputPriority: () => currentPriority,
      hasObservedLocalInput: () => hasObservedLocalInput,
      isDisposed: () => false,
      isSpawnFailed: () => false,
      markTerminalReady: vi.fn(),
      onChunkRendered: vi.fn(),
      onQueueEmpty: vi.fn(),
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'fixture',
        cwd: '/tmp',
        onData,
        taskId: 'task-1',
      },
      taskId: 'task-1',
      term,
    });

    return {
      finishNextWrite: () => {
        const callback = pendingWriteCallbacks.shift();
        if (!callback) {
          throw new Error('Expected a pending terminal write callback');
        }

        callback();
      },
      markLocalInputObserved: () => {
        hasObservedLocalInput = true;
      },
      onData,
      getPendingWriteCount: () => pendingWriteCallbacks.length,
      pipeline,
      setPriority: (nextPriority: typeof currentPriority) => {
        currentPriority = nextPriority;
      },
      writes,
    };
  }

  function registerVisibleTerminals(
    count: number,
  ): Array<ReturnType<typeof registerTerminalVisibility>> {
    return Array.from({ length: count }, (_, index) =>
      registerTerminalVisibility(`visible-${index}`, {
        isFocused: index === 0,
        isSelected: index === 0,
        isVisible: true,
      }),
    );
  }

  function unregisterVisibleTerminals(
    registrations: ReadonlyArray<ReturnType<typeof registerTerminalVisibility>>,
  ): void {
    for (const registration of registrations) {
      registration.unregister();
    }
  }

  function advanceQueuedOutputFlushTimers(): void {
    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();
  }

  function expectFewVisibleWriteShape(
    priority: TestTerminalOutputPriority,
    batchLimitBytes: number,
  ): void {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          [priority]: batchLimitBytes,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const visibleRegistrations = registerVisibleTerminals(4);
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites(priority);

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(batchLimitBytes);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  }

  it('keeps plain focused output on the direct-write path', () => {
    const { onData, pipeline, writes } = createPipeline();

    pipeline.enqueueOutput(encoder.encode('plain shell output'));

    expect(writes).toEqual(['plain shell output']);
    expect(onData).toHaveBeenCalledTimes(1);
    pipeline.cleanup();
  });

  it('ignores late write completion lifecycle side effects after cleanup', () => {
    (
      globalThis.window as typeof globalThis.window & {
        __TERMINAL_OUTPUT_DIAGNOSTICS__?: boolean;
      }
    ).__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;

    const pendingWriteCallbacks: Array<() => void> = [];
    let disposed = false;
    const markTerminalReady = vi.fn();
    const onChunkRendered = vi.fn();
    const onQueueEmpty = vi.fn();
    const term = {
      write: (_chunk: Uint8Array, callback: () => void) => {
        pendingWriteCallbacks.push(callback);
      },
    };
    const pipeline = createTerminalOutputPipeline({
      agentId: 'agent-1',
      canFlushOutput: () => true,
      channelId: 'channel-1',
      getOutputPriority: () => 'focused',
      hasObservedLocalInput: () => false,
      isDisposed: () => disposed,
      isSpawnFailed: () => false,
      markTerminalReady,
      onChunkRendered,
      onQueueEmpty,
      props: {
        agentId: 'agent-1',
        args: [],
        command: 'fixture',
        cwd: '/tmp',
        onData: vi.fn(),
        taskId: 'task-1',
      },
      taskId: 'task-1',
      term,
    });

    pipeline.enqueueOutput(encoder.encode('late output'));
    expect(pendingWriteCallbacks).toHaveLength(1);
    expect(getTerminalOutputDiagnosticsSnapshot().summary.activeWrites.total.count).toBe(1);

    disposed = true;
    pipeline.cleanup();
    pendingWriteCallbacks[0]?.();

    expect(pipeline.hasWriteInFlight()).toBe(false);
    expect(onChunkRendered).not.toHaveBeenCalled();
    expect(markTerminalReady).not.toHaveBeenCalled();
    expect(onQueueEmpty).not.toHaveBeenCalled();
    expect(getTerminalOutputDiagnosticsSnapshot().summary.activeWrites.total.count).toBe(0);
    expect(getTerminalOutputDiagnosticsSnapshot().summary.writeDurationMs.total.count).toBe(1);
  });

  it('builds recovery request state from rendered history plus queued local output', () => {
    const { pipeline } = createPipelineWithOptions('visible-background', {
      canFlushOutput: () => false,
    });

    pipeline.appendRenderedOutputHistory(encoder.encode('painted'));
    pipeline.setRenderedOutputCursor(7);
    pipeline.enqueueOutput(encoder.encode(' queued'));

    expect(pipeline.getRecoveryRequestState()).toEqual({
      outputCursor: 14,
      renderedTail: encoder.encode('painted queued'),
    });

    pipeline.cleanup();
  });

  it('caps recovery request state to the requested rendered tail bytes', () => {
    const { pipeline } = createPipelineWithOptions('visible-background', {
      canFlushOutput: () => false,
    });

    pipeline.appendRenderedOutputHistory(encoder.encode('painted-history'));
    pipeline.setRenderedOutputCursor(15);
    pipeline.enqueueOutput(encoder.encode('-queued-tail'));

    expect(pipeline.getRecoveryRequestState(11)).toEqual({
      outputCursor: 27,
      renderedTail: encoder.encode('queued-tail'),
    });

    pipeline.cleanup();
  });

  it('coalesces additive queued output behind an in-flight focused write', () => {
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('prompt> '));
    pipeline.enqueueOutput(encoder.encode('alpha'));
    pipeline.enqueueOutput(encoder.encode('beta'));

    expect(writes).toEqual(['prompt> ']);

    finishNextWrite();
    advanceQueuedOutputFlushTimers();

    expect(writes).toEqual(['prompt> ', 'alphabeta']);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('coalesces focused status payload updates while queued focused writes keep draining', () => {
    const { finishNextWrite, onData, pipeline } = createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(2_000)));
    vi.advanceTimersToNextTimer();
    pipeline.enqueueOutput(encoder.encode('y'.repeat(2_000)));

    finishNextWrite();
    expect(onData).not.toHaveBeenCalled();

    advanceQueuedOutputFlushTimers();
    finishNextWrite();
    expect(onData).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(24);

    expect(onData).toHaveBeenCalledTimes(1);
    pipeline.cleanup();
  });

  it('keeps recent interactive echo chunks split while the first focused write is in flight', () => {
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    pipeline.armInteractiveEchoFastPath();
    pipeline.enqueueOutput(encoder.encode('a'));
    pipeline.enqueueOutput(encoder.encode('b'));
    pipeline.enqueueOutput(encoder.encode('c'));

    expect(writes).toEqual(['a']);

    finishNextWrite();
    expect(writes).toEqual(['a', 'b']);

    finishNextWrite();
    expect(writes).toEqual(['a', 'b', 'c']);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('coalesces the tail of a long interactive echo burst after the initial split window', () => {
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    pipeline.armInteractiveEchoFastPath();
    for (const chunk of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      pipeline.enqueueOutput(encoder.encode(chunk));
    }

    expect(writes).toEqual(['a']);

    finishNextWrite();
    expect(writes).toEqual(['a', 'b']);

    finishNextWrite();
    expect(writes).toEqual(['a', 'b', 'c']);

    finishNextWrite();
    expect(writes).toEqual(['a', 'b', 'c', 'd']);

    finishNextWrite();
    expect(writes).toEqual(['a', 'b', 'c', 'd', 'efgh']);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('bounds write-call churn for long tiny focused echo bursts compared with the fully coalesced path', async () => {
    (
      globalThis.window as typeof globalThis.window & {
        __TERMINAL_OUTPUT_DIAGNOSTICS__?: boolean;
      }
    ).__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;

    const coalescedHarness = createPipelineWithManualWrites('focused');

    const coalescedReceiveTs = 1;
    coalescedHarness.pipeline.enqueueOutput(encoder.encode('a'), coalescedReceiveTs);
    for (const chunk of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      coalescedHarness.pipeline.enqueueOutput(encoder.encode(chunk), coalescedReceiveTs);
    }

    await vi.advanceTimersByTimeAsync(5);
    coalescedHarness.finishNextWrite();
    await vi.advanceTimersByTimeAsync(5);
    coalescedHarness.finishNextWrite();
    const coalescedSnapshot = getTerminalOutputDiagnosticsSnapshot();
    const coalescedTerminal = coalescedSnapshot.terminals.find(
      (entry) => entry.agentId === 'agent-1',
    );
    expect(coalescedTerminal?.writes.calls).toBe(2);
    expect(coalescedSnapshot.summary.queueAgeMs.bySource.queued.count).toBe(1);
    expect(coalescedSnapshot.summary.writeDurationMs.bySource.queued.count).toBe(1);
    expect(coalescedSnapshot.summary.writeDurationMs.total.count).toBe(2);
    coalescedHarness.pipeline.cleanup();

    resetTerminalOutputDiagnostics();

    const splitHarness = createPipelineWithManualWrites('focused');
    splitHarness.pipeline.armInteractiveEchoFastPath();
    const splitReceiveTs = 1;
    splitHarness.pipeline.enqueueOutput(encoder.encode('a'), splitReceiveTs);
    for (const chunk of ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      splitHarness.pipeline.enqueueOutput(encoder.encode(chunk), splitReceiveTs);
    }

    await vi.advanceTimersByTimeAsync(5);
    splitHarness.finishNextWrite();
    await vi.advanceTimersByTimeAsync(5);
    splitHarness.finishNextWrite();
    await vi.advanceTimersByTimeAsync(5);
    splitHarness.finishNextWrite();
    await vi.advanceTimersByTimeAsync(5);
    splitHarness.finishNextWrite();
    await vi.advanceTimersByTimeAsync(5);
    splitHarness.finishNextWrite();

    const splitSnapshot = getTerminalOutputDiagnosticsSnapshot();
    const splitTerminal = splitSnapshot.terminals.find((entry) => entry.agentId === 'agent-1');
    expect(splitTerminal?.writes.calls).toBe(5);
    expect(splitSnapshot.summary.queueAgeMs.bySource.queued.count).toBe(4);
    expect(splitSnapshot.summary.writeDurationMs.bySource.queued.count).toBe(4);
    expect(splitSnapshot.summary.writeDurationMs.total.count).toBe(5);
    expect(splitTerminal?.writes.calls ?? Number.POSITIVE_INFINITY).toBeLessThan(8);
    expect(splitTerminal?.writes.calls ?? 0).toBeGreaterThan(coalescedTerminal?.writes.calls ?? 0);
    expect(splitSnapshot.summary.queueAgeMs.bySource.queued.max).toBeGreaterThan(
      coalescedSnapshot.summary.queueAgeMs.bySource.queued.max,
    );
    splitHarness.pipeline.cleanup();
  });

  it('applies flow-control pause for sustained suppressed output while render hibernating', async () => {
    const { pipeline } = createPipeline('hidden');

    pipeline.setRenderHibernating(true);
    pipeline.enqueueOutput(encoder.encode('x'.repeat(FLOW_HIGH + 1024)));
    await Promise.resolve();

    expectFlowControlPauseRequest();

    pipeline.setRenderHibernating(false);
    await Promise.resolve();

    expectFlowControlResumeRequest();
    pipeline.cleanup();
  });

  it('renews flow-control pauses while renderer backpressure remains high', async () => {
    const { pipeline } = createPipeline('hidden');

    pipeline.setRenderHibernating(true);
    pipeline.enqueueOutput(encoder.encode('x'.repeat(FLOW_HIGH + 1024)));
    await Promise.resolve();
    vi.mocked(invoke).mockClear();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.PauseAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });

    vi.mocked(invoke).mockClear();
    pipeline.setRenderHibernating(false);
    await Promise.resolve();

    expectFlowControlResumeRequest();

    vi.mocked(invoke).mockClear();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(IPC.PauseAgent, expect.anything());
    pipeline.cleanup();
  });

  it('releases an active flow-control pause during cleanup', async () => {
    const { pipeline } = createPipeline('hidden');

    pipeline.setRenderHibernating(true);
    pipeline.enqueueOutput(encoder.encode('x'.repeat(FLOW_HIGH + 1024)));
    await Promise.resolve();
    vi.mocked(invoke).mockClear();

    pipeline.cleanup();

    expectFlowControlResumeRequest();
  });

  it('releases a flow-control pause that resolves after cleanup', async () => {
    let resolvePause: () => void = () => undefined;
    const pauseRequest = new Promise<void>((resolve) => {
      resolvePause = resolve;
    });
    vi.mocked(invoke).mockImplementation((channel) => {
      if (channel === IPC.PauseAgent) {
        return pauseRequest as ReturnType<typeof invoke>;
      }

      return Promise.resolve(undefined) as ReturnType<typeof invoke>;
    });
    const { pipeline } = createPipeline('hidden');

    pipeline.setRenderHibernating(true);
    pipeline.enqueueOutput(encoder.encode('x'.repeat(FLOW_HIGH + 1024)));
    await Promise.resolve();
    pipeline.cleanup();

    expectFlowControlResumeRequest();

    vi.mocked(invoke).mockClear();
    resolvePause();
    await Promise.resolve();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
  });

  it('clears the focused-input echo reservation on focused output when no traced echo is pending', () => {
    const { pipeline } = createPipeline();

    noteTerminalFocusedInput('task-1', 'agent-1');
    expect(isTerminalFocusedInputEchoReservationActive('task-1', 'agent-1')).toBe(true);

    pipeline.enqueueOutput(encoder.encode('prompt> ok'));

    expect(isTerminalFocusedInputActive('task-1', 'agent-1')).toBe(true);
    expect(isTerminalFocusedInputEchoReservationActive('task-1', 'agent-1')).toBe(false);
    pipeline.cleanup();
  });

  it('completes the post-input-ready echo grace on the first focused write', () => {
    const { pipeline, writes } = createPipeline();

    beginTerminalSwitchEchoGrace('task-1', 120);
    activateTerminalSwitchEchoGrace('task-1');
    pipeline.enqueueOutput(encoder.encode('prompt> ok'));

    expect(writes).toEqual(['prompt> ok']);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );

    pipeline.cleanup();
  });

  it('applies a one-shot focused queued-write cap while the post-input-ready echo grace is active', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: {
        '1': 8 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(1);
    const { finishNextWrite, markLocalInputObserved, pipeline, writes } =
      createPipelineWithManualWrites('focused');

    markLocalInputObserved();
    beginTerminalSwitchEchoGrace('task-1', 120);
    activateTerminalSwitchEchoGrace('task-1');
    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(8 * 1024);

    finishNextWrite();
    advanceQueuedOutputFlushTimers();

    expect(writes[1]?.length).toBe(40_000 - 8 * 1024);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        lastCompletion: expect.objectContaining({
          reason: 'completed',
          taskId: 'task-1',
        }),
      }),
    );

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('does not apply the focused queued-write cap before the post-input-ready echo grace activates', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: {
        '1': 8 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(1);
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    beginTerminalSwitchEchoGrace('task-1', 120);
    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes[0]?.length).toBe(40_000);
    expect(getTerminalSwitchEchoGraceSnapshot()).toEqual(
      expect.objectContaining({
        active: false,
        targetTaskId: 'task-1',
      }),
    );

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('coalesces focused redraw-control bursts before flushing them', () => {
    const { pipeline, writes } = createPipeline();
    const segments = [
      '\x1b[s',
      '\x1b[20;1H',
      '\x1b[2K',
      ' scan 001/096',
      '\x1b[21;1H',
      '\x1b[2K',
      ' waiting for pacing',
      '\x1b[u',
    ];

    for (const segment of segments) {
      pipeline.enqueueOutput(encoder.encode(segment));
      vi.advanceTimersByTime(1);
    }

    expect(writes).toEqual([]);

    vi.advanceTimersByTime(16);
    vi.runOnlyPendingTimers();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(segments.join(''));
    pipeline.cleanup();
  });

  it('coalesces a visible sibling burst into one queued write before flushing', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    const visibleRegistrations = registerVisibleTerminals(4);
    const { pipeline, writes } = createPipeline('visible-background');
    setTerminalFramePressureLevelForTests('elevated');

    pipeline.enqueueOutput(encoder.encode('alpha'));
    vi.advanceTimersByTime(1);
    pipeline.enqueueOutput(encoder.encode('beta'));
    vi.advanceTimersByTime(1);
    pipeline.enqueueOutput(encoder.encode('gamma'));

    expect(writes).toEqual([]);

    vi.advanceTimersByTime(5);
    vi.runOnlyPendingTimers();

    expect(writes).toEqual(['alphabetagamma']);
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('flushes a pending visible sibling burst immediately when it becomes focused', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    const { pipeline, setPriority, writes } = createPipeline('visible-background');
    setTerminalFramePressureLevelForTests('elevated');

    pipeline.enqueueOutput(encoder.encode('alpha'));
    pipeline.enqueueOutput(encoder.encode('beta'));

    expect(writes).toEqual([]);

    setPriority('focused');
    pipeline.updateOutputPriority();
    vi.runOnlyPendingTimers();

    expect(writes).toEqual(['alphabeta']);
    pipeline.cleanup();
  });

  it('coalesces redraw-control bursts when ANSI sequences are split across chunks', () => {
    const { pipeline, writes } = createPipeline();
    const segments = ['\x1b', '[s', '\x1b', '[20;1H', '\x1b', '[2K', ' scan 001/096', '\x1b', '[u'];

    for (const segment of segments) {
      pipeline.enqueueOutput(encoder.encode(segment));
      vi.advanceTimersByTime(1);
    }

    expect(writes).toEqual([]);

    vi.advanceTimersByTime(16);
    vi.runOnlyPendingTimers();

    expect(writes).toEqual([segments.join('')]);
    pipeline.cleanup();
  });

  it('releases redraw bursts immediately when the terminal is no longer focused', () => {
    const { pipeline, setPriority, writes } = createPipeline();

    pipeline.enqueueOutput(encoder.encode('\x1b[s'));
    pipeline.enqueueOutput(encoder.encode('\x1b[20;1H'));
    setPriority('active-visible');
    pipeline.updateOutputPriority();
    vi.runOnlyPendingTimers();

    expect(writes).toEqual(['\x1b[s\x1b[20;1H']);
    pipeline.cleanup();
  });

  it('flushes split redraw bursts immediately when focus drops before the coalescing window elapses', () => {
    const { pipeline, setPriority, writes } = createPipeline();
    const segments = ['\x1b', '[s', '\x1b', '[20;1H', '\x1b', '[2K', ' scan 001/096', '\x1b', '[u'];

    for (const segment of segments) {
      pipeline.enqueueOutput(encoder.encode(segment));
      vi.advanceTimersByTime(1);
    }

    expect(writes).toEqual([]);

    setPriority('active-visible');
    pipeline.updateOutputPriority();
    vi.runOnlyPendingTimers();

    expect(writes).toEqual([segments.join('')]);
    pipeline.cleanup();
  });

  it('returns to the direct-write path after a redraw burst flushes', () => {
    const { pipeline, writes } = createPipeline();

    pipeline.enqueueOutput(encoder.encode('\x1b[s'));
    pipeline.enqueueOutput(encoder.encode('\x1b[20;1H'));
    vi.advanceTimersByTime(16);
    vi.runOnlyPendingTimers();

    pipeline.enqueueOutput(encoder.encode('prompt> '));

    expect(writes).toEqual(['\x1b[s\x1b[20;1H', 'prompt> ']);
    pipeline.cleanup();
  });

  it('resets redraw tracking when queued output is dropped for recovery', () => {
    const { pipeline, writes } = createPipeline();

    pipeline.enqueueOutput(encoder.encode('\x1b'));
    pipeline.enqueueOutput(encoder.encode('[20;1H'));
    pipeline.dropQueuedOutputForRecovery();

    pipeline.enqueueOutput(encoder.encode('restored prompt> '));

    expect(writes).toEqual(['restored prompt> ']);
    pipeline.cleanup();
  });

  it('resumes flow control after recovery drops a paused queued backlog', async () => {
    const { pipeline } = createPipelineWithOptions('visible-background', {
      canFlushOutput: () => false,
    });

    pipeline.enqueueOutput(encoder.encode('x'.repeat(FLOW_HIGH + 1024)));
    await Promise.resolve();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.PauseAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });

    vi.mocked(invoke).mockClear();
    pipeline.dropQueuedOutputForRecovery();
    await Promise.resolve();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
    pipeline.cleanup();
  });

  it('resumes flow control when entering render hibernation with a paused queued backlog', async () => {
    const { pipeline } = createPipelineWithOptions('hidden', {
      canFlushOutput: () => false,
    });

    pipeline.enqueueOutput(encoder.encode('x'.repeat(FLOW_HIGH + 1024)));
    await Promise.resolve();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.PauseAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });

    vi.mocked(invoke).mockClear();
    pipeline.setRenderHibernating(true);
    await Promise.resolve();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.ResumeAgent, {
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'flow-control',
    });
    pipeline.cleanup();
  });

  it('preserves bytes for split non-redraw ANSI output', () => {
    const { pipeline, writes } = createPipeline();
    const segments = ['\x1b[', '31mcolored output', '\x1b[0m'];

    for (const segment of segments) {
      pipeline.enqueueOutput(encoder.encode(segment));
      vi.advanceTimersByTime(1);
    }

    vi.advanceTimersByTime(16);
    vi.runOnlyPendingTimers();

    expect(writes.join('')).toBe(segments.join(''));
    pipeline.cleanup();
  });

  it('does not apply a second redraw coalescing delay after queued output starts draining', () => {
    const { finishNextWrite, getPendingWriteCount, pipeline, writes } =
      createPipelineWithManualWrites();

    pipeline.enqueueOutput(encoder.encode('\x1b[s'));
    pipeline.enqueueOutput(encoder.encode('x'.repeat(120_000)));

    advanceQueuedOutputFlushTimers();

    expect(writes).toHaveLength(1);
    expect(getPendingWriteCount()).toBe(1);

    finishNextWrite();
    vi.advanceTimersToNextTimer();

    expect(writes).toHaveLength(2);
    pipeline.cleanup();
  });

  it('suppresses hidden live terminal writes while hibernating', () => {
    const { onData, pipeline, writes } = createPipeline('hidden');

    pipeline.setRenderHibernating(true);
    pipeline.enqueueOutput(encoder.encode('hidden background output'));

    expect(writes).toEqual([]);
    expect(pipeline.hasSuppressedOutputSinceHibernation()).toBe(true);
    expect(onData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_200);

    expect(onData).toHaveBeenCalledTimes(1);

    pipeline.setRenderHibernating(false);
    expect(pipeline.hasSuppressedOutputSinceHibernation()).toBe(false);
    pipeline.enqueueOutput(encoder.encode('visible again'));
    vi.advanceTimersByTime(48);

    expect(writes).toEqual(['visible again']);
    pipeline.cleanup();
  });

  it('shapes queued writes when a write-batch experiment limit is active', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      writeBatchLimitOverrides: {
        focused: 16 * 1024,
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const { finishNextWrite, getPendingWriteCount, pipeline, writes } =
      createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes[0]?.length).toBe(16 * 1024);
    expect(getPendingWriteCount()).toBe(1);

    finishNextWrite();
    advanceQueuedOutputFlushTimers();

    expect(writes[1]?.length).toBe(16 * 1024);

    pipeline.cleanup();
  });

  it('uses visibility-aware write shaping when many terminals are visible', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareWriteBatchLimitOverrides: {
        dense: {
          focused: 12 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(5);
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes[0]?.length).toBe(12 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('prefers exact visible-count write shaping when one terminal is visible', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibleCountWriteBatchLimitOverrides: {
        '1': {
          focused: 20 * 1024,
        },
      },
      visibilityAwareWriteBatchLimitOverrides: {
        single: {
          focused: 12 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(1);
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes[0]?.length).toBe(20 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('briefly coalesces large focused bursts from idle before the first queued drain', async () => {
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');
    const burstChunk = encoder.encode('x'.repeat(20_000));

    pipeline.enqueueOutput(burstChunk, 1);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(8);
    pipeline.enqueueOutput(burstChunk, 1);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(8);
    vi.advanceTimersToNextTimer();
    expect(writes[0]?.length).toBe(40_000);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('does not start a second focused queued write while the first write is still in flight', () => {
    const { finishNextWrite, getPendingWriteCount, pipeline, writes } =
      createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(140_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes).toHaveLength(1);
    expect(getPendingWriteCount()).toBe(1);

    vi.runOnlyPendingTimers();

    expect(writes).toHaveLength(1);
    expect(getPendingWriteCount()).toBe(1);

    finishNextWrite();
    advanceQueuedOutputFlushTimers();

    expect(writes).toHaveLength(2);
    pipeline.cleanup();
  });

  it('caps focused pre-input queued writes below the steady-state focused drain budget', () => {
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(140_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes[0]?.length).toBe(64 * 1024);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('keeps the focused pre-input write cap active while switch echo grace is still pending', () => {
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    beginTerminalSwitchEchoGrace('task-1', 120);
    pipeline.enqueueOutput(encoder.encode('x'.repeat(140_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes[0]?.length).toBe(64 * 1024);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('stops applying the focused pre-input write cap after the initial focused queue drain completes', () => {
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(140_000)));
    advanceQueuedOutputFlushTimers();
    expect(writes[0]?.length).toBe(64 * 1024);

    finishNextWrite();
    advanceQueuedOutputFlushTimers();
    finishNextWrite();
    advanceQueuedOutputFlushTimers();
    finishNextWrite();

    pipeline.enqueueOutput(encoder.encode('y'.repeat(140_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes.at(-1)?.length).toBe(96 * 1024);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('stops applying the focused pre-input write cap after local input is observed', () => {
    const { finishNextWrite, markLocalInputObserved, pipeline, writes } =
      createPipelineWithManualWrites('focused');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(140_000)));
    advanceQueuedOutputFlushTimers();
    expect(writes[0]?.length).toBe(64 * 1024);

    finishNextWrite();
    advanceQueuedOutputFlushTimers();
    finishNextWrite();
    advanceQueuedOutputFlushTimers();
    finishNextWrite();

    markLocalInputObserved();
    pipeline.enqueueOutput(encoder.encode('y'.repeat(140_000)));
    advanceQueuedOutputFlushTimers();

    expect(writes.at(-1)?.length).toBe(96 * 1024);

    finishNextWrite();
    pipeline.cleanup();
  });

  it('prefers exact visible-count write shaping when two terminals are visible', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibleCountWriteBatchLimitOverrides: {
        '2': {
          'visible-background': 6 * 1024,
        },
      },
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          'visible-background': 8 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();

    const visibleRegistrations = registerVisibleTerminals(2);
    const { finishNextWrite, pipeline, writes } =
      createPipelineWithManualWrites('visible-background');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(6 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('uses visibility-aware write shaping for switch-target-visible terminals when few terminals are visible', () => {
    expectFewVisibleWriteShape('switch-target-visible', 20 * 1024);
  });

  it('uses visibility-aware write shaping for active-visible terminals when few terminals are visible', () => {
    expectFewVisibleWriteShape('active-visible', 10 * 1024);
  });

  it('uses visibility-aware write shaping for visible-background terminals when few terminals are visible', () => {
    expectFewVisibleWriteShape('visible-background', 8 * 1024);
  });

  it('uses the smaller scheduler slice budget before the local write-batch cap', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          'active-visible': 20 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const visibleRegistrations = registerVisibleTerminals(4);
    const { finishNextWrite, pipeline, writes } = createPipelineWithManualWrites('active-visible');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    const drainedBytes = pipeline.flushOutputQueueSlice(6 * 1024);

    expect(drainedBytes).toBe(6 * 1024);
    expect(writes[0]?.length).toBe(6 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('scales a visible-background write cap only when dense frame pressure is active', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureWriteBatchLimitScales: {
        'visible-background': {
          critical: 0.25,
        },
      },
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          'visible-background': 8 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const visibleRegistrations = registerVisibleTerminals(4);
    const { finishNextWrite, pipeline, writes } =
      createPipelineWithManualWrites('visible-background');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(8 * 1024);

    finishNextWrite();
    pipeline.cleanup();

    setTerminalFramePressureLevelForTests('critical');
    const pressuredHarness = createPipelineWithManualWrites('visible-background');

    pressuredHarness.pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(pressuredHarness.writes[0]?.length).toBe(2 * 1024);

    pressuredHarness.finishNextWrite();
    pressuredHarness.pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('applies pressure scaling after selecting an exact four-visible write cap', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureWriteBatchLimitScales: {
        'visible-background': {
          critical: 0.25,
        },
      },
      visibilityAwareWriteBatchLimitOverrides: {
        few: {
          'visible-background': 10 * 1024,
        },
      },
      visibleCountWriteBatchLimitOverrides: {
        '4': {
          'visible-background': 8 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    const { finishNextWrite, pipeline, writes } =
      createPipelineWithManualWrites('visible-background');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(2 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('does not apply dense pressure scaling to one-visible write shaping', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureWriteBatchLimitScales: {
        'visible-background': {
          critical: 0.25,
        },
      },
      visibleCountWriteBatchLimitOverrides: {
        '1': {
          'visible-background': 8 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(1);
    const { finishNextWrite, pipeline, writes } =
      createPipelineWithManualWrites('visible-background');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(8 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('scales a finite scheduler slice when dense frame pressure is active without a local write cap', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureWriteBatchLimitScales: {
        'visible-background': {
          critical: 0.25,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    const { finishNextWrite, pipeline, writes } =
      createPipelineWithManualWrites('visible-background');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    const drainedBytes = pipeline.flushOutputQueueSlice(8 * 1024);

    expect(drainedBytes).toBe(2 * 1024);
    expect(writes[0]?.length).toBe(2 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('applies dense-overload write shaping only when dense pressure is active', () => {
    window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
      denseOverloadVisibleCountWriteBatchLimitOverrides: {
        '4': {
          'visible-background': 8 * 1024,
        },
      },
    };
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const visibleRegistrations = registerVisibleTerminals(4);
    const baselineHarness = createPipelineWithManualWrites('visible-background');

    baselineHarness.pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    baselineHarness.pipeline.flushOutputQueueSlice(16 * 1024);

    expect(baselineHarness.writes[0]?.length).toBe(16 * 1024);

    baselineHarness.finishNextWrite();
    baselineHarness.pipeline.cleanup();

    setTerminalFramePressureLevelForTests('critical');
    const denseOverloadHarness = createPipelineWithManualWrites('visible-background');

    denseOverloadHarness.pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    denseOverloadHarness.pipeline.flushOutputQueueSlice(16 * 1024);

    expect(denseOverloadHarness.writes[0]?.length).toBe(8 * 1024);

    denseOverloadHarness.finishNextWrite();
    denseOverloadHarness.pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('uses the built-in high load mode write shaping when enabled at four visible terminals', () => {
    Reflect.deleteProperty(window, '__PARALLEL_CODE_TERMINAL_EXPERIMENTS__');
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(4);
    const { finishNextWrite, pipeline, writes } =
      createPipelineWithManualWrites('visible-background');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    pipeline.flushOutputQueueSlice(16 * 1024);

    expect(writes[0]?.length).toBe(1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('uses the built-in high load mode sparse switch echo cap', () => {
    Reflect.deleteProperty(window, '__PARALLEL_CODE_TERMINAL_EXPERIMENTS__');
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);

    const visibleRegistrations = registerVisibleTerminals(2);
    const { finishNextWrite, markLocalInputObserved, pipeline, writes } =
      createPipelineWithManualWrites('focused');

    markLocalInputObserved();
    beginTerminalSwitchEchoGrace('task-1', 180);
    activateTerminalSwitchEchoGrace('task-1');
    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(8 * 1024);

    finishNextWrite();
    advanceQueuedOutputFlushTimers();

    expect(writes[1]?.length).toBe(40_000 - 8 * 1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });

  it('scales visible background writes under built-in high load pressure at two visible terminals', () => {
    Reflect.deleteProperty(window, '__PARALLEL_CODE_TERMINAL_EXPERIMENTS__');
    resetTerminalPerformanceExperimentConfigForTests();
    setTerminalHighLoadModeForTest(true);
    setTerminalFramePressureLevelForTests('critical');

    const visibleRegistrations = registerVisibleTerminals(2);
    const { finishNextWrite, pipeline, writes } =
      createPipelineWithManualWrites('visible-background');

    pipeline.enqueueOutput(encoder.encode('x'.repeat(40_000)));
    vi.advanceTimersToNextTimer();

    expect(writes[0]?.length).toBe(1024);

    finishNextWrite();
    pipeline.cleanup();
    unregisterVisibleTerminals(visibleRegistrations);
  });
});
