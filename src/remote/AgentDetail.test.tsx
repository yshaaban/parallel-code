import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import type { RemoteAgent, RemoteTerminalStreamEvent } from '../../electron/remote/protocol';
import type { TerminalRecoveryBatchEntry, TerminalRecoveryPayload } from '../ipc/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteDetailState = vi.hoisted(() => ({
  agentReads: 0,
  clearSpy: vi.fn(),
  deferWriteCallbacks: false,
  disposeSpy: vi.fn(),
  emitConnectionStatus: null as null | ((status: 'connected' | 'disconnected') => void),
  emitInput: null as null | ((data: string) => void),
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
  terminalInstances: [] as Array<{ options: Record<string, unknown>; rows: number }>,
  writeCallbacks: [] as Array<() => void>,
}));

const taskNotesState = vi.hoisted(() => ({
  discard: vi.fn(),
  hasUnsaved: vi.fn((_taskId?: string) => false),
}));

vi.mock('./TaskNotesView', () => ({
  confirmRemoteTaskNotesLeave: (
    taskId: string,
    message: string,
    confirm: typeof window.confirm,
  ) => {
    if (!taskNotesState.hasUnsaved(taskId)) return true;
    if (!confirm(message)) return false;
    taskNotesState.discard(taskId);
    return true;
  },
  TaskNotesView: () => <div>Lazy task notes</div>,
}));

vi.mock('./task-notes-runtime', () => ({
  discardRemoteTaskNotes: taskNotesState.discard,
  hasUnsavedRemoteTaskNotes: taskNotesState.hasUnsaved,
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
      remoteDetailState.terminalInstances.push(this);
    }

    clear(): void {
      remoteDetailState.clearSpy();
    }
    dispose(): void {
      remoteDetailState.disposeSpy();
    }
    loadAddon(): void {}
    onData(listener: (data: string) => void): { dispose(): void } {
      remoteDetailState.emitInput = listener;
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
    resize(cols?: number, rows?: number): void {
      if (cols !== undefined) {
        this.cols = cols;
      }
      if (rows !== undefined) {
        this.rows = rows;
      }
    }
    scrollToBottom(): void {
      remoteDetailState.scrollToBottomSpy();
    }
    write(_data: unknown, callback?: () => void): void {
      remoteDetailState.writeSpy(_data);
      if (callback && remoteDetailState.deferWriteCallbacks) {
        remoteDetailState.writeCallbacks.push(callback);
        return;
      }
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
  const connectionStatusListeners = new Set<(status: 'connected' | 'disconnected') => void>();
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
  remoteDetailState.emitConnectionStatus = (status) => {
    connectionStatusListeners.forEach((listener) => listener(status));
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
    subscribeRemoteConnectionStatus: vi.fn(
      (listener: (status: 'connected' | 'disconnected') => void) => {
        connectionStatusListeners.add(listener);
        listener('connected');
        return () => {
          connectionStatusListeners.delete(listener);
        };
      },
    ),
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

function flushNextTerminalWrite(): void {
  const callback = remoteDetailState.writeCallbacks.shift();
  if (!callback) {
    throw new Error('Expected a pending terminal write callback');
  }
  callback();
}

describe('AgentDetail', () => {
  beforeEach(() => {
    remoteDetailState.agentReads = 0;
    remoteDetailState.clearSpy.mockReset();
    remoteDetailState.deferWriteCallbacks = false;
    remoteDetailState.disposeSpy.mockReset();
    remoteDetailState.emitInput = null;
    remoteDetailState.fitSpy.mockReset();
    remoteDetailState.refreshSpy.mockReset();
    remoteDetailState.resetSpy.mockReset();
    remoteDetailState.scrollToBottomSpy.mockReset();
    remoteDetailState.writeSpy.mockReset();
    remoteDetailState.terminalInstances = [];
    remoteDetailState.writeCallbacks = [];
    taskNotesState.discard.mockReset();
    taskNotesState.hasUnsaved.mockReset();
    taskNotesState.hasUnsaved.mockReturnValue(false);
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

  it('attaches a catalog shell by session id without adding it to the agent list', async () => {
    vi.useFakeTimers();
    remoteDetailState.setAgents?.([]);

    render(() => (
      <AgentDetail
        agentId="shell-session-1"
        taskName="Terminal-only task"
        taskSession={{
          generation: 2,
          kind: 'shell',
          orderKey: '0001',
          sessionId: 'shell-session-1',
          state: 'running',
          taskId: 'task-shell-1',
        }}
        onBack={vi.fn()}
      />
    ));

    expect(subscribeAgent).toHaveBeenCalledWith('shell-session-1', {
      terminalProtocol: 'structured',
    });
    expect(screen.getByRole('button', { name: 'Back to task details' })).toBeDefined();
    expect(screen.getByLabelText('Terminal output for Terminal-only task')).toBeDefined();

    await vi.advanceTimersByTimeAsync(3_100);
    expect(screen.queryByRole('alertdialog', { name: 'Agent not found' })).toBeNull();
  });

  it('keeps capability-limited terminal sessions read-only across owner updates', async () => {
    useFakeTimersWithImmediateAnimationFrames();
    remoteDetailState.setAgents?.([]);

    render(() => (
      <AgentDetail
        agentId="shell-session-1"
        taskName="Terminal-only task"
        taskSession={{
          generation: 2,
          kind: 'shell',
          orderKey: '0001',
          sessionId: 'shell-session-1',
          state: 'running',
          taskId: 'task-shell-1',
        }}
        terminalControl={false}
        terminalKill={false}
        onBack={vi.fn()}
      />
    ));

    expect(remoteDetailState.terminalInstances[0]?.options.disableStdin).toBe(true);
    expect(screen.queryByRole('button', { name: 'Take Over' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kill running agent' })).toBeNull();

    remoteDetailState.emitInput?.('whoami\r');
    await Promise.resolve();
    vi.advanceTimersByTime(100);

    expect(sendRemoteAgentInput).not.toHaveBeenCalled();
    expect(sendRemoteAgentResize).not.toHaveBeenCalled();
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

    const refreshCallsBefore = remoteDetailState.refreshSpy.mock.calls.length;
    emitTerminalStateRecovery(startupRequest?.requestId ?? 'missing-request');

    expect(remoteDetailState.resetSpy).toHaveBeenCalled();
    expect(remoteDetailState.writeSpy).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(remoteDetailState.scrollToBottomSpy).toHaveBeenCalled();
    expect(remoteDetailState.refreshSpy).toHaveBeenCalledTimes(refreshCallsBefore + 1);
    expect(remoteDetailState.refreshSpy).toHaveBeenLastCalledWith(0, 29);
  });

  it('refreshes only after recovery and the final buffered live write have rendered', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitNoopRecovery(startupRequest?.requestId ?? 'missing-startup-request');
    emitStructuredData('first output');
    remoteDetailState.writeSpy.mockClear();
    remoteDetailState.refreshSpy.mockClear();
    remoteDetailState.deferWriteCallbacks = true;

    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });
    emitStructuredData(' buffered');
    const liveRequest = vi.mocked(requestRemoteTerminalRecovery).mock.calls[0]?.[0];
    emitRecoveryEntry({
      outputCursor: Buffer.byteLength('first output + delta buffered', 'utf8'),
      recovery: {
        data: encodeText(' + delta'),
        kind: 'delta',
        overlapBytes: 0,
        source: 'cursor',
      },
      requestId: liveRequest?.requestId ?? 'missing-live-request',
    });

    expect(remoteDetailState.writeSpy).toHaveBeenCalledTimes(1);
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(' + delta');
    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();

    flushNextTerminalWrite();
    expect(remoteDetailState.writeSpy).toHaveBeenCalledTimes(2);
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[1]?.[0])).toBe(' buffered');
    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();

    flushNextTerminalWrite();
    expect(remoteDetailState.refreshSpy).toHaveBeenCalledTimes(1);
    expect(remoteDetailState.scrollToBottomSpy).toHaveBeenCalled();
  });

  it('refreshes accepted legacy scrollback after its write callback', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);
    remoteDetailState.deferWriteCallbacks = true;
    remoteDetailState.refreshSpy.mockClear();

    remoteDetailState.emitScrollback?.('agent-1', encodeText('restored legacy output'), 80);

    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();
    flushNextTerminalWrite();
    expect(remoteDetailState.refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh ordinary live output or a zero-row restore target', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitNoopRecovery(startupRequest?.requestId ?? 'missing-startup-request');
    remoteDetailState.refreshSpy.mockClear();
    emitStructuredData('ordinary live output');
    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();

    remoteDetailState.deferWriteCallbacks = true;
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });
    const liveRequest = vi.mocked(requestRemoteTerminalRecovery).mock.calls[0]?.[0];
    emitTerminalStateRecovery(liveRequest?.requestId ?? 'missing-live-request');
    const target = remoteDetailState.terminalInstances[0];
    if (!target) {
      throw new Error('Expected a remote terminal instance');
    }
    target.rows = 0;
    flushNextTerminalWrite();

    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();
  });

  it('rejects stale recovery write callbacks after a newer restore or disposal', () => {
    remoteDetailState.deferWriteCallbacks = true;
    const result = render(() => (
      <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />
    ));

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitTerminalStateRecovery(startupRequest?.requestId ?? 'missing-startup-request');
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });
    remoteDetailState.refreshSpy.mockClear();

    flushNextTerminalWrite();
    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();

    const liveRequest = vi.mocked(requestRemoteTerminalRecovery).mock.calls[0]?.[0];
    emitTerminalStateRecovery(liveRequest?.requestId ?? 'missing-live-request');
    result.unmount();
    flushNextTerminalWrite();

    expect(remoteDetailState.disposeSpy).toHaveBeenCalledTimes(1);
    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();
  });

  it('keeps accepted recovery complete when viewport refresh throws', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);
    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    remoteDetailState.refreshSpy.mockImplementationOnce(() => {
      throw new Error('disposed renderer');
    });

    expect(() => {
      emitTerminalStateRecovery(startupRequest?.requestId ?? 'missing-startup-request');
    }).not.toThrow();
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

  it('caps mobile live recovery history to the exact retained byte suffix', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);

    const startupRequest = vi.mocked(requestRemoteTerminalStartupRecovery).mock.calls[0]?.[0];
    emitNoopRecovery(startupRequest?.requestId ?? 'missing-startup-request');

    const firstChunk = 'a'.repeat(40 * 1024);
    const secondChunk = 'b'.repeat(40 * 1024);
    emitStructuredData(firstChunk);
    emitStructuredData(secondChunk);
    remoteDetailState.emitTerminalStream?.('agent-1', {
      reason: 'backpressure',
      type: 'RecoveryRequired',
    });

    const recoveryCalls = vi.mocked(requestRemoteTerminalRecovery).mock.calls;
    const recoveryRequest = recoveryCalls[recoveryCalls.length - 1]?.[0];
    const fullOutput = Buffer.from(`${firstChunk}${secondChunk}`, 'utf8');
    const expectedTail = fullOutput.subarray(fullOutput.length - 64 * 1024);

    expect(recoveryRequest?.outputCursor).toBe(fullOutput.length);
    expect(Buffer.from(recoveryRequest?.renderedTail ?? '', 'base64').equals(expectedTail)).toBe(
      true,
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

  it('applies delta recovery before flushing buffered live output', () => {
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
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(' + delta');
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[1]?.[0])).toBe(' buffered');
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
    remoteDetailState.refreshSpy.mockClear();
    vi.advanceTimersByTime(15_000);

    expect(requestRemoteTerminalStartupRecovery).toHaveBeenCalledTimes(3);
    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(
      'buffered while recovery retries',
    );
    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();
  }, 20_000);

  it('flushes buffered output without a repaint when disconnect ends an unwritten restore', () => {
    render(() => <AgentDetail agentId="agent-1" taskName="Hydra Main Agent" onBack={vi.fn()} />);
    emitStructuredData('buffered before disconnect');
    remoteDetailState.refreshSpy.mockClear();

    remoteDetailState.emitConnectionStatus?.('disconnected');

    expect(decodeBytes(remoteDetailState.writeSpy.mock.calls[0]?.[0])).toBe(
      'buffered before disconnect',
    );
    expect(remoteDetailState.refreshSpy).not.toHaveBeenCalled();
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

  it('switches to a lazy notes view without recreating or disposing the terminal', async () => {
    render(() => (
      <AgentDetail
        agentId="agent-1"
        taskName="Hydra Main Agent"
        onBack={vi.fn()}
        taskNotesCapability={{ read: true, write: true }}
      />
    ));
    expect(remoteDetailState.terminalInstances).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(await screen.findByText('Lazy task notes')).toBeTruthy();
    expect(screen.getByTestId('remote-terminal-shell').style.display).toBe('none');
    expect(remoteDetailState.disposeSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByTestId('remote-terminal-shell').style.display).toBe('block');
    expect(remoteDetailState.terminalInstances).toHaveLength(1);
    expect(remoteDetailState.disposeSpy).not.toHaveBeenCalled();
    expect(remoteDetailState.refreshSpy).toHaveBeenCalled();
  });

  it('supports roving keyboard focus across terminal and notes tabs', async () => {
    render(() => (
      <AgentDetail
        agentId="agent-1"
        taskName="Hydra Main Agent"
        onBack={vi.fn()}
        taskNotesCapability={{ read: true, write: true }}
      />
    ));
    const terminalTab = screen.getByRole('tab', { name: 'Terminal' });
    terminalTab.focus();

    fireEvent.keyDown(terminalTab, { key: 'ArrowRight' });
    expect(await screen.findByText('Lazy task notes')).toBeTruthy();
    const notesTab = screen.getByRole('tab', { name: 'Notes' });
    expect(document.activeElement).toBe(notesTab);
    expect(notesTab.getAttribute('aria-controls')).toBe('remote-task-notes-panel');
    expect(screen.getByRole('tabpanel', { name: 'Notes' })).toBeTruthy();

    fireEvent.keyDown(notesTab, { key: 'Home' });
    expect(document.activeElement).toBe(terminalTab);
    expect(screen.getByRole('tabpanel', { name: 'Terminal' })).toBeTruthy();
  });

  it('guards task navigation when the notes registry retains an unsaved draft', async () => {
    taskNotesState.hasUnsaved.mockReturnValue(true);
    const onBack = vi.fn();
    const confirm = vi.fn(() => false);
    render(() => (
      <AgentDetail
        agentId="agent-1"
        confirm={confirm}
        taskName="Hydra Main Agent"
        onBack={onBack}
        taskNotesCapability={{ read: true, write: true }}
      />
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Back to agent list' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(onBack).not.toHaveBeenCalled();
    expect(taskNotesState.discard).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Back to agent list' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(taskNotesState.discard).toHaveBeenCalledWith('task-1');
  });
});
