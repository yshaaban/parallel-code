import { beforeEach, describe, expect, it } from 'vitest';

import { resetStoreForTest } from '../test/store-test-helpers';
import { setStore } from './core';
import { getAutosaveClientSessionSnapshot, getAutosaveWorkspaceSnapshot } from './autosave';

describe('autosave snapshots', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('tracks shared workspace task metadata without including browser-local fields', () => {
    setStore('projects', [
      {
        id: 'project-1',
        name: 'Project',
        path: '/tmp/project',
        color: '#123456',
      },
    ]);
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        githubUrl: 'https://example.com/repo',
        planFileName: 'plan.md',
        planRelativePath: 'docs/plans/plan.md',
        skipPermissions: true,
      },
    });
    setStore('editorCommand', 'code');
    setStore('activeTaskId', 'task-1');

    const snapshot = JSON.parse(getAutosaveWorkspaceSnapshot()) as {
      editorCommand?: string;
      hydraCommand?: string;
      tasks: Record<
        string,
        {
          githubUrl?: string;
          planFileName?: string;
          planRelativePath?: string;
          skipPermissions?: boolean;
        }
      >;
    };

    expect(snapshot.tasks['task-1']).toMatchObject({
      githubUrl: 'https://example.com/repo',
      planFileName: 'plan.md',
      planRelativePath: 'docs/plans/plan.md',
      skipPermissions: true,
    });
    expect(snapshot).not.toHaveProperty('activeTaskId');
    expect(snapshot).not.toHaveProperty('editorCommand');
  });

  it('tracks browser-local client session fields without serializing shared workspace tasks', () => {
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');
    setStore('editorCommand', 'code');
    setStore('sidebarVisible', false);
    setStore('sidebarFocused', true);
    setStore('sidebarFocusedProjectId', 'project-1');
    setStore('sidebarFocusedTaskId', 'task-1');
    setStore('focusedPanel', { 'task-1': 'prompt' });
    setStore('fontScales', { prompt: 1.1 });
    setStore('panelSizes', { sidebar: 0.3 });
    setStore('globalScale', 1.2);
    setStore('placeholderFocused', true);
    setStore('placeholderFocusedButton', 'add-terminal');
    setStore('terminalFont', 'JetBrains Mono');
    setStore('themePreset', 'graphite');
    setStore('showPlans', false);
    setStore('inactiveColumnOpacity', 0.75);
    setStore('windowState', {
      x: 10,
      y: 20,
      width: 1200,
      height: 800,
      maximized: false,
    });

    const snapshot = JSON.parse(getAutosaveClientSessionSnapshot()) as {
      activeTaskId?: string | null;
      activeAgentId?: string | null;
      editorCommand?: string;
      sidebarVisible?: boolean;
      sidebarFocused?: boolean;
      sidebarFocusedProjectId?: string | null;
      sidebarFocusedTaskId?: string | null;
      placeholderFocused?: boolean;
      placeholderFocusedButton?: string;
      windowState?: { width: number };
      tasks?: unknown;
    };

    expect(snapshot).toMatchObject({
      activeTaskId: 'task-1',
      activeAgentId: 'agent-1',
      editorCommand: 'code',
      sidebarVisible: false,
      sidebarFocused: true,
      sidebarFocusedProjectId: 'project-1',
      sidebarFocusedTaskId: 'task-1',
      placeholderFocused: true,
      placeholderFocusedButton: 'add-terminal',
      windowState: { width: 1200 },
    });
    expect(snapshot).not.toHaveProperty('tasks');
  });
});
