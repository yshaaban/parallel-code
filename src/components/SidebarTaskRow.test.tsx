import { render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { focusSidebarMock, setActiveTaskMock, uncollapseTaskMock } = vi.hoisted(() => ({
  focusSidebarMock: vi.fn(),
  setActiveTaskMock: vi.fn(),
  uncollapseTaskMock: vi.fn(),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  const presentation = await vi.importActual<typeof import('../app/task-presentation-status')>(
    '../app/task-presentation-status',
  );
  return {
    focusSidebar: focusSidebarMock,
    getTaskDotStatus: presentation.getTaskDotStatus,
    setActiveTask: setActiveTaskMock,
    store: core.store,
    uncollapseTask: uncollapseTaskMock,
  };
});

import { SidebarTaskRow } from './SidebarTaskRow';

describe('SidebarTaskRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T12:00:00Z'));
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'] }),
    });
    setStore('agents', {
      'agent-1': createTestAgent(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders waiting-input attention inline with the task row', () => {
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'waiting-input',
        isShell: false,
        lastOutputAt: Date.now(),
        preview: 'Proceed? [Y/n]',
        state: 'awaiting-input',
        taskId: 'task-1',
        updatedAt: Date.now(),
      },
    });

    render(() => (
      <SidebarTaskRow
        taskId="task-1"
        globalIndex={() => 0}
        dragFromIndex={() => null}
        dropTargetIndex={() => null}
      />
    ));

    expect(screen.getByText('Waiting')).toBeDefined();
    expect(screen.getByText('Proceed? [Y/n]')).toBeDefined();
  });

  it('shows quiet tasks as a subtle elapsed age instead of a separate label', () => {
    setStore('agentSupervision', {
      'agent-1': {
        agentId: 'agent-1',
        attentionReason: 'quiet-too-long',
        isShell: false,
        lastOutputAt: Date.now() - 49_000,
        preview: '',
        state: 'quiet',
        taskId: 'task-1',
        updatedAt: Date.now(),
      },
    });

    render(() => (
      <SidebarTaskRow
        taskId="task-1"
        globalIndex={() => 0}
        dragFromIndex={() => null}
        dropTargetIndex={() => null}
      />
    ));

    expect(screen.getByText('49s')).toBeDefined();
    expect(screen.queryByText('Quiet')).toBeNull();
  });
});
