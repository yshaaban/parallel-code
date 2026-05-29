import { produce } from 'solid-js/store';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestAgent, createTestTask, resetStoreForTest } from '../test/store-test-helpers';
import { setStore, store } from './core';
import { markAgentOutput, resetAgentOutputActivityRuntimeState } from './agent-output-activity';
import {
  getTaskTerminalSlateCacheSizeForTests,
  getTaskTerminalSlateSnapshot,
  resetTaskTerminalSlateCacheForTests,
} from './task-terminal-slate';
import {
  reconcileTaskScopedStoreStateForExistingTasks,
  removeAgentScopedStoreState,
  removeTaskStoreState,
} from './task-state-cleanup';

describe('task state cleanup', () => {
  beforeEach(() => {
    resetStoreForTest();
    resetAgentOutputActivityRuntimeState();
    resetTaskTerminalSlateCacheForTests();
  });

  it('clears task-scoped review, preview, permission, takeover, and layout state', () => {
    const task = createTestTask({
      agentIds: ['agent-1'],
      id: 'task-1',
      shellAgentIds: ['shell-1'],
    });
    const neighborTask = createTestTask({
      agentIds: ['agent-2'],
      id: 'task-2',
      shellAgentIds: [],
    });

    setStore('tasks', {
      'task-1': task,
      'task-2': neighborTask,
    });
    setStore('agents', {
      'agent-1': createTestAgent({ id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ id: 'agent-2', taskId: 'task-2' }),
    });
    setStore('taskOrder', ['task-1', 'task-2']);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('focusedPanel', { 'task-1': 'review', 'task-2': 'terminal' });
    setStore('fontScales', {
      'task-1': 1.2,
      'task-1:terminal': 1.1,
      'task-2': 1.3,
    });
    setStore('panelSizes', {
      'task-1:terminal': 320,
      'task-2:terminal': 280,
      'task-10:terminal': 500,
    });
    setStore('taskGitStatus', { 'task-1': {} as never, 'task-2': {} as never });
    setStore('taskPorts', { 'task-1': {} as never, 'task-2': {} as never });
    setStore('taskConvergence', { 'task-1': {} as never, 'task-2': {} as never });
    setStore('taskReview', { 'task-1': {} as never, 'task-2': {} as never });
    setStore('taskReviewSignals', { 'task-1': {} as never, 'task-2': {} as never });
    setStore('taskSteps', { 'task-1': {} as never, 'task-2': {} as never });
    setStore('taskStepSummaries', { 'task-1': {} as never, 'task-2': {} as never });
    setStore('taskCommandControllers', {
      'task-1': { action: 'send prompt', controllerId: 'client-1', version: 1 },
      'task-2': { action: 'send prompt', controllerId: 'client-2', version: 1 },
    });
    setStore('incomingTaskTakeoverRequests', {
      'request-1': {
        action: 'send prompt',
        expiresAt: 2_000,
        requestId: 'request-1',
        requesterClientId: 'client-2',
        requesterDisplayName: 'Peer',
        taskId: 'task-1',
      },
      'request-2': {
        action: 'send prompt',
        expiresAt: 2_000,
        requestId: 'request-2',
        requesterClientId: 'client-3',
        requesterDisplayName: 'Peer 2',
        taskId: 'task-2',
      },
    });
    setStore('permissionRequests', {
      'agent-1': [
        {
          agentId: 'agent-1',
          arguments: '{}',
          description: 'Run command',
          detectedAt: 1_000,
          id: 'permission-1',
          status: 'pending',
          taskId: 'task-1',
          tool: 'Bash',
        },
      ],
      'agent-2': [
        {
          agentId: 'agent-2',
          arguments: '{}',
          description: 'Read file',
          detectedAt: 1_000,
          id: 'permission-2',
          status: 'pending',
          taskId: 'task-2',
          tool: 'Read',
        },
      ],
    });
    setStore('permissionAutoRules', [
      { action: 'approve', taskId: 'task-1', tool: 'Bash' },
      { action: 'deny', taskId: 'task-2', tool: 'Write' },
      { action: 'approve', tool: '*' },
    ]);
    setStore('reviewComments', {
      'task-1': [
        {
          agentId: 'agent-1',
          anchor: {
            diffKind: 'add',
            endLine: 1,
            filePath: 'src/app.ts',
            hunkKey: 'hunk-1',
            side: 'new',
            startLine: 1,
          },
          createdAt: 1_000,
          id: 'comment-1',
          status: 'draft',
          taskId: 'task-1',
          text: 'Check this',
        },
      ],
      'task-2': [],
    });
    setStore('reviewPanelOpen', { 'task-1': true, 'task-2': true });
    setStore('pendingAction', { taskId: 'task-1', type: 'close' });
    setStore('sidebarFocusedTaskId', 'task-1');

    setStore(
      produce((storeState) => {
        removeTaskStoreState(storeState, 'task-1');
      }),
    );

    expect(store.tasks['task-1']).toBeUndefined();
    expect(store.taskOrder).toEqual(['task-2']);
    expect(store.collapsedTaskOrder).toEqual([]);
    expect(store.focusedPanel['task-1']).toBeUndefined();
    expect(store.fontScales['task-1']).toBeUndefined();
    expect(store.fontScales['task-1:terminal']).toBeUndefined();
    expect(store.panelSizes['task-1:terminal']).toBeUndefined();
    expect(store.taskGitStatus['task-1']).toBeUndefined();
    expect(store.taskPorts['task-1']).toBeUndefined();
    expect(store.taskConvergence['task-1']).toBeUndefined();
    expect(store.taskReview['task-1']).toBeUndefined();
    expect(store.taskReviewSignals['task-1']).toBeUndefined();
    expect(store.taskSteps['task-1']).toBeUndefined();
    expect(store.taskStepSummaries['task-1']).toBeUndefined();
    expect(store.taskCommandControllers['task-1']).toBeUndefined();
    expect(store.incomingTaskTakeoverRequests['request-1']).toBeUndefined();
    expect(store.permissionRequests['agent-1']).toBeUndefined();
    expect(store.permissionAutoRules).toEqual([
      { action: 'deny', taskId: 'task-2', tool: 'Write' },
      { action: 'approve', tool: '*' },
    ]);
    expect(store.reviewComments['task-1']).toBeUndefined();
    expect(store.reviewPanelOpen['task-1']).toBeUndefined();
    expect(store.pendingAction).toBeNull();
    expect(store.sidebarFocusedTaskId).toBeNull();

    expect(store.tasks['task-2']).toEqual(neighborTask);
    expect(store.focusedPanel['task-2']).toBe('terminal');
    expect(store.fontScales['task-2']).toBe(1.3);
    expect(store.panelSizes['task-2:terminal']).toBe(280);
    expect(store.panelSizes['task-10:terminal']).toBe(500);
    expect(store.permissionRequests['agent-2']).toHaveLength(1);
    expect(store.reviewPanelOpen['task-2']).toBe(true);
    expect(store.incomingTaskTakeoverRequests['request-2']).toBeDefined();
  });

  it('clears permission requests when agent-scoped state is removed', () => {
    setStore('agents', { 'agent-1': createTestAgent({ id: 'agent-1' }) });
    setStore('agentActive', { 'agent-1': true });
    setStore('agentSupervision', { 'agent-1': {} as never });
    setStore('permissionRequests', {
      'agent-1': [
        {
          agentId: 'agent-1',
          arguments: '{}',
          description: 'Run command',
          detectedAt: 1_000,
          id: 'permission-1',
          status: 'pending',
          taskId: 'task-1',
          tool: 'Bash',
        },
      ],
    });

    setStore(
      produce((storeState) => {
        removeAgentScopedStoreState(storeState, ['agent-1']);
      }),
    );

    expect(store.agents['agent-1']).toBeUndefined();
    expect(store.agentActive['agent-1']).toBeUndefined();
    expect(store.agentSupervision['agent-1']).toBeUndefined();
    expect(store.permissionRequests['agent-1']).toBeUndefined();
  });

  it('clears terminal slate cache when agent-scoped state is removed', () => {
    setStore('tasks', 'task-1', createTestTask({ agentIds: ['agent-1'] }));
    setStore('agents', { 'agent-1': createTestAgent({ id: 'agent-1' }) });

    markAgentOutput('agent-1', new TextEncoder().encode('cached line\n'));
    expect(getTaskTerminalSlateSnapshot('task-1')?.lastLine).toBe('cached line');
    expect(getTaskTerminalSlateCacheSizeForTests()).toBe(1);

    setStore(
      produce((storeState) => {
        removeAgentScopedStoreState(storeState, ['agent-1']);
      }),
    );

    expect(getTaskTerminalSlateCacheSizeForTests()).toBe(0);
  });

  it('reconciles stale task-scoped records for tasks that are already gone', () => {
    setStore('reviewPanelOpen', { stale: true });
    setStore('reviewComments', { stale: [] });
    setStore('permissionRequests', {
      'agent-1': [
        {
          agentId: 'agent-1',
          arguments: '{}',
          description: 'Run command',
          detectedAt: 1_000,
          id: 'permission-1',
          status: 'pending',
          taskId: 'stale',
          tool: 'Bash',
        },
      ],
    });
    setStore('permissionAutoRules', [{ action: 'approve', taskId: 'stale', tool: 'Bash' }]);
    setStore('focusedPanel', { stale: 'review' });
    setStore('fontScales', { stale: 1.2 });
    setStore('panelSizes', { 'stale:terminal': 320 });
    setStore('sidebarFocusedTaskId', 'stale');
    setStore('pendingAction', { taskId: 'stale', type: 'merge' });

    let removedTaskIds: string[] = [];
    setStore(
      produce((storeState) => {
        removedTaskIds = reconcileTaskScopedStoreStateForExistingTasks(storeState);
      }),
    );

    expect(removedTaskIds).toEqual(['stale']);
    expect(store.reviewPanelOpen.stale).toBeUndefined();
    expect(store.reviewComments.stale).toBeUndefined();
    expect(store.permissionRequests['agent-1']).toBeUndefined();
    expect(store.permissionAutoRules).toEqual([]);
    expect(store.focusedPanel.stale).toBeUndefined();
    expect(store.fontScales.stale).toBeUndefined();
    expect(store.panelSizes['stale:terminal']).toBeUndefined();
    expect(store.sidebarFocusedTaskId).toBeNull();
    expect(store.pendingAction).toBeNull();
  });
});
