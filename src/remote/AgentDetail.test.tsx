import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import type { RemoteAgent } from '../../electron/remote/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteDetailState = vi.hoisted(() => ({
  emitOutput: null as null | ((agentId: string, data: string) => void),
  emitScrollback: null as null | ((agentId: string, data: string, cols: number) => void),
  fitSpy: vi.fn(),
  refreshSpy: vi.fn(),
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
    resize(): void {}
    scrollToBottom(): void {}
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

function createAgent(): RemoteAgent {
  return {
    agentId: 'agent-1',
    exitCode: null,
    lastLine: 'ready',
    status: 'running',
    taskId: 'task-1',
    taskMeta: undefined,
    taskName: 'Hydra Main Agent',
  };
}

describe('AgentDetail', () => {
  beforeEach(() => {
    remoteDetailState.fitSpy.mockReset();
    remoteDetailState.refreshSpy.mockReset();
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
});
