import { describe, expect, it } from 'vitest';

import { createTestProject, createTestTask } from '../test/store-test-helpers';
import {
  getEmergencyTaskCloseMessage,
  getProjectRemovalTaskCloseMessage,
  getTaskClosePolicy,
} from './task-close-policy';

describe('task close policy', () => {
  it.each([
    {
      expected:
        'Close this task? Running shells will be stopped. No git operations will be performed.',
      location: 'project-root',
      project: createTestProject(),
      task: createTestTask({
        agentIds: [],
        gitIsolation: 'current-branch',
        shellAgentIds: ['shell-1'],
        taskMode: 'terminal',
      }),
    },
    {
      expected:
        'Close this task? Running shells will be stopped. No git operations will be performed.',
      location: 'non-git',
      project: createTestProject({ projectMode: 'non-git' }),
      task: createTestTask({
        agentIds: [],
        projectMode: 'non-git',
        shellAgentIds: ['shell-1'],
        taskMode: 'terminal',
      }),
    },
    {
      expected:
        'Close this task? Running shells will be stopped. The existing worktree and branch will be kept.',
      location: 'existing-worktree',
      project: createTestProject(),
      task: createTestTask({
        agentIds: [],
        gitIsolation: 'existing-worktree',
        shellAgentIds: ['shell-1'],
        taskMode: 'terminal',
        worktreeOwnership: 'external',
      }),
    },
    {
      expected:
        'Close this task? Running agents and shells will be stopped. The worktree and branch will be deleted.',
      location: 'managed-worktree',
      project: createTestProject({ deleteBranchOnClose: true }),
      task: createTestTask(),
    },
    {
      expected:
        'Close this task? Running agents and shells will be stopped. The worktree will be removed and the branch will be kept.',
      location: 'managed-worktree',
      project: createTestProject({ deleteBranchOnClose: false }),
      task: createTestTask(),
    },
  ] as const)('describes $location cleanup truthfully', ({ expected, location, project, task }) => {
    expect(getTaskClosePolicy(task, project).location).toBe(location);
    expect(getEmergencyTaskCloseMessage(task, project)).toBe(expected);
  });

  it('preserves legacy externally owned worktrees even without an explicit isolation value', () => {
    const task = createTestTask({ gitIsolation: undefined, worktreeOwnership: 'external' });

    expect(getTaskClosePolicy(task, createTestProject()).location).toBe('existing-worktree');
  });

  it.each([
    [
      1,
      'This project has 1 open task. Removing the project will close it. Managed worktrees will be removed. Project-root folders and existing worktrees will be kept; managed branches will be deleted only when configured.',
    ],
    [
      3,
      'This project has 3 open tasks. Removing the project will close them. Managed worktrees will be removed. Project-root folders and existing worktrees will be kept; managed branches will be deleted only when configured.',
    ],
  ] as const)('describes aggregate cleanup for %i open tasks', (taskCount, expected) => {
    expect(getProjectRemovalTaskCloseMessage(taskCount)).toBe(expected);
  });
});
