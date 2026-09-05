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

const { invokeMock, saveCurrentRuntimeStateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  saveCurrentRuntimeStateMock: vi.fn(),
}));

vi.mock('../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../lib/ipc')>('../lib/ipc');
  return {
    ...actual,
    invoke: invokeMock,
  };
});

vi.mock('./persistence-save', () => ({
  saveCurrentRuntimeState: saveCurrentRuntimeStateMock,
}));

describe('terminal cleanup', () => {
  beforeEach(() => {
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

  it('marks a standalone terminal creation pending and clears that exact identity on close', async () => {
    const previousTerminalIds = new Set(store.taskOrder);

    createTerminal();

    const terminalId = store.taskOrder.find((id) => !previousTerminalIds.has(id));
    if (!terminalId) throw new Error('Expected createTerminal to append a terminal identity');
    const terminal = store.terminals[terminalId];
    if (!terminal) throw new Error('Expected createTerminal to store the appended terminal');
    expect(isCompatibilityTerminalCreationPending(terminal.id, terminal.agentId)).toBe(true);

    await closeTerminal(terminalId);

    expect(isCompatibilityTerminalCreationPending(terminal.id, terminal.agentId)).toBe(false);
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
