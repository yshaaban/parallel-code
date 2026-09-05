import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isTerminalHighLoadModeEnabled,
  syncTerminalHighLoadMode,
} from '../app/terminal-high-load-mode.js';
import {
  getCanonicalMergeProgressPersistenceProjection,
  getCurrentMergeProgressSnapshot,
  resetMergeProgressProjectionForTests,
} from '../app/merge-progress.js';
import { MERGE_PROGRESS_SCHEMA_VERSION } from '../domain/task-merge.js';
import { createTestAgentDef, resetStoreForTest } from '../test/store-test-helpers.js';
import { createInitialAppStore, setStore, store } from './core.js';
import {
  applyBrowserColdBootstrapProjection,
  buildBrowserColdBootstrapProjectionFromJson,
} from './browser-cold-bootstrap-projection.js';
import { getLocalShellPreferencesSnapshot } from './local-shell-preferences.js';

describe('browser-cold-bootstrap-projection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T12:00:00Z'));
    resetStoreForTest();
    resetMergeProgressProjectionForTests();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('builds a hydrated cold bootstrap projection from persisted workspace state without standalone terminals', () => {
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
            stepsTracking: true,
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
            stepsTracking: false,
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
      taskOrder: ['task-1'],
      terminals: {},
    });
    expect(projection.tasks['task-1']).toMatchObject({
      agentIds: ['agent-1'],
      id: 'task-1',
      savedAgentDef: expect.objectContaining({ id: 'claude-code' }),
      shellAgentIds: [],
      stepsTracking: true,
    });
    expect(projection.tasks['task-2']).toMatchObject({
      collapsed: true,
      id: 'task-2',
      stepsTracking: false,
    });
    expect(projection.tasks['task-2']?.shellAgentIds).toEqual([]);
    expect(projection.tasks['task-2']?.savedAgentDef).toBeUndefined();
  });

  it('applies the hydrated cold bootstrap projection directly into the store without standalone terminals', () => {
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
            stepsTracking: true,
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
    expect(store.taskOrder).toEqual(['task-1']);
    expect(store.collapsedTaskOrder).toEqual([]);
    expect(store.tasks['task-1']).toMatchObject({
      agentIds: ['agent-1'],
      id: 'task-1',
      savedAgentDef: expect.objectContaining({ id: 'claude-code' }),
      shellAgentIds: [],
      stepsTracking: true,
    });
    expect(store.agents['agent-1']).toMatchObject({
      def: expect.objectContaining({ id: 'claude-code' }),
      generation: 0,
      id: 'agent-1',
      resumed: true,
      status: 'running',
      taskId: 'task-1',
    });
    expect(store.terminals).toEqual({});
    expect(store.availableAgents).toHaveLength(1);
    expect(store.activeTaskId).toBeNull();
    expect(store.activeAgentId).toBeNull();
    expect(store.peerSessions).toEqual({});
  });

  it('hydrates one validated canonical merge-progress snapshot through cold bootstrap', () => {
    const mergeProgress = {
      schemaVersion: MERGE_PROGRESS_SCHEMA_VERSION,
      version: 7,
      dateKey: '2026-04-03',
      tasksToday: 3,
      linesAdded: 21,
      linesRemoved: 8,
      updatedAt: '2026-04-03T10:00:00.000Z',
    } as const;
    const mergeOperation = {
      committedAt: mergeProgress.updatedAt,
      operationId: 'merge-operation-7',
      progressVersion: mergeProgress.version,
      taskId: 'task-merged',
    } as const;
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        committedMergeOperationId: mergeOperation.operationId,
        completedTaskCount: 99,
        mergeOperation,
        mergeProgress,
        projects: [],
        taskOrder: [],
        tasks: {},
      }),
      {
        currentAvailableAgents: [createTestAgentDef()],
        currentCustomAgents: [],
      },
    );

    expect(projection.committedMergeOperationId).toBe(mergeOperation.operationId);
    expect(projection.mergeOperation).toEqual(mergeOperation);
    expect(projection.mergeProgress).toEqual(mergeProgress);
    expect(applyBrowserColdBootstrapProjection(projection)).toBe(true);
    expect(getCurrentMergeProgressSnapshot()).toEqual(mergeProgress);
    expect(getCanonicalMergeProgressPersistenceProjection()).toEqual({
      committedMergeOperationId: mergeOperation.operationId,
      mergeOperation,
      mergeProgress,
    });
  });

  it('hydrates every active multi-agent task terminal during browser cold bootstrap', () => {
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        projects: [],
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            agentDefs: [
              createTestAgentDef({ id: 'claude', name: 'Claude' }),
              createTestAgentDef({ id: 'codex', name: 'Codex' }),
            ],
            agentIds: ['agent-1', 'agent-2'],
            agentDef: createTestAgentDef({ id: 'claude', name: 'Claude' }),
            branchName: 'feature/task-1',
            id: 'task-1',
            lastPrompt: '',
            name: 'Task 1',
            notes: '',
            projectId: 'project-1',
            selectedAgentId: 'agent-2',
            shellCount: 0,
            worktreePath: '/tmp/project/task-1',
          },
        },
      }),
      {
        currentAvailableAgents: [createTestAgentDef()],
        currentCustomAgents: [],
      },
    );

    expect(projection.tasks['task-1']?.savedAgentDefs?.map((agentDef) => agentDef.id)).toEqual([
      'claude',
      'codex',
    ]);
    expect(applyBrowserColdBootstrapProjection(projection)).toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1', 'agent-2']);
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-2');
    expect(store.agents['agent-1']?.def.id).toBe('claude');
    expect(store.agents['agent-2']?.def.id).toBe('codex');
  });

  it('resets the complete local shell preference shape during browser cold bootstrap', () => {
    const initialStore = createInitialAppStore();
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        tasks: {},
        terminals: {},
      }),
      {
        currentAvailableAgents: [createTestAgentDef()],
        currentCustomAgents: [],
      },
    );

    setStore('fontScales', { stale: 1.5 });
    setStore('fontSmoothing', !initialStore.fontSmoothing);
    setStore('globalScale', 1.25);
    setStore('inactiveColumnOpacity', 0.9);
    setStore('keybindings', {
      overrides: {
        'app.new-task': { chords: [{ ctrl: true, key: 'x' }] },
      },
      version: 1,
    });
    setStore('panelSizes', { 'stale:panel': 0.4 });
    setStore('showPlans', !initialStore.showPlans);
    setStore('sidebarSectionCollapsed', {
      projects: true,
      progress: false,
      sessions: false,
      tips: false,
    });
    setStore('sidebarVisible', !initialStore.sidebarVisible);
    setStore('taskNotificationsEnabled', !initialStore.taskNotificationsEnabled);
    setStore('taskNotificationsPreferenceInitialized', false);
    setStore('terminalFont', 'Fira Code');
    setStore('terminalFontSize', 18);
    setStore('terminalHighLoadMode', !initialStore.terminalHighLoadMode);
    syncTerminalHighLoadMode(!initialStore.terminalHighLoadMode);
    setStore('terminalLocalInputFeedbackEnabled', !initialStore.terminalLocalInputFeedbackEnabled);
    setStore('themePreset', 'graphite');
    setStore('verboseLogging', true);
    setStore('windowState', {
      height: 720,
      maximized: false,
      width: 1280,
      x: 10,
      y: 20,
    });

    expect(applyBrowserColdBootstrapProjection(projection)).toBe(true);
    expect(getLocalShellPreferencesSnapshot(store)).toEqual(
      getLocalShellPreferencesSnapshot(initialStore),
    );
    expect(isTerminalHighLoadModeEnabled()).toBe(initialStore.terminalHighLoadMode);
  });

  it('clears task-step projections during browser cold bootstrap', () => {
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        tasks: {},
        terminals: {},
      }),
      {
        currentAvailableAgents: [createTestAgentDef()],
        currentCustomAgents: [],
      },
    );

    setStore('taskSteps', {
      stale: {
        errorMessage: null,
        revisionId: 'stale::snapshot',
        state: 'active',
        steps: [],
        taskId: 'stale',
        trackingEnabled: true,
        updatedAt: 1_000,
      },
    });
    setStore('taskStepSummaries', {
      stale: {
        errorMessage: null,
        latestStep: null,
        nextAction: null,
        preview: 'Stale',
        revisionId: 'stale::summary',
        state: 'active',
        stepCount: 0,
        taskId: 'stale',
        trackingEnabled: true,
        updatedAt: 1_000,
      },
    });

    expect(applyBrowserColdBootstrapProjection(projection)).toBe(true);
    expect(store.taskSteps).toEqual({});
    expect(store.taskStepSummaries).toEqual({});
  });

  it('clears local review, permission, and pending action state during browser cold bootstrap', () => {
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        tasks: {},
        terminals: {},
      }),
      {
        currentAvailableAgents: [createTestAgentDef()],
        currentCustomAgents: [],
      },
    );

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
    setStore('permissionAutoRules', [
      { action: 'approve', taskId: 'task-1', tool: 'Bash' },
      { action: 'deny', tool: 'Write' },
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
    });
    setStore('reviewPanelOpen', { 'task-1': true });
    setStore('pendingAction', { taskId: 'task-1', type: 'close' });

    expect(applyBrowserColdBootstrapProjection(projection)).toBe(true);
    expect(store.permissionRequests).toEqual({});
    expect(store.permissionAutoRules).toEqual([]);
    expect(store.reviewComments).toEqual({});
    expect(store.reviewPanelOpen).toEqual({});
    expect(store.pendingAction).toBeNull();
  });

  it('treats standalone-terminal-only persisted workspace state as empty cold bootstrap state', () => {
    const projection = buildBrowserColdBootstrapProjectionFromJson(
      JSON.stringify({
        projects: [],
        taskOrder: ['shell-1'],
        tasks: {},
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

    expect(projection.taskOrder).toEqual([]);
    expect(projection.tasks).toEqual({});
    expect(projection.terminals).toEqual({});
  });
});
