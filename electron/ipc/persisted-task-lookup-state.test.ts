import { describe, expect, it } from 'vitest';
import { parsePersistedTaskLookupState } from './persisted-task-lookup-state.js';

describe('persisted-task-lookup-state', () => {
  it('keeps only string lookup fields from saved state and preserves explicit isolation fields', () => {
    expect(
      parsePersistedTaskLookupState(
        JSON.stringify({
          projects: [
            {
              id: 'project-1',
              path: '/repo',
              baseBranch: ' personal/main ',
              defaultTaskGitIsolation: 'current-branch',
            },
            { id: 7, path: '/ignored' },
          ],
          tasks: {
            kept: {
              baseBranch: ' personal/main ',
              branchName: 'feature/test',
              gitIsolation: 'existing-worktree',
              githubUrl: 'https://github.com/example/repo/pull/12',
              id: 'task-1',
              name: 'Task One',
              projectId: 'project-1',
              worktreeOwnership: 'external',
              worktreePath: '/repo/task-1',
            },
            partial: {
              directMode: true,
              id: 'task-2',
              name: 'Task Two',
              projectId: 4,
            },
            ignored: 'not-an-object',
          },
        }),
      ),
    ).toEqual({
      projects: [
        {
          baseBranch: 'personal/main',
          defaultTaskGitIsolation: 'current-branch',
          id: 'project-1',
          path: '/repo',
        },
      ],
      tasks: {
        kept: {
          baseBranch: 'personal/main',
          branchName: 'feature/test',
          gitIsolation: 'existing-worktree',
          githubUrl: 'https://github.com/example/repo/pull/12',
          id: 'task-1',
          name: 'Task One',
          projectId: 'project-1',
          worktreeOwnership: 'external',
          worktreePath: '/repo/task-1',
        },
        partial: {
          gitIsolation: 'current-branch',
          id: 'task-2',
          name: 'Task Two',
        },
      },
    });
  });

  it('recovers task ids from the task lookup key when the nested id is missing', () => {
    expect(
      parsePersistedTaskLookupState(
        JSON.stringify({
          projects: [
            {
              defaultDirectMode: true,
              id: 'project-1',
              path: '/repo',
              baseBranch: '',
            },
          ],
          tasks: {
            'task-from-key': {
              branchName: 'feature/test',
              name: 'Task One',
              projectId: 'project-1',
              worktreePath: '/repo/task-1',
            },
          },
        }),
      ),
    ).toEqual({
      projects: [
        {
          defaultTaskGitIsolation: 'current-branch',
          id: 'project-1',
          path: '/repo',
        },
      ],
      tasks: {
        'task-from-key': {
          branchName: 'feature/test',
          id: 'task-from-key',
          name: 'Task One',
          projectId: 'project-1',
          worktreePath: '/repo/task-1',
        },
      },
    });
  });

  it('returns empty lookup state for malformed json', () => {
    expect(parsePersistedTaskLookupState('{')).toEqual({
      projects: [],
      tasks: {},
    });
  });

  it('returns a fresh empty state for repeated malformed input', () => {
    const first = parsePersistedTaskLookupState('{');
    first.projects.push({ id: 'project-1', path: '/repo' });
    first.tasks.task = { id: 'task-1' };

    expect(parsePersistedTaskLookupState('{')).toEqual({
      projects: [],
      tasks: {},
    });
  });
});
