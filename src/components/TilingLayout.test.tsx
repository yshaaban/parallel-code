import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { For, untrack, type JSX } from 'solid-js';
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
import { publishUnsavedDesktopTaskNotes } from '../app/task-notes-recovery-channel';
import { setStore } from '../store/core';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

const { closeTaskMock, confirmMock, crashingTaskIds } = vi.hoisted(() => ({
  closeTaskMock: vi.fn(),
  confirmMock: vi.fn(),
  crashingTaskIds: new Set<string>(),
}));

vi.mock('../store/store', async () => {
  const core = await vi.importActual<typeof import('../store/core')>('../store/core');
  return {
    closeTerminal: vi.fn(),
    store: core.store,
    toggleAddProjectDialog: vi.fn(),
  };
});

vi.mock('../app/task-workflows', () => ({
  closeTask: closeTaskMock,
}));

vi.mock('../lib/dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('./TaskPanel', () => ({
  TaskPanel: (props: { task: { id: string } }) => {
    const taskId = untrack(() => props.task.id);
    if (crashingTaskIds.has(taskId)) {
      throw new Error('render failed');
    }
    return <div data-test-task-panel={taskId} />;
  },
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

function stubReducedMotion(matches: boolean): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  return matchMedia;
}

function dispatchAnimation(
  target: Element,
  type: 'animationcancel' | 'animationend',
  name: string,
) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: name });
  target.dispatchEvent(event);
}

function requireElement<T extends Element>(element: T | null | undefined, label: string): T {
  if (!element) {
    throw new Error(`Missing ${label}`);
  }
  return element;
}

describe('TilingLayout', () => {
  beforeEach(() => {
    closeTaskMock.mockReset();
    publishUnsavedDesktopTaskNotes([]);
    confirmMock.mockReset();
    crashingTaskIds.clear();
    resetStoreForTest();
    resetAppStartupStatusForTests();
    resetPendingTaskCreationsForTests();
    resetWorkspaceShapeCacheForTests();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetPendingTaskCreationsForTests();
    resetWorkspaceShapeCacheForTests();
    resetAppStartupStatusForTests();
    resetStoreForTest();
  });

  it('clears a panel appearance class only for its own completed animation', () => {
    const matchMedia = stubReducedMotion(false);
    setStore('tasks', 'task-1', createTestTask({ id: 'task-1' }));
    setStore('taskOrder', ['task-1']);

    const result = render(() => <TilingLayout />);
    const panel = requireElement(
      result.container.querySelector<HTMLElement>('[data-task-id="task-1"]'),
      'task panel',
    );
    const nested = requireElement(
      panel.querySelector('[data-test-task-panel="task-1"]'),
      'nested task content',
    );
    expect(panel.classList.contains('task-appearing')).toBe(true);
    expect(matchMedia).toHaveBeenCalledTimes(1);

    dispatchAnimation(nested, 'animationend', 'taskAppear');
    expect(panel.classList.contains('task-appearing')).toBe(true);

    dispatchAnimation(panel, 'animationend', 'unrelatedAnimation');
    expect(panel.classList.contains('task-appearing')).toBe(true);

    dispatchAnimation(panel, 'animationend', 'taskAppear');
    expect(panel.classList.contains('task-appearing')).toBe(false);
  });

  it('does not seed panel appearance under reduced motion and clears cancellation permanently', () => {
    const matchMedia = stubReducedMotion(true);
    setStore('tasks', 'task-1', createTestTask({ id: 'task-1' }));
    setStore('taskOrder', ['task-1']);

    const reducedResult = render(() => <TilingLayout />);
    const reducedPanel =
      reducedResult.container.querySelector<HTMLElement>('[data-task-id="task-1"]');
    expect(reducedPanel?.classList.contains('task-appearing')).toBe(false);
    expect(matchMedia).toHaveBeenCalledTimes(1);

    cleanup();
    vi.unstubAllGlobals();
    stubReducedMotion(false);
    const animatedResult = render(() => <TilingLayout />);
    const animatedPanel = requireElement(
      animatedResult.container.querySelector<HTMLElement>('[data-task-id="task-1"]'),
      'animated task panel',
    );
    expect(animatedPanel.classList.contains('task-appearing')).toBe(true);
    dispatchAnimation(animatedPanel, 'animationcancel', 'taskAppear');
    expect(animatedPanel.classList.contains('task-appearing')).toBe(false);

    // A later preference change has no listener that can replay a stale entry animation.
    stubReducedMotion(false);
    expect(animatedPanel.classList.contains('task-appearing')).toBe(false);
  });

  it('gives removal precedence over a pending appearance animation', async () => {
    stubReducedMotion(false);
    setStore('tasks', 'task-1', createTestTask({ id: 'task-1' }));
    setStore('taskOrder', ['task-1']);
    const result = render(() => <TilingLayout />);
    const panel = result.container.querySelector<HTMLElement>('[data-task-id="task-1"]');
    expect(panel?.classList.contains('task-appearing')).toBe(true);

    setStore('tasks', 'task-1', 'closeState', { kind: 'removing' });

    await waitFor(() => expect(panel?.classList.contains('task-removing')).toBe(true));
    expect(panel?.classList.contains('task-appearing')).toBe(false);
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
      launchLabel: 'Claude',
      name: 'Instant task',
      projectId: 'project-1',
      taskMode: 'agent',
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
      launchLabel: 'Claude',
      name: 'Fragile task',
      projectId: 'project-1',
      taskMode: 'agent',
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

  it('subtly flags project-root intent on a pending task column', () => {
    const pendingId = createTaskOptimistically({
      baseBranch: 'main',
      gitIsolation: 'current-branch',
      launchLabel: 'Terminal',
      name: 'Terminal',
      projectId: 'project-1',
      run: () => new Promise<string>(() => {}),
      taskMode: 'terminal',
    });

    const result = render(() => <TilingLayout />);

    const pendingColumn = result.container.querySelector(`[data-pending-task-id="${pendingId}"]`);
    expect(pendingColumn).not.toBeNull();
    expect(
      screen.getByLabelText(/Works directly in the project root; shares files and Git state/),
    ).toBeDefined();
    expect(screen.getByText('root')).toBeDefined();
  });

  it.each([
    {
      expected:
        'Close this task? Running shells will be stopped. The existing worktree and branch will be kept.',
      task: createTestTask({
        agentIds: [],
        gitIsolation: 'existing-worktree',
        id: 'task-existing',
        shellAgentIds: ['shell-1'],
        taskMode: 'terminal',
        worktreeOwnership: 'external',
      }),
    },
    {
      expected:
        'Close this task? Running shells will be stopped. No git operations will be performed.',
      task: createTestTask({
        agentIds: [],
        gitIsolation: 'current-branch',
        id: 'task-root',
        shellAgentIds: ['shell-1'],
        taskMode: 'terminal',
      }),
    },
  ])('uses truthful emergency-close copy for $task.id', async ({ expected, task }) => {
    setStore('projects', [createTestProject({ id: task.projectId })]);
    setStore('tasks', { [task.id]: task });
    setStore('taskOrder', [task.id]);
    crashingTaskIds.add(task.id);
    confirmMock.mockResolvedValue(false);

    render(() => <TilingLayout />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close Task' }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledWith(expected));
    expect(closeTaskMock).not.toHaveBeenCalled();
  });

  it('includes unsaved task notes in the emergency-close confirmation', async () => {
    const task = createTestTask({ id: 'task-with-notes' });
    setStore('projects', [createTestProject({ id: task.projectId })]);
    setStore('tasks', { [task.id]: task });
    setStore('taskOrder', [task.id]);
    crashingTaskIds.add(task.id);
    publishUnsavedDesktopTaskNotes([task.id]);
    confirmMock.mockResolvedValue(true);

    render(() => <TilingLayout />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close Task' }));

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Unsaved task notes')),
    );
    expect(closeTaskMock).toHaveBeenCalledWith(task.id, {
      taskNotesDiscardConfirmed: true,
    });
  });
});
