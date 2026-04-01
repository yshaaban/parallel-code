import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { resetStoreForTest } from '../test/store-test-helpers';
import { createTestAgentDef } from '../test/store-test-helpers';
import { AgentSelector } from './AgentSelector';

describe('AgentSelector', () => {
  it('wraps agent buttons instead of forcing one shrinking row', () => {
    resetStoreForTest();
    const onSelect = vi.fn();
    const agents = Array.from({ length: 9 }, (_, index) =>
      createTestAgentDef({
        id: `agent-${index}`,
        name: `Agent ${index}`,
      }),
    );

    render(() => (
      <AgentSelector agents={agents} selectedAgent={agents[0] ?? null} onSelect={onSelect} />
    ));

    const firstButton = screen.getByRole('button', { name: /Agent 0/i });
    const buttonRow = firstButton.parentElement;

    expect(buttonRow?.getAttribute('style')).toContain('flex-wrap:wrap');
    expect(firstButton.getAttribute('style')).toContain('flex: 0 1 auto');
    expect(firstButton.getAttribute('style')).toContain('min-width: 70px');
  });

  it('selects an agent when its button is clicked', () => {
    resetStoreForTest();
    const onSelect = vi.fn();
    const agents = [
      createTestAgentDef({ id: 'agent-0', name: 'Agent 0' }),
      createTestAgentDef({ id: 'agent-1', name: 'Agent 1' }),
    ];

    render(() => (
      <AgentSelector agents={agents} selectedAgent={agents[0] ?? null} onSelect={onSelect} />
    ));

    fireEvent.click(screen.getByRole('button', { name: /Agent 1/i }));

    expect(onSelect).toHaveBeenCalledWith(agents[1]);
  });
});
