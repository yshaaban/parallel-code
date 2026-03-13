import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskAttentionEntry } from '../app/task-attention';
import { setStore } from '../store/core';
import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { setActiveAgentMock, setActiveTaskMock, setTaskFocusedPanelMock, unfocusSidebarMock } =
  vi.hoisted(() => ({
    setActiveAgentMock: vi.fn(),
    setActiveTaskMock: vi.fn(),
    setTaskFocusedPanelMock: vi.fn(),
    unfocusSidebarMock: vi.fn(),
  }));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    setActiveAgent: setActiveAgentMock,
    setActiveTask: setActiveTaskMock,
    setTaskFocusedPanel: setTaskFocusedPanelMock,
    store: core.store,
    unfocusSidebar: unfocusSidebarMock,
  };
});

import { AttentionInbox } from './AttentionInbox';

describe('AttentionInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    setStore('tasks', {
      'task-1': createTestTask(),
      'task-2': createTestTask({ id: 'task-2', name: 'Second task' }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
      'agent-2': createTestAgent({
        id: 'agent-2',
        taskId: 'task-2',
      }),
    });
  });

  it('renders grouped attention entries', () => {
    const entries: TaskAttentionEntry[] = [
      {
        agentId: 'agent-1',
        dotStatus: 'waiting',
        focusPanel: 'ai-terminal',
        group: 'needs-action',
        label: 'Waiting',
        lastOutputAt: 1_000,
        preview: 'Proceed? [Y/n]',
        reason: 'waiting-input',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
      {
        agentId: 'agent-2',
        dotStatus: 'busy',
        focusPanel: 'ai-terminal',
        group: 'quiet',
        label: 'Quiet',
        lastOutputAt: 500,
        preview: 'No recent output',
        reason: 'quiet-too-long',
        state: 'quiet',
        taskId: 'task-2',
        updatedAt: 1_500,
      },
    ];

    render(() => <AttentionInbox entries={() => entries} />);

    expect(screen.getByText('Attention')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('Needs Action')).toBeDefined();
    expect(screen.getAllByText('Quiet')).toHaveLength(2);
    expect(screen.getByText('Task')).toBeDefined();
    expect(screen.getByText('Second task')).toBeDefined();
  });

  it('activates the task and focuses the relevant panel when clicked', () => {
    const entries: TaskAttentionEntry[] = [
      {
        agentId: 'agent-1',
        dotStatus: 'ready',
        focusPanel: 'prompt',
        group: 'ready',
        label: 'Ready',
        lastOutputAt: 1_000,
        preview: 'Ready for next step',
        reason: 'ready-for-next-step',
        state: 'idle-at-prompt',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
    ];

    render(() => <AttentionInbox entries={() => entries} />);

    const button = screen.getByText('Ready for next step').closest('button');
    expect(button).toBeTruthy();
    fireEvent.click(button as HTMLButtonElement);

    expect(setActiveTaskMock).toHaveBeenCalledWith('task-1');
    expect(setActiveAgentMock).toHaveBeenCalledWith('agent-1');
    expect(unfocusSidebarMock).toHaveBeenCalledTimes(1);
    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'prompt');
  });

  it('routes waiting-input entries to the AI terminal', () => {
    const entries: TaskAttentionEntry[] = [
      {
        agentId: 'agent-1',
        dotStatus: 'waiting',
        focusPanel: 'ai-terminal',
        group: 'needs-action',
        label: 'Waiting',
        lastOutputAt: 1_000,
        preview: 'Proceed? [Y/n]',
        reason: 'waiting-input',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: 2_000,
      },
    ];

    render(() => <AttentionInbox entries={() => entries} />);

    const button = screen.getByText('Proceed? [Y/n]').closest('button');
    expect(button).toBeTruthy();
    fireEvent.click(button as HTMLButtonElement);

    expect(setTaskFocusedPanelMock).toHaveBeenCalledWith('task-1', 'ai-terminal');
  });
});
