import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markAgentOutput, resetAgentOutputActivityRuntimeState } from './agent-output-activity';
import { setStore } from './core';
import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import {
  getTaskTerminalPlaceholderTail,
  getTaskTerminalSlateCacheSizeForTests,
  getTaskTerminalSlateSnapshot,
  hasTaskTerminalSlateCacheForAgentForTests,
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

  it('projects the last visible lines of the output tail as the placeholder', () => {
    markAgentOutput(
      'agent-1',
      new TextEncoder().encode('first\n\x1b[32msecond\x1b[0m\nthird\n\n\n'),
    );

    expect(getTaskTerminalPlaceholderTail('agent-1')).toBe('first\nsecond\nthird');
  });

  it('caps the placeholder to the last 24 lines and 200 chars per line', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line-${index}`);
    lines.push('x'.repeat(500));
    markAgentOutput('agent-1', new TextEncoder().encode(`${lines.join('\n')}\n`));

    const placeholder = getTaskTerminalPlaceholderTail('agent-1');
    const placeholderLines = placeholder?.split('\n') ?? [];
    expect(placeholderLines).toHaveLength(24);
    expect(placeholderLines[0]).toBe('line-17');
    expect(placeholderLines[23]).toBe('x'.repeat(200));
  });

  it('falls back to the supervision preview when no local output tail exists', () => {
    setStore('agentSupervision', 'agent-cold', {
      agentId: 'agent-cold',
      attentionReason: null,
      isShell: false,
      lastOutputAt: 900,
      preview: 'Last known supervision line',
      state: 'active',
      taskId: 'task-1',
      updatedAt: 900,
    });

    expect(getTaskTerminalPlaceholderTail('agent-cold')).toBe('Last known supervision line');
  });

  it('returns null when neither a tail nor a preview exists', () => {
    expect(getTaskTerminalPlaceholderTail('agent-missing')).toBeNull();
  });

  it('promotes updated slate entries before evicting the least recently used entry', () => {
    for (let index = 0; index < 256; index += 1) {
      const taskId = `task-${index}`;
      const agentId = `agent-${index}`;
      setStore('tasks', taskId, createTestTask({ agentIds: [agentId] }));
      setStore('agents', agentId, createTestAgent({ id: agentId, taskId }));
      markAgentOutput(agentId, new TextEncoder().encode(`line ${index}\n`));
      getTaskTerminalSlateSnapshot(taskId);
    }

    markAgentOutput('agent-0', new TextEncoder().encode('line 0 updated\n'));
    getTaskTerminalSlateSnapshot('task-0');

    setStore('tasks', 'task-256', createTestTask({ agentIds: ['agent-256'] }));
    setStore('agents', 'agent-256', createTestAgent({ id: 'agent-256', taskId: 'task-256' }));
    markAgentOutput('agent-256', new TextEncoder().encode('line 256\n'));
    getTaskTerminalSlateSnapshot('task-256');

    expect(getTaskTerminalSlateCacheSizeForTests()).toBe(256);
    expect(hasTaskTerminalSlateCacheForAgentForTests('agent-0')).toBe(true);
    expect(hasTaskTerminalSlateCacheForAgentForTests('agent-1')).toBe(false);
  });
});
