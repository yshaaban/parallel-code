import { describe, expect, it } from 'vitest';

import { createTestTask } from '../test/store-test-helpers';
import { getSelectedTaskAgentId, getSelectedTaskRuntimeAgentId } from './task-agent-selection';

describe('task agent selection projection', () => {
  it('prefers a valid active AI agent over the stored selected agent', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      selectedAgentId: 'agent-1',
      shellAgentIds: ['shell-1'],
    });

    expect(getSelectedTaskAgentId(task, 'agent-2')).toBe('agent-2');
  });

  it('falls back to stored selected agent, then first AI agent', () => {
    expect(
      getSelectedTaskAgentId(
        createTestTask({ agentIds: ['agent-1', 'agent-2'], selectedAgentId: 'agent-2' }),
      ),
    ).toBe('agent-2');
    expect(
      getSelectedTaskAgentId(
        createTestTask({ agentIds: ['agent-1', 'agent-2'], selectedAgentId: 'missing' }),
      ),
    ).toBe('agent-1');
  });

  it('allows runtime selection to preserve shell agents when restoring local session state', () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      selectedAgentId: 'agent-1',
      shellAgentIds: ['shell-1'],
    });

    expect(getSelectedTaskRuntimeAgentId(task, 'shell-1')).toBe('shell-1');
    expect(getSelectedTaskRuntimeAgentId(task, 'missing')).toBe('agent-1');
  });
});
