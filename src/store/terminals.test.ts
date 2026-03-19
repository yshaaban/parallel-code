import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { setStore, store } from './core';
import { closeTerminal } from './terminals';
import { resetStoreForTest } from '../test/store-test-helpers';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../lib/ipc')>('../lib/ipc');
  return {
    ...actual,
    invoke: invokeMock,
  };
});

describe('terminal cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetStoreForTest();
    invokeMock.mockResolvedValue(undefined);

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

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('removes terminal-side agent state through the shared cleanup helpers', async () => {
    await closeTerminal('terminal-1');
    await vi.advanceTimersByTimeAsync(300);

    expect(invokeMock).toHaveBeenCalledWith(IPC.KillAgent, { agentId: 'terminal-agent-1' });
    expect(store.terminals['terminal-1']).toBeUndefined();
    expect(store.agents['terminal-agent-1']).toBeUndefined();
    expect(store.agentActive['terminal-agent-1']).toBeUndefined();
    expect(store.agentSupervision['terminal-agent-1']).toBeUndefined();
    expect(store.focusedPanel['terminal-1']).toBeUndefined();
    expect(store.fontScales['terminal-1']).toBeUndefined();
    expect(store.fontScales['terminal-1:terminal']).toBeUndefined();
    expect(store.panelSizes['terminal-1:terminal']).toBeUndefined();
  });
});
