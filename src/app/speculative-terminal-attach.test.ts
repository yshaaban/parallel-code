import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginSpeculativeSelectedTerminalAttach,
  getSpeculativeSelectedTerminalIntent,
  onSpeculativeSelectedTerminalResolved,
  resetSpeculativeTerminalAttachForTests,
  resolveSpeculativeSelectedTerminalAttach,
} from './speculative-terminal-attach';

describe('speculative selected-terminal attach', () => {
  afterEach(() => {
    resetSpeculativeTerminalAttachForTests();
  });

  it('publishes the intent and keeps it readable until resolution', () => {
    beginSpeculativeSelectedTerminalAttach({ agentId: 'agent-1', taskId: 'task-1' });

    expect(getSpeculativeSelectedTerminalIntent()).toEqual({
      agentId: 'agent-1',
      taskId: 'task-1',
    });

    resolveSpeculativeSelectedTerminalAttach('confirmed');

    expect(getSpeculativeSelectedTerminalIntent()).toBeNull();
  });

  it('fires resolution callbacks exactly once with the resolved intent', () => {
    const listener = vi.fn();
    onSpeculativeSelectedTerminalResolved(listener);
    beginSpeculativeSelectedTerminalAttach({ agentId: 'agent-1', taskId: 'task-1' });

    resolveSpeculativeSelectedTerminalAttach('discarded');
    resolveSpeculativeSelectedTerminalAttach('confirmed');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('discarded', {
      agentId: 'agent-1',
      taskId: 'task-1',
    });
  });

  it('treats resolution without a published intent as a no-op', () => {
    const listener = vi.fn();
    onSpeculativeSelectedTerminalResolved(listener);
    beginSpeculativeSelectedTerminalAttach(null);

    resolveSpeculativeSelectedTerminalAttach('confirmed');

    expect(listener).not.toHaveBeenCalled();
    expect(getSpeculativeSelectedTerminalIntent()).toBeNull();
  });

  it('supports unsubscribing resolution listeners and a fresh begin after resolve', () => {
    const listener = vi.fn();
    const unsubscribe = onSpeculativeSelectedTerminalResolved(listener);
    beginSpeculativeSelectedTerminalAttach({ agentId: 'agent-1', taskId: 'task-1' });
    resolveSpeculativeSelectedTerminalAttach('confirmed');
    expect(listener).toHaveBeenCalledTimes(1);

    beginSpeculativeSelectedTerminalAttach({ agentId: 'agent-2', taskId: 'task-2' });
    expect(getSpeculativeSelectedTerminalIntent()).toEqual({
      agentId: 'agent-2',
      taskId: 'task-2',
    });

    unsubscribe();
    resolveSpeculativeSelectedTerminalAttach('discarded');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('auto-discards an unresolved prior intent before publishing a new one', () => {
    const listener = vi.fn();
    onSpeculativeSelectedTerminalResolved(listener);

    beginSpeculativeSelectedTerminalAttach({ agentId: 'agent-1', taskId: 'task-1' });
    beginSpeculativeSelectedTerminalAttach({ agentId: 'agent-2', taskId: 'task-2' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('discarded', {
      agentId: 'agent-1',
      taskId: 'task-1',
    });
    expect(getSpeculativeSelectedTerminalIntent()).toEqual({
      agentId: 'agent-2',
      taskId: 'task-2',
    });
  });
});
