import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestAgent,
  createTestAgentDef,
  createTestTask,
  resetStoreForTest,
} from '../../test/store-test-helpers';
import { setStore } from '../../store/core';
import { TaskAiTerminalSection } from './TaskAiTerminalSection';

vi.mock('../TerminalView', () => ({
  TerminalView: (props: { agentId: string }) => <div>Terminal {props.agentId}</div>,
}));

vi.mock('../AgentSwitchMenu', () => ({
  AgentSwitchMenu: () => <button type="button">Switch agent</button>,
}));

describe('TaskAiTerminalSection', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the selected task agent instead of assuming the first agent', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-2',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({
        def: createTestAgentDef({ id: 'claude', name: 'Claude' }),
        id: 'agent-1',
        taskId: 'task-1',
      }),
      'agent-2': createTestAgent({
        def: createTestAgentDef({ id: 'codex', name: 'Codex' }),
        id: 'agent-2',
        taskId: 'task-1',
      }),
    });

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(screen.getByText('Terminal agent-2')).toBeDefined();
    expect(screen.queryByText('Terminal agent-1')).toBeNull();
  });

  it('lets the active agent override stale selected-agent metadata for the active task', () => {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      selectedAgentId: 'agent-1',
    });
    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-1' }),
    });
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-2');

    render(() => (
      <TaskAiTerminalSection isActive={() => true} onReuseLastPrompt={vi.fn()} task={() => task} />
    ));

    expect(screen.getByText('Terminal agent-2')).toBeDefined();
  });
});
