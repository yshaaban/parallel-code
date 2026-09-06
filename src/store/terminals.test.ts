import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import {
  clearCompatibilityTerminalCreationsForTests,
  isCompatibilityTerminalCreationPending,
} from '../runtime/compatibility-terminal-creation';
import { setStore, store } from './core';
import { registerFocusFn, resetFocusStateForTests } from './focus';
import { closeTerminal, createTerminal } from './terminals';
import { createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import {
  createTaskCommandLeaseSession,
  resetTaskCommandLeaseStateForTests,
} from '../app/task-command-lease';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { resetTaskCommandControllerStateForTests } from './task-command-controllers';
import {
  acquireTaskCommandLease,
  isTaskCommandLeaseHeld,
  releaseTaskCommandLease,
  resetTaskCommandLeasesForTest,
} from '../../electron/ipc/task-command-leases';
import {
  enqueuePendingSessionInput,
  getPendingSessionInputCount,
  resetPendingSessionInputForTests,
} from '../components/terminal-view/terminal-pending-session-input';
import {
  getTaskTerminalStartupSummary,
  registerTerminalStartupCandidate,
} from './terminal-startup';

const { invokeMock, saveCurrentRuntimeStateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveCurrentRuntimeStateMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: () => true,
}));

vi.mock('./persistence-save', () => ({
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
}));

describe('terminal cleanup', () => {
  beforeEach(() => {
    resetTaskCommandLeaseStateForTests();
    resetTaskCommandControllerStateForTests();
    resetTaskCommandLeasesForTest();
    resetPendingSessionInputForTests();
    vi.clearAllMocks();
    clearCompatibilityTerminalCreationsForTests();
    resetStoreForTest();
    resetFocusStateForTests();
    invokeMock.mockResolvedValue(undefined);
    saveCurrentRuntimeStateMock.mockResolvedValue(undefined);

    setStore('taskOrder', ['terminal-1']);
    setStore('activeTaskId', 'terminal-1');
    setStore('focusedPanel', { 'terminal-1': 'terminal' });
    setStore('fontScales', {
      'terminal-1': 1.1,
      'terminal-1:terminal': 1.2,
    });
    setStore('panelSizes', { 'terminal-1:terminal': 320 });
    setStore('terminals', {
      'terminal-1': {
        id: 'terminal-1',
        name: 'Shell',
        agentId: 'terminal-agent-1',
      },
    });
    setStore('agents', {
      'terminal-agent-1': {
        id: 'terminal-agent-1',
        taskId: 'terminal-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    setStore('agentActive', { 'terminal-agent-1': true });
    setStore('agentSupervision', { 'terminal-agent-1': {} as never });
  });

  it('removes terminal-side agent state through the shared cleanup helpers', async () => {
    await closeTerminal('terminal-1');

    expect(invokeMock).toHaveBeenCalledWith(IPC.KillAgent, { agentId: 'terminal-agent-1' });
    expect(store.terminals['terminal-1']).toBeUndefined();
    expect(store.agents['terminal-agent-1']).toBeUndefined();
    expect(store.agentActive['terminal-agent-1']).toBeUndefined();
    expect(store.agentSupervision['terminal-agent-1']).toBeUndefined();
    expect(store.focusedPanel['terminal-1']).toBeUndefined();
    expect(store.fontScales['terminal-1']).toBeUndefined();
    expect(store.fontScales['terminal-1:terminal']).toBeUndefined();
    expect(store.panelSizes['terminal-1:terminal']).toBeUndefined();
    expect(saveCurrentRuntimeStateMock).toHaveBeenCalledTimes(1);
  });

  it('transfers placeholder focus to a new standalone terminal and clears its exact identity on close', async () => {
    const previousTerminalIds = new Set(store.taskOrder);
    setStore('placeholderFocused', true);
    setStore('sidebarFocused', true);

    createTerminal();

    const terminalId = store.taskOrder.find((id) => !previousTerminalIds.has(id));
    if (!terminalId) throw new Error('Expected createTerminal to append a terminal identity');
    const terminal = store.terminals[terminalId];
    if (!terminal) throw new Error('Expected createTerminal to store the appended terminal');
    expect(store.placeholderFocused).toBe(false);
    expect(store.sidebarFocused).toBe(false);
    expect(store.activeTaskId).toBe(terminalId);
    expect(store.focusedPanel[terminalId]).toBe('terminal');
    expect(isCompatibilityTerminalCreationPending(terminal.id, terminal.agentId)).toBe(true);

    await closeTerminal(terminalId);

    expect(isCompatibilityTerminalCreationPending(terminal.id, terminal.agentId)).toBe(false);
  });

  it('retires closed scratch control and queued input immediately without touching a sibling', async () => {
    const clientId = getRuntimeClientId();
    setStore('terminals', 'terminal-2', {
      id: 'terminal-2',
      agentId: 'terminal-agent-2',
      name: 'Sibling',
    });
    setStore('taskOrder', ['terminal-1', 'terminal-2']);
    setStore('incomingTaskTakeoverRequests', 'takeover-1', {
      action: 'type in the terminal',
      expiresAt: Date.now() + 60_000,
      requestId: 'takeover-1',
      requesterClientId: 'peer',
      requesterDisplayName: 'Peer',
      taskId: 'terminal-1',
    });
    invokeMock.mockImplementation(async (channel: IPC, args) => {
      if (channel === IPC.AcquireTaskCommandLease) {
        return acquireTaskCommandLease(args.taskId, args.clientId, args.ownerId, args.action);
      }
      if (channel === IPC.ReleaseTaskCommandLease) {
        return releaseTaskCommandLease(
          args.taskId,
          args.clientId,
          args.ownerId,
          Date.now(),
          args.leaseGeneration,
        ).snapshot;
      }
      if (channel === IPC.KillAgent) return undefined;
      throw new Error(`Unexpected IPC channel: ${channel}`);
    });
    const closedSession = createTaskCommandLeaseSession('terminal-1', 'type in the terminal');
    const siblingSession = createTaskCommandLeaseSession('terminal-2', 'type in the terminal');
    try {
      expect(await closedSession.acquire()).toBe(true);
      expect(await siblingSession.acquire()).toBe(true);
      enqueuePendingSessionInput('terminal-1:terminal-agent-1', 'do not replay');
      enqueuePendingSessionInput('terminal-2:terminal-agent-2', 'keep sibling input');
      registerTerminalStartupCandidate('terminal-1:terminal-agent-1', 'terminal-1');
      registerTerminalStartupCandidate('terminal-2:terminal-agent-2', 'terminal-2');

      await closeTerminal('terminal-1');

      expect(store.terminals['terminal-1']).toBeUndefined();
      expect(store.taskCommandControllers['terminal-1']).toBeUndefined();
      expect(store.incomingTaskTakeoverRequests['takeover-1']).toBeUndefined();
      expect(getPendingSessionInputCount('terminal-1:terminal-agent-1')).toBe(0);
      expect(getTaskTerminalStartupSummary('terminal-1')).toBeNull();
      expect(isTaskCommandLeaseHeld('terminal-1', clientId)).toBe(false);
      expect(closedSession.touch()).toBe(false);
      expect(store.terminals['terminal-2']).toBeDefined();
      expect(getPendingSessionInputCount('terminal-2:terminal-agent-2')).toBe(1);
      expect(getTaskTerminalStartupSummary('terminal-2')?.count).toBe(1);
      expect(isTaskCommandLeaseHeld('terminal-2', clientId)).toBe(true);
      expect(siblingSession.touch()).toBe(true);
    } finally {
      await siblingSession.release();
      closedSession.cleanup();
      siblingSession.cleanup();
      resetTaskCommandLeaseStateForTests();
      resetTaskCommandLeasesForTest();
      resetPendingSessionInputForTests();
    }
  });

  it('selects and focuses a neighboring terminal-only task after closing a standalone terminal', async () => {
    const focusShell = vi.fn();
    setStore('tasks', {
      'task-terminal': createTestTask({
        agentIds: [],
        id: 'task-terminal',
        shellAgentIds: ['task-shell-1'],
        taskMode: 'terminal',
      }),
    });
    setStore('taskOrder', ['task-terminal', 'terminal-1']);
    registerFocusFn('task-terminal:shell:0', focusShell);

    await closeTerminal('terminal-1');

    expect(store.activeTaskId).toBe('task-terminal');
    expect(store.activeAgentId).toBe('task-shell-1');
    expect(focusShell).toHaveBeenCalledTimes(1);
  });
});
