import { beforeEach, describe, expect, it } from 'vitest';

import { setStore, store } from './core';
import {
  computeSidebarActiveGroups,
  computeSidebarActiveOrder,
  reorderTaskOrderWithinSidebarGroup,
  SIDEBAR_ORPHANED_ACTIVE_GROUP_ID,
} from './sidebar-order';
import { createTestProject, createTestTask, resetStoreForTest } from '../test/store-test-helpers';

describe('sidebar-order', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('orders active tasks by project section order instead of raw taskOrder interleaving', () => {
    const projectA = createTestProject({ id: 'project-a', name: 'Project A' });
    const projectB = createTestProject({ id: 'project-b', name: 'Project B' });

    setStore('projects', [projectA, projectB]);
    setStore('tasks', {
      'task-a-1': createTestTask({ id: 'task-a-1', projectId: projectA.id }),
      'task-a-2': createTestTask({ id: 'task-a-2', projectId: projectA.id }),
      'task-b-1': createTestTask({ id: 'task-b-1', projectId: projectB.id }),
      'task-other': createTestTask({ id: 'task-other', projectId: undefined }),
    });
    setStore('taskOrder', ['task-a-1', 'task-b-1', 'task-other', 'task-a-2']);

    expect(computeSidebarActiveGroups()).toEqual([
      { groupId: projectA.id, projectId: projectA.id, taskIds: ['task-a-1', 'task-a-2'] },
      { groupId: projectB.id, projectId: projectB.id, taskIds: ['task-b-1'] },
      {
        groupId: SIDEBAR_ORPHANED_ACTIVE_GROUP_ID,
        projectId: null,
        taskIds: ['task-other'],
      },
    ]);
    expect(computeSidebarActiveOrder()).toEqual(['task-a-1', 'task-a-2', 'task-b-1', 'task-other']);
  });

  it('reorders a task within its visible project group while preserving other task positions', () => {
    const projectA = createTestProject({ id: 'project-a', name: 'Project A' });
    const projectB = createTestProject({ id: 'project-b', name: 'Project B' });

    setStore('projects', [projectA, projectB]);
    setStore('tasks', {
      'task-a-1': createTestTask({ id: 'task-a-1', projectId: projectA.id }),
      'task-a-2': createTestTask({ id: 'task-a-2', projectId: projectA.id }),
      'task-b-1': createTestTask({ id: 'task-b-1', projectId: projectB.id }),
      'task-other': createTestTask({ id: 'task-other', projectId: undefined }),
    });
    setStore('taskOrder', ['task-a-1', 'task-b-1', 'task-other', 'task-a-2']);

    expect(reorderTaskOrderWithinSidebarGroup('task-a-2', projectA.id, 0)).toEqual([
      'task-a-2',
      'task-b-1',
      'task-other',
      'task-a-1',
    ]);
  });

  it('reorders orphaned active tasks within the shared other group', () => {
    setStore('tasks', {
      'task-a': createTestTask({ id: 'task-a', projectId: undefined }),
      'task-b': createTestTask({ id: 'task-b', projectId: undefined }),
      'task-c': createTestTask({ id: 'task-c', projectId: undefined }),
    });
    setStore('taskOrder', ['task-a', 'task-b', 'task-c']);

    expect(
      reorderTaskOrderWithinSidebarGroup('task-c', SIDEBAR_ORPHANED_ACTIVE_GROUP_ID, 1),
    ).toEqual(['task-a', 'task-c', 'task-b']);
  });

  it('ignores cross-group reorder attempts', () => {
    const projectA = createTestProject({ id: 'project-a', name: 'Project A' });
    const projectB = createTestProject({ id: 'project-b', name: 'Project B' });

    setStore('projects', [projectA, projectB]);
    setStore('tasks', {
      'task-a-1': createTestTask({ id: 'task-a-1', projectId: projectA.id }),
      'task-b-1': createTestTask({ id: 'task-b-1', projectId: projectB.id }),
    });
    setStore('taskOrder', ['task-a-1', 'task-b-1']);

    expect(reorderTaskOrderWithinSidebarGroup('task-a-1', projectB.id, 0)).toBeNull();
    expect(store.taskOrder).toEqual(['task-a-1', 'task-b-1']);
  });
});
