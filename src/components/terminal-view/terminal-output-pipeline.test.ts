import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/ipc', () => ({
  invoke: vi.fn(),
}));

import { resetTerminalOutputSchedulerForTests } from '../../app/terminal-output-scheduler';
import type { TerminalOutputPriority } from '../../lib/terminal-output-priority';
import {
  createTerminalOutputPipeline,
  type TerminalOutputPipeline,
} from './terminal-output-pipeline';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type TestTerminalOutputPriority = Extract<TerminalOutputPriority, 'focused' | 'active-visible'>;

interface TestPipelineHarness {
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

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => setTimeout(() => callback(16), 0)),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)),
    );
    resetTerminalOutputSchedulerForTests();
  });

  afterEach(() => {
    resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Reflect.deleteProperty(globalThis, 'window');
  });

  function createPipeline(priority: TestTerminalOutputPriority = 'focused'): TestPipelineHarness {
    const writes: string[] = [];
    let currentPriority = priority;
    const term = {
      write: (chunk: Uint8Array, callback: () => void) => {
        writes.push(decoder.decode(chunk));
        callback();
      },
    };

    const pipeline = createTerminalOutputPipeline({
      agentId: 'agent-1',
      canFlushOutput: () => true,
      channelId: 'channel-1',
      getOutputPriority: () => currentPriority,
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
        taskId: 'task-1',
      },
      taskId: 'task-1',
      term,
    });

    return {
      pipeline,
      setPriority: (nextPriority: typeof currentPriority) => {
        currentPriority = nextPriority;
      },
      writes,
    };
  }

  function createPipelineWithManualWrites(
    priority: TestTerminalOutputPriority = 'focused',
  ): ManualWritePipelineHarness {
    const writes: string[] = [];
    const pendingWriteCallbacks: Array<() => void> = [];
    let currentPriority = priority;
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
      getPendingWriteCount: () => pendingWriteCallbacks.length,
      pipeline,
      setPriority: (nextPriority: typeof currentPriority) => {
        currentPriority = nextPriority;
      },
      writes,
    };
  }

  it('keeps plain focused output on the direct-write path', () => {
    const { pipeline, writes } = createPipeline();

    pipeline.enqueueOutput(encoder.encode('plain shell output'));

    expect(writes).toEqual(['plain shell output']);
    pipeline.cleanup();
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

    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();

    expect(writes).toHaveLength(1);
    expect(getPendingWriteCount()).toBe(1);

    finishNextWrite();
    vi.advanceTimersToNextTimer();

    expect(writes).toHaveLength(2);
    pipeline.cleanup();
  });
});
