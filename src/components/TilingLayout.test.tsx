import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { For, type JSX } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAppStartupPresentation,
  completeAppStartupPresentation,
  resetAppStartupStatusForTests,
} from '../app/app-startup-status';
import {
  createTaskOptimistically,
  resetPendingTaskCreationsForTests,
} from '../app/task-creation-optimism';
import { resetWorkspaceShapeCacheForTests } from '../app/workspace-shape-cache';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    closeTerminal: vi.fn(),
    store: core.store,
    toggleAddProjectDialog: vi.fn(),
  };
});

vi.mock('../app/task-workflows', () => ({
  closeTask: vi.fn(),
}));

vi.mock('./TaskPanel', () => ({
  TaskPanel: (props: { task: { id: string } }) => <div data-test-task-panel={props.task.id} />,
}));

vi.mock('./TerminalPanel', () => ({
  TerminalPanel: () => <div data-test-terminal-panel="true" />,
}));

vi.mock('./NewTaskPlaceholder', () => ({
  NewTaskPlaceholder: () => <div data-test-new-task-placeholder="true" />,
}));

vi.mock('./ResizablePanel', () => ({
  ResizablePanel: (props: { children: { content: () => JSX.Element; id: string }[] }) => (
    <div data-test-resizable-panel="true">
      <For each={props.children}>
        {(child) => <div data-test-panel-child={child.id}>{child.content()}</div>}
      </For>
    </div>
  ),
}));

import { TilingLayout } from './TilingLayout';

const FIRST_RUN_PROJECT_COPY = 'Link your first project to get started';
const FIRST_RUN_TASK_COPY = 'No tasks yet';

function cacheWorkspaceShape(taskNames: string[], projectCount = 1): void {
  localStorage.setItem(
    `parallel-code:workspace-shape:v1:${globalThis.location.origin}`,
    JSON.stringify({
      projectCount,
      taskNames,
      updatedAtMs: Date.now(),
      version: 1,
    }),
  );
}

function getGhostColumnCount(container: HTMLElement): number {
  return container.querySelector('[data-startup-skeleton="true"]')?.childElementCount ?? 0;
}

describe('TilingLayout', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetAppStartupStatusForTests();
    resetPendingTaskCreationsForTests();
    resetWorkspaceShapeCacheForTests();
  });

  afterEach(() => {
    cleanup();
    resetPendingTaskCreationsForTests();
    resetWorkspaceShapeCacheForTests();
    resetAppStartupStatusForTests();
    resetStoreForTest();
  });

  it('never shows first-run onboarding to a returning user while startup is pending', () => {
    cacheWorkspaceShape(['Fix parser', 'Write docs', 'Ship release']);
    beginAppStartupPresentation();

    const result = render(() => <TilingLayout />);

    expect(result.container.querySelector('[data-startup-skeleton="true"]')).not.toBeNull();
    expect(getGhostColumnCount(result.container)).toBe(3);
    expect(screen.queryByText(FIRST_RUN_TASK_COPY)).toBeNull();
    expect(screen.queryByText(FIRST_RUN_PROJECT_COPY)).toBeNull();
  });

  it('keeps first-run onboarding for users without a cached workspace shape', () => {
    beginAppStartupPresentation();

    const result = render(() => <TilingLayout />);

    expect(result.container.querySelector('[data-startup-skeleton="true"]')).toBeNull();
    expect(screen.queryByText(FIRST_RUN_PROJECT_COPY)).not.toBeNull();
  });

  it('clamps the ghost column count to the skeleton maximum', () => {
    cacheWorkspaceShape(Array.from({ length: 30 }, (_, index) => `Task ${index}`));
    beginAppStartupPresentation();

    const result = render(() => <TilingLayout />);

    expect(getGhostColumnCount(result.container)).toBe(12);
  });

  it('exits to onboarding when startup completes and the workspace is genuinely empty', async () => {
    cacheWorkspaceShape(['Stale task']);
    beginAppStartupPresentation();
    const result = render(() => <TilingLayout />);
    expect(screen.queryByText(FIRST_RUN_PROJECT_COPY)).toBeNull();

    completeAppStartupPresentation();

    await waitFor(() => {
      expect(screen.queryByText(FIRST_RUN_PROJECT_COPY)).not.toBeNull();
    });
    expect(result.container.querySelector('[data-startup-skeleton="true"]')).toBeNull();
  });

  it('exits to the No tasks yet onboarding after startup completes with a linked project', async () => {
    cacheWorkspaceShape(['Stale task']);
    setStore('projects', [createTestProject()]);
    beginAppStartupPresentation();
    render(() => <TilingLayout />);
    expect(screen.queryByText(FIRST_RUN_TASK_COPY)).toBeNull();

    completeAppStartupPresentation();

    await waitFor(() => {
      expect(screen.queryByText(FIRST_RUN_TASK_COPY)).not.toBeNull();
    });
  });

  it('swaps the skeleton for real task columns the moment workspace shape lands', async () => {
    cacheWorkspaceShape(['Fix parser']);
    beginAppStartupPresentation();
    const result = render(() => <TilingLayout />);
    expect(result.container.querySelector('[data-startup-skeleton="true"]')).not.toBeNull();

    setStore('tasks', 'task-1', createTestTask({ id: 'task-1' }));
    setStore('taskOrder', ['task-1']);

    await waitFor(() => {
      expect(result.container.querySelector('[data-test-task-panel="task-1"]')).not.toBeNull();
    });
    expect(result.container.querySelector('[data-startup-skeleton="true"]')).toBeNull();
    expect(screen.queryByText(FIRST_RUN_TASK_COPY)).toBeNull();
  });

  it('survives repeated startup presentation churn deterministically', async () => {
    cacheWorkspaceShape(['Fix parser']);
    const result = render(() => <TilingLayout />);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      beginAppStartupPresentation();
      await waitFor(() => {
        expect(result.container.querySelector('[data-startup-skeleton="true"]')).not.toBeNull();
      });

      completeAppStartupPresentation();
      await waitFor(() => {
        expect(result.container.querySelector('[data-startup-skeleton="true"]')).toBeNull();
      });
      expect(screen.queryByText(FIRST_RUN_PROJECT_COPY)).not.toBeNull();
    }
  });

  it('renders a provisional column for an in-flight creation and swaps it for the real task', async () => {
    setStore('projects', [createTestProject()]);
    let resolveCreate: (taskId: string) => void = () => {};
    const pendingId = createTaskOptimistically({
      agentDefName: 'Claude',
      name: 'Instant task',
      projectId: 'project-1',
      run: () =>
        new Promise<string>((resolve) => {
          resolveCreate = (taskId) => {
            setStore('tasks', taskId, createTestTask({ id: taskId, name: 'Instant task' }));
            setStore('taskOrder', [taskId]);
            resolve(taskId);
          };
        }),
    });

    const result = render(() => <TilingLayout />);

    const pendingColumn = result.container.querySelector(`[data-pending-task-id="${pendingId}"]`);
    expect(pendingColumn).not.toBeNull();
    expect(pendingColumn?.getAttribute('data-pending-task-state')).toBe('creating');
    expect(screen.queryByText(FIRST_RUN_TASK_COPY)).toBeNull();

    resolveCreate('task-real');
    await waitFor(() => {
      expect(result.container.querySelector('[data-test-task-panel="task-real"]')).not.toBeNull();
    });
    expect(result.container.querySelector(`[data-pending-task-id="${pendingId}"]`)).toBeNull();
  });

  it('shows the on-card error with Retry and Dismiss when creation fails', async () => {
    let rejectCreate: (error: unknown) => void = () => {};
    let attempt = 0;
    const pendingId = createTaskOptimistically({
      agentDefName: 'Claude',
      name: 'Fragile task',
      projectId: 'project-1',
      run: () => {
        attempt += 1;
        return new Promise<string>((_resolve, reject) => {
          rejectCreate = reject;
        });
      },
    });

    const result = render(() => <TilingLayout />);
    rejectCreate(new Error('Worktree creation failed'));

    await waitFor(() => {
      expect(
        result.container
          .querySelector(`[data-pending-task-id="${pendingId}"]`)
          ?.getAttribute('data-pending-task-state'),
      ).toBe('error');
    });
    expect(screen.getByText('Worktree creation failed')).toBeDefined();

    fireEvent.click(screen.getByText('Retry'));
    expect(attempt).toBe(2);
    await waitFor(() => {
      expect(
        result.container
          .querySelector(`[data-pending-task-id="${pendingId}"]`)
          ?.getAttribute('data-pending-task-state'),
      ).toBe('creating');
    });

    rejectCreate(new Error('Worktree creation failed'));
    await screen.findByText('Dismiss');
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => {
      expect(result.container.querySelector(`[data-pending-task-id="${pendingId}"]`)).toBeNull();
    });
  });
});
