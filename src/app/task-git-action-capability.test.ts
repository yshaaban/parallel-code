import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestTask } from '../test/store-test-helpers';
import type { Project, Task } from '../store/types';

const { isProjectMissingMock, setPendingActionMock, showNotificationMock, store } = vi.hoisted(
  () => ({
    isProjectMissingMock: vi.fn(() => false),
    setPendingActionMock: vi.fn(),
    showNotificationMock: vi.fn(),
    store: {
      pendingAction: null as { taskId: string; type: 'close' | 'merge' | 'push' } | null,
      projects: [] as Project[],
      tasks: {} as Record<string, Task | undefined>,
    },
  }),
);

vi.mock('../store/state', () => ({ store }));
vi.mock('../store/focus', () => ({ setPendingAction: setPendingActionMock }));
vi.mock('../store/notification', () => ({ showNotification: showNotificationMock }));
vi.mock('../store/projects', () => ({
  getProject: (projectId: string) => store.projects.find((project) => project.id === projectId),
  isProjectMissing: isProjectMissingMock,
}));

import {
  getTaskGitActionDecision,
  requestTaskGitAction,
  type TaskGitAction,
  type TaskGitActionDenialReason,
} from './task-git-action-capability';

function decisionReason(
  action: TaskGitAction,
  task: Task | undefined,
  projectPathAvailable = true,
): TaskGitActionDenialReason | 'allowed' {
  const decision = getTaskGitActionDecision(action, task, { projectPathAvailable });
  return decision.allowed ? 'allowed' : decision.reason;
}

describe('task Git action capability', () => {
  beforeEach(() => {
    store.pendingAction = null;
    store.projects = [{ color: '#fff', id: 'project-1', name: 'Project', path: '/repo/project' }];
    store.tasks = { 'task-1': createTestTask() };
    isProjectMissingMock.mockReset();
    isProjectMissingMock.mockReturnValue(false);
    setPendingActionMock.mockReset();
    showNotificationMock.mockReset();
  });

  it.each(['merge', 'push'] as const)(
    'returns every denial reason in stable precedence for %s',
    (action) => {
      const allowed = createTestTask();
      const cases: Array<[Task | undefined, boolean, TaskGitActionDenialReason]> = [
        [undefined, false, 'task_missing'],
        [
          createTestTask({ closeState: { kind: 'closing' }, collapsed: true }),
          false,
          'task_closing',
        ],
        [createTestTask({ closeState: { kind: 'removing' } }), true, 'task_closing'],
        [createTestTask({ collapsed: true, projectMode: 'non-git' }), false, 'task_collapsed'],
        [allowed, false, 'project_missing'],
        [createTestTask({ projectMode: 'non-git' }), true, 'non_git_task'],
        [createTestTask({ gitIsolation: 'current-branch' }), true, 'project_root_task'],
      ];

      for (const [task, projectPathAvailable, reason] of cases) {
        expect(decisionReason(action, task, projectPathAvailable)).toBe(reason);
      }
    },
  );

  it.each(['merge', 'push'] as const)(
    'allows managed and imported worktrees for %s without side effects',
    (action) => {
      expect(decisionReason(action, createTestTask({ gitIsolation: 'worktree' }))).toBe('allowed');
      expect(decisionReason(action, createTestTask({ gitIsolation: 'existing-worktree' }))).toBe(
        'allowed',
      );
      expect(setPendingActionMock).not.toHaveBeenCalled();
      expect(showNotificationMock).not.toHaveBeenCalled();
    },
  );

  it('notifies once and queues nothing for a denied intent', () => {
    store.tasks['task-1'] = createTestTask({ projectMode: 'non-git' });

    const result = requestTaskGitAction('merge', 'task-1', 'shortcut');

    expect(result).toMatchObject({ allowed: false, reason: 'non_git_task' });
    expect(showNotificationMock).toHaveBeenCalledOnce();
    expect(showNotificationMock).toHaveBeenCalledWith("Merge isn't available for non-Git tasks.", {
      kind: 'warning',
    });
    expect(setPendingActionMock).not.toHaveBeenCalled();
  });

  it('queues an admitted intent once and deduplicates an identical pending action', () => {
    expect(requestTaskGitAction('push', 'task-1', 'title-bar')).toEqual({ allowed: true });
    expect(setPendingActionMock).toHaveBeenCalledWith({ taskId: 'task-1', type: 'push' });

    setPendingActionMock.mockClear();
    store.pendingAction = { taskId: 'task-1', type: 'push' };
    expect(requestTaskGitAction('push', 'task-1', 'shortcut')).toEqual({ allowed: true });
    expect(setPendingActionMock).not.toHaveBeenCalled();
    expect(showNotificationMock).not.toHaveBeenCalled();
  });

  it('treats a missing or backend-invalidated project path as unavailable', () => {
    store.projects = [];
    expect(requestTaskGitAction('push', 'task-1', 'shortcut')).toMatchObject({
      allowed: false,
      reason: 'project_missing',
    });

    store.projects = [{ color: '#fff', id: 'project-1', name: 'Project', path: '/repo/project' }];
    isProjectMissingMock.mockReturnValue(true);
    expect(requestTaskGitAction('push', 'task-1', 'shortcut')).toMatchObject({
      allowed: false,
      reason: 'project_missing',
    });
  });
});
