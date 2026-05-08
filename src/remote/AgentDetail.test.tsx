import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import type { RemoteAgent } from '../../electron/remote/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteDetailState = vi.hoisted(() => ({
  emitOutput: null as null | ((agentId: string, data: string) => void),
  emitScrollback: null as null | ((agentId: string, data: string, cols: number) => void),
  fitSpy: vi.fn(),
  refreshSpy: vi.fn(),
  scrollToBottomSpy: vi.fn(),
  setAgents: null as null | ((agents: RemoteAgent[]) => void),
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

    clear(): void {}
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
    resize(cols?: number): void {
      if (cols !== undefined) {
        this.cols = cols;
      }
    }
    scrollToBottom(): void {
      remoteDetailState.scrollToBottomSpy();
    }
    write(_data: unknown, callback?: () => void): void {
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

  remoteDetailState.setAgents = setAgentsSignal;
  remoteDetailState.emitOutput = (agentId: string, data: string) => {
    outputListeners.get(agentId)?.forEach((listener) => listener(data));
  };
  remoteDetailState.emitScrollback = (agentId: string, data: string, cols: number) => {
    scrollbackListeners.get(agentId)?.forEach((listener) => listener(data, cols));
  };

  return {
    agents: agentsSignal,
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
    sendKill: vi.fn(),
    status: vi.fn(() => 'connected'),
    subscribeAgent: vi.fn(),
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
    remoteDetailState.fitSpy.mockReset();
    remoteDetailState.refreshSpy.mockReset();
    remoteDetailState.scrollToBottomSpy.mockReset();
    vi.mocked(getRemoteTaskControllerOwnerStatus).mockReturnValue(null);
    vi.mocked(getRemoteTaskOwnerStatus).mockReturnValue(null);
    vi.mocked(requestRemoteTaskTakeover).mockResolvedValue('acquired');
    vi.mocked(sendRemoteAgentInput).mockResolvedValue(true);
    vi.mocked(sendRemoteAgentResize).mockClear();
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
