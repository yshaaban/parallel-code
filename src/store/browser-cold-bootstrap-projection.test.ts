import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestAgentDef, resetStoreForTest } from '../test/store-test-helpers.js';
import { store } from './core.js';
import {
  applyBrowserColdBootstrapProjection,
  buildBrowserColdBootstrapProjectionFromJson,
} from './browser-cold-bootstrap-projection.js';

describe('browser-cold-bootstrap-projection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'));
    resetStoreForTest();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('builds a hydrated cold bootstrap projection from persisted workspace state', () => {
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        projects: [
          {
            color: '#4477aa',
            id: 'project-1',
            name: 'Project',
            path: '/tmp/project',
          },
        ],
        lastProjectId: 'project-1',
        taskOrder: ['task-1', 'shell-1'],
        collapsedTaskOrder: ['task-2'],
        tasks: {
          'task-1': {
            agentDef: {
              args: [],
              command: 'claude',
              description: 'Claude Code',
              id: 'claude-code',
              name: 'Claude Code',
              resume_args: [],
              skip_permissions_args: [],
            },
            agentId: 'agent-1',
            branchName: 'feature/task-1',
            id: 'task-1',
            lastPrompt: '',
            name: 'Task 1',
            notes: '',
            projectId: 'project-1',
            shellCount: 0,
            worktreePath: '/tmp/project/task-1',
          },
          'task-2': {
            agentDef: null,
            branchName: 'feature/task-2',
            collapsed: true,
            id: 'task-2',
            lastPrompt: '',
            name: 'Task 2',
            notes: '',
            projectId: 'project-1',
            shellCount: 1,
            worktreePath: '/tmp/project/task-2',
          },
        },
        terminals: {
          'shell-1': {
            agentId: 'shell-agent-1',
            id: 'shell-1',
            name: 'Shell 1',
          },
        },
      }),
      {
        currentAvailableAgents: [createTestAgentDef({ id: 'claude-code', name: 'Claude Code' })],
        currentCustomAgents: [],
      },
    );

    expect(projection).toMatchObject({
      availableAgents: [expect.objectContaining({ id: 'claude-code' })],
      collapsedTaskOrder: ['task-2'],
      completedTaskCount: 0,
      completedTaskDate: '2026-04-03',
      customAgents: [],
      hydraCommand: '',
      hydraForceDispatchFromPromptPanel: true,
      hydraStartupMode: 'auto',
      lastProjectId: 'project-1',
      mergedLinesAdded: 0,
      mergedLinesRemoved: 0,
      projects: [expect.objectContaining({ id: 'project-1' })],
      taskOrder: ['task-1', 'shell-1'],
      terminals: {
        'shell-1': {
          agentId: 'shell-agent-1',
          id: 'shell-1',
          name: 'Shell 1',
        },
      },
    });
    expect(projection.tasks['task-1']).toMatchObject({
      agentIds: ['agent-1'],
      id: 'task-1',
      savedAgentDef: expect.objectContaining({ id: 'claude-code' }),
      shellAgentIds: [],
    });
    expect(projection.tasks['task-2']).toMatchObject({
      collapsed: true,
      id: 'task-2',
    });
    expect(projection.tasks['task-2']?.shellAgentIds).toEqual([]);
    expect(projection.tasks['task-2']?.savedAgentDef).toBeUndefined();
  });

  it('applies the hydrated cold bootstrap projection directly into the store', () => {
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        projects: [],
        taskOrder: ['task-1', 'shell-1'],
        tasks: {
          'task-1': {
            agentDef: {
              args: [],
              command: 'claude',
              description: 'Claude Code',
              id: 'claude-code',
              name: 'Claude Code',
              resume_args: [],
              skip_permissions_args: [],
            },
            agentId: 'agent-1',
            branchName: 'feature/task-1',
            id: 'task-1',
            lastPrompt: '',
            name: 'Task 1',
            notes: '',
            projectId: 'project-1',
            shellCount: 0,
            worktreePath: '/tmp/project/task-1',
          },
        },
        terminals: {
          'shell-1': {
            agentId: 'shell-agent-1',
            id: 'shell-1',
            name: 'Shell 1',
          },
        },
      }),
      {
        currentAvailableAgents: [createTestAgentDef()],
        currentCustomAgents: [],
      },
    );

    expect(applyBrowserColdBootstrapProjection(projection)).toBe(true);
    expect(store.taskOrder).toEqual(['task-1', 'shell-1']);
    expect(store.collapsedTaskOrder).toEqual([]);
    expect(store.tasks['task-1']).toMatchObject({
      agentIds: ['agent-1'],
      id: 'task-1',
      savedAgentDef: expect.objectContaining({ id: 'claude-code' }),
      shellAgentIds: [],
    });
    expect(store.agents['agent-1']).toMatchObject({
      def: expect.objectContaining({ id: 'claude-code' }),
      generation: 0,
      id: 'agent-1',
      resumed: true,
      status: 'running',
      taskId: 'task-1',
    });
    expect(store.terminals['shell-1']).toEqual({
      agentId: 'shell-agent-1',
      id: 'shell-1',
      name: 'Shell 1',
    });
    expect(store.availableAgents).toHaveLength(1);
    expect(store.activeTaskId).toBeNull();
    expect(store.activeAgentId).toBeNull();
    expect(store.peerSessions).toEqual({});
  });
});
