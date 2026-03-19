import { render, screen } from '@solidjs/testing-library';
import { For } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskConvergenceSnapshot } from '../domain/task-convergence';
import { setStore } from '../store/core';
import {
  registerTerminalStartupCandidate,
  setTerminalStartupPhase,
} from '../store/terminal-startup';
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

import { CollapsedSidebarTaskRow, SidebarTaskRow } from './SidebarTaskRow';

function renderSidebarTaskRow(): void {
  render(() => (
    <SidebarTaskRow
      dragState={() => null}
      dropTarget={() => null}
      groupId="project-1"
      groupIndex={0}
      taskId="task-1"
    />
  ));
}

function renderSidebarTaskRows(taskIds: string[]): void {
  render(() => (
    <>
      <For each={taskIds}>
        {(taskId) => (
          <SidebarTaskRow
            dragState={() => null}
            dropTarget={() => null}
            groupId="project-1"
            groupIndex={taskIds.indexOf(taskId)}
            taskId={taskId}
          />
        )}
      </For>
    </>
  ));
}

function renderCollapsedSidebarTaskRow(): void {
  render(() => <CollapsedSidebarTaskRow taskId="task-1" />);
}

function createTestConvergenceSnapshot(
  taskId: string,
  overrides: Partial<TaskConvergenceSnapshot> = {},
): TaskConvergenceSnapshot {
  return {
    branchFiles: ['src/app.ts'],
    branchName: `feature/${taskId}`,
    changedFileCount: 1,
    commitCount: 1,
    conflictingFiles: [],
    hasCommittedChanges: true,
    hasUncommittedChanges: false,
    mainAheadCount: 0,
    overlapWarnings: [],
    projectId: 'project-1',
    state: 'review-ready',
    summary: '1 commit, 1 file changed',
    taskId,
    totalAdded: 4,
    totalRemoved: 1,
    updatedAt: 1_000,
    worktreePath: `/tmp/${taskId}`,
    ...overrides,
  };
}

describe('SidebarTaskRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    vi.clearAllTimers();
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
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders waiting-input as a compact inline label without preview noise', () => {
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

    renderSidebarTaskRow();

    expect(screen.getByLabelText('Waiting')).toBeDefined();
    expect(screen.getByText('0s')).toBeDefined();
    expect(screen.queryByText('Proceed? [Y/n]')).toBeNull();
  });

  it('shows quiet tasks as a compact reliable idle duration', () => {
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

    renderSidebarTaskRow();

    expect(screen.getByLabelText('Quiet')).toBeDefined();
    expect(screen.getByText('49s')).toBeDefined();
    expect(screen.queryByText('Quiet')).toBeNull();
  });

  it('keeps lifecycle fallback attention visible when no reliable duration exists yet', () => {
    setStore('agentSupervision', {});
    setStore('agents', {
      'agent-1': createTestAgent({
        exitCode: 1,
        signal: 'spawn_failed',
        status: 'exited',
      }),
    });

    renderSidebarTaskRow();

    expect(screen.getByLabelText('Failed')).toBeDefined();
    expect(screen.queryByText('0s')).toBeNull();
  });

  it('renders a tiny glyph for the live primary agent', () => {
    setStore('agents', {
      'agent-1': createTestAgent({
        def: {
          id: 'gemini',
          name: 'Gemini CLI',
          command: 'gemini',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Gemini agent',
        },
      }),
    });

    renderSidebarTaskRow();

    expect(screen.getByLabelText('Gemini CLI agent')).toBeDefined();
  });

  it('renders the review state as an accessible colored dot', () => {
    setStore(
      'taskConvergence',
      'task-1',
      createTestConvergenceSnapshot('task-1', {
        state: 'merge-blocked',
      }),
    );

    renderSidebarTaskRow();

    expect(screen.getByLabelText('Blocked')).toBeDefined();
    expect(screen.queryByText('Blocked')).toBeNull();
  });

  it('renders a subtle startup badge while a task terminal is still attaching', () => {
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'attaching');

    renderSidebarTaskRow();

    expect(screen.getByLabelText('Attaching terminal…')).toBeDefined();
  });

  it('keeps the active task visibly highlighted even when the sidebar is not focused', () => {
    setStore('activeTaskId', 'task-1');

    renderSidebarTaskRow();

    const taskLabel = screen.getByText('Task');
    const row = taskLabel.closest('[data-sidebar-task-id="task-1"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('style')).toContain('var(--bg-selected)');
    expect(row?.getAttribute('style')).toContain('inset 3px 0 0 var(--accent)');
    expect(row?.getAttribute('style')).toContain(
      '0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent)',
    );
  });

  it('does not make a different sidebar-focused task look fully selected on initial load', () => {
    setStore('tasks', {
      'task-1': createTestTask({ agentIds: ['agent-1'], name: 'Task One' }),
      'task-2': createTestTask({ agentIds: ['agent-2'], id: 'task-2', name: 'Task Two' }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-2' }),
    });
    setStore('activeTaskId', 'task-1');
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedTaskId', 'task-2');

    renderSidebarTaskRows(['task-1', 'task-2']);

    const activeRow = screen.getByText('Task One').closest('[data-sidebar-task-id="task-1"]');
    const focusedRow = screen.getByText('Task Two').closest('[data-sidebar-task-id="task-2"]');

    expect(activeRow).not.toBeNull();
    expect(focusedRow).not.toBeNull();
    expect(activeRow?.getAttribute('style')).toContain('var(--bg-selected)');
    expect(focusedRow?.getAttribute('style')).toContain(
      'color-mix(in srgb, var(--border-focus) 10%, transparent)',
    );
    expect(focusedRow?.getAttribute('style')).not.toContain('var(--bg-selected)');
  });

  it('hides the review dot when the review state has no visible label', () => {
    setStore(
      'taskConvergence',
      'task-1',
      createTestConvergenceSnapshot('task-1', {
        state: 'no-changes',
      }),
    );

    renderSidebarTaskRow();

    expect(screen.queryByLabelText('No changes')).toBeNull();
  });

  it('uses saved agent metadata for collapsed tasks without a live agent', () => {
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        savedAgentDef: {
          id: 'claude-code',
          name: 'Claude Code',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
      }),
    });
    setStore('agents', {});

    renderCollapsedSidebarTaskRow();

    expect(screen.getByLabelText('Claude Code agent')).toBeDefined();
  });
});
