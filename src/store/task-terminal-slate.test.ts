import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markAgentOutput, resetAgentOutputActivityRuntimeState } from './agent-output-activity';
import { setStore } from './core';
import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import {
  getTaskTerminalSlateCacheSizeForTests,
  getTaskTerminalSlateSnapshot,
  resetTaskTerminalSlateCacheForTests,
} from './task-terminal-slate';

describe('task-terminal-slate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    resetStoreForTest();
    resetAgentOutputActivityRuntimeState();
    resetTaskTerminalSlateCacheForTests();
  });

  afterEach(() => {
    resetAgentOutputActivityRuntimeState();
    resetTaskTerminalSlateCacheForTests();
    resetStoreForTest();
    vi.useRealTimers();
  });

  it('builds a compact slate from the selected agent output tail', () => {
    setStore(
      'tasks',
      'task-1',
      createTestTask({ agentIds: ['agent-1'], selectedAgentId: 'agent-1' }),
    );
    setStore('agents', 'agent-1', createTestAgent({ id: 'agent-1', taskId: 'task-1' }));

    markAgentOutput('agent-1', new TextEncoder().encode('first line\n\x1b[31mlast line\x1b[0m\n'));

    expect(getTaskTerminalSlateSnapshot('task-1')).toEqual({
      agentId: 'agent-1',
      lastLine: 'last line',
      lastOutputAt: 1_000,
      stale: false,
    });
  });

  it('marks stale slate snapshots when output is old', () => {
    setStore('tasks', 'task-1', createTestTask({ agentIds: ['agent-1'] }));
    setStore('agents', 'agent-1', createTestAgent({ id: 'agent-1', taskId: 'task-1' }));

    markAgentOutput('agent-1', new TextEncoder().encode('still running\n'));

    expect(getTaskTerminalSlateSnapshot('task-1', 32_000)?.stale).toBe(true);
  });

  it('can clear cached slate entries without retaining output tails', () => {
    setStore('tasks', 'task-1', createTestTask({ agentIds: ['agent-1'] }));
    setStore('agents', 'agent-1', createTestAgent({ id: 'agent-1', taskId: 'task-1' }));

    markAgentOutput('agent-1', new TextEncoder().encode('line\n'));
    expect(getTaskTerminalSlateSnapshot('task-1')?.lastLine).toBe('line');
    expect(getTaskTerminalSlateCacheSizeForTests()).toBe(1);

    resetTaskTerminalSlateCacheForTests();
    expect(getTaskTerminalSlateCacheSizeForTests()).toBe(0);
  });
});
