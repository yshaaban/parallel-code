import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import type { RemoteAgent, RemoteTerminalStreamEvent } from '../../electron/remote/protocol';
import type { TerminalRecoveryBatchEntry, TerminalRecoveryPayload } from '../ipc/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteDetailState = vi.hoisted(() => ({
  agentReads: 0,
  clearSpy: vi.fn(),
  emitOutput: null as null | ((agentId: string, data: string) => void),
  emitRecovery: null as null | ((entry: TerminalRecoveryBatchEntry) => void),
  emitScrollback: null as null | ((agentId: string, data: string, cols: number) => void),
  emitTerminalStream: null as null | ((agentId: string, event: RemoteTerminalStreamEvent) => void),
  fitSpy: vi.fn(),
  refreshSpy: vi.fn(),
  resetSpy: vi.fn(),
  scrollToBottomSpy: vi.fn(),
  setAgents: null as null | ((agents: RemoteAgent[]) => void),
  writeSpy: vi.fn(),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      remoteDetailState.fitSpy();
    }
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    buffer = { active: { baseY: 0, viewportY: 0 } };
    cols = 80;
    rows = 24;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    clear(): void {
      remoteDetailState.clearSpy();
    }
    dispose(): void {}
    loadAddon(): void {}
    onData(): { dispose(): void } {
      return { dispose() {} };
    }
    onScroll(): { dispose(): void } {
      return { dispose() {} };
    }
    open(): void {}
    refresh(start: number, end: number): void {
      remoteDetailState.refreshSpy(start, end);
    }
    reset(): void {
      remoteDetailState.resetSpy();
    }
    resize(cols?: number): void {
      if (cols !== undefined) {
        this.cols = cols;
      }
    }
    scrollToBottom(): void {
      remoteDetailState.scrollToBottomSpy();
    }
    write(_data: unknown, callback?: () => void): void {
      remoteDetailState.writeSpy(_data);
      callback?.();
    }
  },
}));

vi.mock('./touch-gestures', () => ({
  attachAgentDetailTouchGestures: vi.fn(() => () => {}),
}));

vi.mock('./remote-collaboration', () => ({
  getRemoteTaskControllerOwnerStatus: vi.fn(() => null),
  getRemoteTaskOwnerStatus: vi.fn(() => null),
}));

vi.mock('./remote-task-command', () => ({
  releaseRemoteTaskCommand: vi.fn(async () => {}),
  requestRemoteTaskTakeover: vi.fn(async () => 'acquired'),
  sendRemoteAgentInput: vi.fn(async () => true),
  sendRemoteAgentResize: vi.fn(),
}));

vi.mock('./ws', async () => {
  const solid = await import('solid-js');
  const [agentsSignal, setAgentsSignal] = solid.createSignal<RemoteAgent[]>([]);
  const outputListeners = new Map<string, Set<(data: string) => void>>();
  const scrollbackListeners = new Map<string, Set<(data: string, cols: number) => void>>();
  const terminalRecoveryListeners = new Set<
    (entry: Parameters<NonNullable<typeof remoteDetailState.emitRecovery>>[0]) => void
  >();
  const terminalStreamListeners = new Map<
    string,
    Set<(event: RemoteTerminalStreamEvent) => void>
  >();

  remoteDetailState.setAgents = setAgentsSignal;
  remoteDetailState.emitOutput = (agentId: string, data: string) => {
    outputListeners.get(agentId)?.forEach((listener) => listener(data));
  };
  remoteDetailState.emitRecovery = (entry) => {
    terminalRecoveryListeners.forEach((listener) => listener(entry));
  };
  remoteDetailState.emitScrollback = (agentId: string, data: string, cols: number) => {
    scrollbackListeners.get(agentId)?.forEach((listener) => listener(data, cols));
  };
  remoteDetailState.emitTerminalStream = (agentId: string, event: RemoteTerminalStreamEvent) => {
    if (event.type === 'Data') {
      outputListeners.get(agentId)?.forEach((listener) => listener(event.data));
    }
    terminalStreamListeners.get(agentId)?.forEach((listener) => listener(event));
  };
  const readAgents = (): RemoteAgent[] => {
    remoteDetailState.agentReads += 1;
    return agentsSignal();
  };

  return {
    agents: readAgents,
    getAgentLastActivityAt: vi.fn(() => null),
    getAgentPreview: vi.fn(() => ''),
    onOutput: vi.fn((agentId: string, listener: (data: string) => void) => {
      let listeners = outputListeners.get(agentId);
      if (!listeners) {
        listeners = new Set();
        outputListeners.set(agentId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
      };
    }),
    onScrollback: vi.fn((agentId: string, listener: (data: string, cols: number) => void) => {
      let listeners = scrollbackListeners.get(agentId);
      if (!listeners) {
        listeners = new Set();
        scrollbackListeners.set(agentId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
      };
    }),
    onTerminalRecoveryResult: vi.fn(
      (
        listener: (
          entry: Parameters<NonNullable<typeof remoteDetailState.emitRecovery>>[0],
        ) => void,
      ) => {
        terminalRecoveryListeners.add(listener);
        return () => {
          terminalRecoveryListeners.delete(listener);
        };
      },
    ),
    onTerminalStream: vi.fn(
      (agentId: string, listener: (event: RemoteTerminalStreamEvent) => void) => {
        let listeners = terminalStreamListeners.get(agentId);
        if (!listeners) {
          listeners = new Set();
          terminalStreamListeners.set(agentId, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners?.delete(listener);
        };
      },
    ),
    requestRemoteTerminalRecovery: vi.fn(() => true),
    requestRemoteTerminalStartupRecovery: vi.fn(() => true),
    sendKill: vi.fn(),
    status: vi.fn(() => 'connected'),
    subscribeAgent: vi.fn(),
    subscribeRemoteConnectionStatus: vi.fn((listener: (status: 'connected') => void) => {
      listener('connected');
      return () => {};
    }),
    unsubscribeAgent: vi.fn(),
  };
});

import { AgentDetail } from './AgentDetail';
import {
  getRemoteTaskControllerOwnerStatus,
  getRemoteTaskOwnerStatus,
} from './remote-collaboration';
import {
  requestRemoteTaskTakeover,
  sendRemoteAgentInput,
  sendRemoteAgentResize,
} from './remote-task-command';
import {
  requestRemoteTerminalRecovery,
  requestRemoteTerminalStartupRecovery,
  subscribeAgent,
} from './ws';

function createAgent(overrides: Partial<RemoteAgent> = {}): RemoteAgent {
  return {
    agentId: 'agent-1',
    exitCode: null,
    lastLine: 'ready',
    status: 'running',
    taskId: 'task-1',
    taskMeta: undefined,
    taskName: 'Hydra Main Agent',
    ...overrides,
  };
}

function encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeBytes(bytes: unknown): string {
  if (!(bytes instanceof Uint8Array)) {
    return '';
  }

  return Buffer.from(bytes).toString('utf8');
}

function emitRecoveryEntry(options: {
  outputCursor?: number;
  recovery: TerminalRecoveryPayload;
  requestId: string;
}): void {
  remoteDetailState.emitRecovery?.({
    agentId: 'agent-1',
    cols: 100,
    outputCursor: options.outputCursor ?? 0,
    recovery: options.recovery,
    requestId: options.requestId,
    rows: 30,
  });
}

function emitNoopRecovery(requestId: string, outputCursor = 0): void {
  emitRecoveryEntry({
    outputCursor,
    recovery: { kind: 'noop' },
    requestId,
  });
}

function emitTerminalStateRecovery(requestId: string): void {
  const bytes = Buffer.from('\x1b[Hrestored prompt', 'utf8');
  emitRecoveryEntry({
    outputCursor: bytes.length,
    recovery: {
      data: bytes.toString('base64'),
      kind: 'terminal-state',
    },
    requestId,
  });
}

function emitStructuredData(text: string): void {
  remoteDetailState.emitTerminalStream?.('agent-1', {
    data: encodeText(text),
    type: 'Data',
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

function useFakeTimersWithImmediateAnimationFrames(): void {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

describe('AgentDetail', () => {
  beforeEach(() => {
    remoteDetailState.agentReads = 0;
    remoteDetailState.clearSpy.mockReset();
    remoteDetailState.fitSpy.mockReset();
    remoteDetailState.refreshSpy.mockReset();
    remoteDetailState.resetSpy.mockReset();
    remoteDetailState.scrollToBottomSpy.mockReset();
    remoteDetailState.writeSpy.mockReset();
    vi.mocked(getRemoteTaskControllerOwnerStatus).mockReturnValue(null);
    vi.mocked(getRemoteTaskOwnerStatus).mockReturnValue(null);
    vi.mocked(requestRemoteTaskTakeover).mockResolvedValue('acquired');
    vi.mocked(sendRemoteAgentInput).mockResolvedValue(true);
    vi.mocked(sendRemoteAgentResize).mockClear();
    vi.mocked(requestRemoteTerminalRecovery).mockClear();
    vi.mocked(requestRemoteTerminalStartupRecovery).mockClear();
    vi.mocked(subscribeAgent).mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    remoteDetailState.setAgents?.([createAgent()]);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the missing-agent dialog when an already-loaded agent disappears later', async () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    expect(screen.queryByText('Interactive')).toBeNull();
    expect(screen.queryByText('Read only')).toBeNull();

    remoteDetailState.emitScrollback?.(
      'agent-1',
      Buffer.from('ready\n', 'utf8').toString('base64'),
      80,
    );
    remoteDetailState.setAgents?.([]);

    await waitFor(() => {
      expect(screen.getByRole('alertdialog', { name: 'Agent not found' })).toBeDefined();
    });
  });

  it('derives selected agent detail from one selected-agent lookup per snapshot', () => {
    remoteDetailState.setAgents?.([
      createAgent({ agentId: 'agent-other-1', taskName: 'Other Agent 1' }),
      createAgent({
        agentId: 'agent-1',
        taskMeta: {
          agentDefId: null,
          agentDefName: null,
          branchName: 'feature/remote-detail',
          directMode: false,
          folderName: 'parallel-code',
          lastPrompt: null,
          worktreeOwnership: 'managed',
        },
        taskName: 'Selected Remote Agent',
      }),
      createAgent({ agentId: 'agent-other-2', taskName: 'Other Agent 2' }),
    ]);
    remoteDetailState.agentReads = 0;

    render(() => <AgentDetail agentId="agent-1" taskName="Fallback Agent" onBack={vi.fn()} />);

    expect(screen.getByText('Selected Remote Agent')).toBeDefined();
    expect(screen.queryByText('Other Agent 1')).toBeNull();
    expect(screen.queryByText('Fallback Agent')).toBeNull();
    expect(remoteDetailState.agentReads).toBe(1);
  });

  it('re-fits and refreshes the terminal after font size changes', async () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const fitCallsBefore = remoteDetailState.fitSpy.mock.calls.length;
    const refreshCallsBefore = remoteDetailState.refreshSpy.mock.calls.length;

    screen.getByRole('button', { name: 'Increase terminal font size' }).click();

    await waitFor(() => {
      expect(remoteDetailState.fitSpy.mock.calls.length).toBeGreaterThan(fitCallsBefore);
      expect(remoteDetailState.refreshSpy.mock.calls.length).toBeGreaterThan(refreshCallsBefore);
    });
  });

  it('subscribes the mobile terminal through the structured terminal stream', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    expect(subscribeAgent).toHaveBeenCalledWith('agent-1', { terminalProtocol: 'structured' });
  });

  it('applies structured terminal-state recovery to the mobile terminal', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    expect(startupRequest).toEqual(
      expect.objectContaining({
        agentId: 'agent-1',
        role: 'selected',
        visibleTerminalCount: 1,
      }),
    );

    emitTerminalStateRecovery(startupRequest?.requestId ?? 'missing-request');

    expect(remoteDetailState.resetSpy).toHaveBeenCalled();
    expect(remoteDetailState.writeSpy).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(remoteDetailState.scrollToBottomSpy).toHaveBeenCalled();
  });

  it('applies valid recovery that arrives after the watchdog timeout', () => {
    useFakeTimersWithImmediateAnimationFrames();

    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitStructuredData('buffered while recovering');
    vi.advanceTimersByTime(5_000);

    expect(remoteDetailState.resetSpy).not.toHaveBeenCalled();
    expect(remoteDetailState.writeSpy).not.toHaveBeenCalled();
    expect(requestRemoteTerminalStartupRecovery).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        requestId: startupRequest?.requestId,
      }),
    );

    emitTerminalStateRecovery(startupRequest?.requestId ?? 'missing-request');

    expect(remoteDetailState.resetSpy).toHaveBeenCalled();
    expect(remoteDetailState.writeSpy).toHaveBeenCalledWith(expect.any(Uint8Array));
  }, 10_000);

  it('ignores stale structured recovery results for superseded mobile requests', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });
    const liveRequest = vi.mocked(requestRemoteTerminalRecovery).mock.calls[0]?.[0];

    emitTerminalStateRecovery(startupRequest?.requestId ?? 'missing-startup-request');

    expect(remoteDetailState.resetSpy).not.toHaveBeenCalled();

    emitTerminalStateRecovery(liveRequest?.requestId ?? 'missing-live-request');

    expect(remoteDetailState.resetSpy).toHaveBeenCalledTimes(1);
  });

  it('requests live recovery with cursor and rendered tail after structured data', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitNoopRecovery(startupRequest?.requestId ?? 'missing-startup-request');

    emitStructuredData('first output');
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });

    expect(requestRemoteTerminalRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        outputCursor: Buffer.byteLength('first output', 'utf8'),
        renderedTail: encodeText('first output'),
        snapshotByteLimit: null,
      }),
    );
  });

  it('includes locally buffered bytes in live recovery metadata', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitNoopRecovery(startupRequest?.requestId ?? 'missing-startup-request');

    emitStructuredData('first output');
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });
    emitStructuredData(' buffered while recovering');
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });

    expect(requestRemoteTerminalRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        outputCursor: Buffer.byteLength('first output buffered while recovering', 'utf8'),
        renderedTail: encodeText('first output buffered while recovering'),
        snapshotByteLimit: null,
      }),
    );
  });

  it('appends delta recovery without resetting or clearing the terminal', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitNoopRecovery(startupRequest?.requestId ?? 'missing-startup-request');
    emitStructuredData('first output');

    remoteDetailState.writeSpy.mockClear();
    remoteDetailState.resetSpy.mockClear();
    remoteDetailState.clearSpy.mockClear();

    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });
    const liveRequest = vi.mocked(requestRemoteTerminalRecovery).mock.calls[0]?.[0];
    emitRecoveryEntry({
      outputCursor: Buffer.byteLength('first output + delta', 'utf8'),
      recovery: {
        data: encodeText(' + delta'),
        kind: 'delta',
        overlapBytes: 0,
        source: 'cursor',
      },
      requestId: liveRequest?.requestId ?? 'missing-live-request',
    });

    expect(remoteDetailState.resetSpy).not.toHaveBeenCalled();
    expect(remoteDetailState.clearSpy).not.toHaveBeenCalled();
    expect(remoteDetailState.writeSpy).toHaveBeenCalledTimes(1);
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(' + delta');
  });

  it('flushes buffered live output before applying delta recovery', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitNoopRecovery(startupRequest?.requestId ?? 'missing-startup-request');
    emitStructuredData('first output');

    remoteDetailState.writeSpy.mockClear();
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });
    emitStructuredData(' buffered');
    const liveRequest = vi.mocked(requestRemoteTerminalRecovery).mock.calls[0]?.[0];
    emitRecoveryEntry({
      outputCursor: Buffer.byteLength('first output buffered + delta', 'utf8'),
      recovery: {
        data: encodeText(' + delta'),
        kind: 'delta',
        overlapBytes: 0,
        source: 'cursor',
      },
      requestId: liveRequest?.requestId ?? 'missing-live-request',
    });

    expect(remoteDetailState.writeSpy).toHaveBeenCalledTimes(2);
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(' buffered');
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[1]?.[0])).toBe(' + delta');
  });

  it('drops buffered output when terminal-state recovery replaces the full terminal state', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitStructuredData('buffered while startup recovery is pending');
    emitTerminalStateRecovery(startupRequest?.requestId ?? 'missing-startup-request');

    expect(remoteDetailState.writeSpy).toHaveBeenCalledTimes(1);
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(
      '\x1b[Hrestored prompt',
    );
  });

  it('exits recovery mode after bounded watchdog retries', () => {
    useFakeTimersWithImmediateAnimationFrames();

    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    emitStructuredData('buffered while recovery retries');
    vi.advanceTimersByTime(15_000);

    expect(requestRemoteTerminalStartupRecovery).toHaveBeenCalledTimes(3);
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(
      'buffered while recovery retries',
    );
  }, 20_000);

  it('cancels stale settle fit frames when another fit is scheduled', () => {
    const pendingFrames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const frame = nextFrame;
      nextFrame += 1;
      pendingFrames.set(frame, callback);
      return frame;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => {
      pendingFrames.delete(frame);
    });

    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    screen.getByRole('button', { name: 'Increase terminal font size' }).click();
    expect(pendingFrames.size).toBe(1);

    const firstFrame = pendingFrames.keys().next().value;
    if (firstFrame === undefined) {
      throw new Error('Expected a queued fit frame');
    }
    const firstCallback = pendingFrames.get(firstFrame);
    expect(firstCallback).toBeDefined();
    pendingFrames.delete(firstFrame);
    firstCallback?.(0);
    expect(pendingFrames.size).toBe(1);

    screen.getByRole('button', { name: 'Increase terminal font size' }).click();

    expect(pendingFrames.size).toBe(1);
  });

  it('ignores a stale takeover result after the agent moves to another task', async () => {
    const takeover = createDeferred<'acquired'>();
    const ownerStatus = {
      action: 'type in the terminal',
      controllerId: 'other-client',
      isSelf: false,
      label: 'Other session typing',
    };
    vi.mocked(getRemoteTaskControllerOwnerStatus).mockReturnValue(ownerStatus);
    vi.mocked(getRemoteTaskOwnerStatus).mockReturnValue(ownerStatus);
    vi.mocked(requestRemoteTaskTakeover).mockReturnValue(takeover.promise);

    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const takeOverButton = screen.getByRole('button', { name: 'Take Over' });
    takeOverButton.click();

    await waitFor(() => {
      expect(takeOverButton.textContent).toBe('Working…');
    });

    remoteDetailState.setAgents?.([
      createAgent({
        taskId: 'task-2',
        taskName: 'Hydra Secondary Agent',
      }),
    ]);

    await waitFor(() => {
      expect(takeOverButton.textContent).toBe('Take Over');
    });

    takeover.resolve('acquired');
    await Promise.resolve();

    expect(requestRemoteTaskTakeover).toHaveBeenCalledWith('task-1', false);
    expect(screen.queryByText('You now control this terminal.')).toBeNull();
  });

  it('ignores a late takeover result after the detail view unmounts', async () => {
    const takeover = createDeferred<'acquired'>();
    const ownerStatus = {
      action: 'type in the terminal',
      controllerId: 'other-client',
      isSelf: false,
      label: 'Other session typing',
    };
    vi.mocked(getRemoteTaskControllerOwnerStatus).mockReturnValue(ownerStatus);
    vi.mocked(getRemoteTaskOwnerStatus).mockReturnValue(ownerStatus);
    vi.mocked(requestRemoteTaskTakeover).mockReturnValue(takeover.promise);

    const result = render(() => (
      <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />
    ));

    const takeOverButton = screen.getByRole('button', { name: 'Take Over' });
    takeOverButton.click();

    await waitFor(() => {
      expect(takeOverButton.textContent).toBe('Working…');
    });

    remoteDetailState.fitSpy.mockClear();
    result.unmount();
    takeover.resolve('acquired');
    await takeover.promise;
    await Promise.resolve();

    expect(requestRemoteTaskTakeover).toHaveBeenCalledWith('task-1', false);
    expect(remoteDetailState.fitSpy).not.toHaveBeenCalled();
  });

  it('ignores a stale failed input send after the agent moves to another task', async () => {
    const sendResult = createDeferred<boolean>();
    vi.mocked(sendRemoteAgentInput).mockReturnValue(sendResult.promise);

    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    fireEvent.input(screen.getByLabelText('Type a command for this agent'), {
      target: { value: 'status' },
    });
    screen.getByRole('button', { name: 'Send command' }).click();

    remoteDetailState.setAgents?.([
      createAgent({
        taskId: 'task-2',
        taskName: 'Hydra Secondary Agent',
      }),
    ]);

    sendResult.resolve(false);
    await Promise.resolve();

    expect(sendRemoteAgentInput).toHaveBeenCalledWith('agent-1', 'task-1', 'status\r');
    expect(screen.queryByText('Connection unavailable. Try again.')).toBeNull();
  });

  it('cancels delayed command scrolling when the agent moves to another task', () => {
    useFakeTimersWithImmediateAnimationFrames();

    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    fireEvent.input(screen.getByLabelText('Type a command for this agent'), {
      target: { value: 'status' },
    });
    screen.getByRole('button', { name: 'Send command' }).click();

    remoteDetailState.setAgents?.([
      createAgent({
        taskId: 'task-2',
        taskName: 'Hydra Secondary Agent',
      }),
    ]);
    vi.advanceTimersByTime(180);

    expect(remoteDetailState.scrollToBottomSpy).not.toHaveBeenCalled();
  });

  it('does not send a stale debounced resize after the agent moves to another task', () => {
    useFakeTimersWithImmediateAnimationFrames();

    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);
    screen.getByRole('button', { name: 'Increase terminal font size' }).click();

    remoteDetailState.setAgents?.([
      createAgent({
        taskId: 'task-2',
        taskName: 'Hydra Secondary Agent',
      }),
    ]);
    vi.advanceTimersByTime(100);

    expect(sendRemoteAgentResize).not.toHaveBeenCalledWith('agent-1', 'task-1', 80, 24);
    expect(sendRemoteAgentResize).toHaveBeenCalledWith('agent-1', 'task-2', 80, 24);
  });
});
