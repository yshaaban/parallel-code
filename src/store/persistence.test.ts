import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import {
  createTaskCommandLeaseSession,
  resetTaskCommandLeaseStateForTests,
} from '../app/task-command-lease';
import { markTaskPromptDispatch } from '../app/task-prompt-dispatch';
import { getTaskActivityStatus } from '../app/task-presentation-status';
import {
  isTerminalHighLoadModeEnabled,
  syncTerminalHighLoadMode,
} from '../app/terminal-high-load-mode';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { store } from './core';
import {
  applyTaskCommandControllerChanged,
  getTaskCommandController,
  resetTaskCommandControllerStateForTests,
} from './task-command-controllers';
import {
  getTaskTerminalStartupSummary,
  registerTerminalStartupCandidate,
  setTerminalStartupPhase,
} from './terminal-startup';
import {
  applyBrowserColdBootstrapWorkspaceProjection,
  applyLoadedStateJson,
  applyLoadedWorkspaceStateJson,
  getWorkspaceStateSnapshotJson,
  loadState,
  loadWorkspaceState,
  saveState,
} from './persistence';
import {
  getLoadedWorkspaceRevision,
  resetPersistenceSessionStateForTests,
} from './persistence-session';
import { getIncomingTaskTakeoverRequest } from './task-command-takeovers';
import {
  getRecentTaskGitStatusPollAge,
  handleGitStatusSyncEvent,
  resetTaskGitStatusRuntimeState,
} from './task-git-status';
import { setStore } from './core';
import {
  createTestAgent,
  createTestAgentDef,
  createTestProject,
  createTestTask,
  resetStoreForTest,
} from '../test/store-test-helpers';

const {
  clearAgentActivityMock,
  invokeMock,
  isElectronRuntimeMock,
  markAgentSpawnedMock,
  randomPastelColorMock,
  resetTerminalFocusedInputStateMock,
  resetTaskStatusRuntimeStateMock,
  syncTerminalCounterMock,
} = vi.hoisted(() => ({
  clearAgentActivityMock: vi.fn(),
  invokeMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
  markAgentSpawnedMock: vi.fn(),
  randomPastelColorMock: vi.fn(() => '#8899aa'),
  resetTerminalFocusedInputStateMock: vi.fn(),
  resetTaskStatusRuntimeStateMock: vi.fn(),
  syncTerminalCounterMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('../domain/project-colors', () => ({
  randomPastelColor: randomPastelColorMock,
}));

vi.mock('./taskStatus', () => ({
  clearAgentActivity: clearAgentActivityMock,
  markAgentSpawned: markAgentSpawnedMock,
  resetTaskStatusRuntimeState: resetTaskStatusRuntimeStateMock,
}));

vi.mock('../app/terminal-focused-input', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/terminal-focused-input')>();
  return {
    ...actual,
    resetTerminalFocusedInputState: resetTerminalFocusedInputStateMock,
  };
});

vi.mock('./terminals', () => ({
  syncTerminalCounter: syncTerminalCounterMock,
}));

describe('persistence integration', () => {
  let taskCommandControllerVersion = 0;

  beforeEach(() => {
    resetStoreForTest();
    resetTaskCommandLeaseStateForTests();
    resetTaskCommandControllerStateForTests();
    resetTaskGitStatusRuntimeState();
    resetPersistenceSessionStateForTests();
    vi.clearAllMocks();
    isElectronRuntimeMock.mockReturnValue(true);
    taskCommandControllerVersion = 0;
  });

  function withControllerVersion<T extends { taskId: string }>(value: T): T & { version: number } {
    taskCommandControllerVersion += 1;
    return {
      ...value,
      version: taskCommandControllerVersion,
    };
  }

  it('persists and hydrates multi-agent task projection with selected agent', () => {
    const project = createTestProject();
    const firstAgentDef = createTestAgentDef({ id: 'claude', name: 'Claude' });
    const secondAgentDef = createTestAgentDef({ id: 'codex', name: 'Codex' });
    setStore('projects', [project]);
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1', 'agent-2'],
        id: 'task-1',
        selectedAgentId: 'agent-2',
      }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({ def: firstAgentDef, id: 'agent-1', taskId: 'task-1' }),
      'agent-2': createTestAgent({ def: secondAgentDef, id: 'agent-2', taskId: 'task-1' }),
    });

    const workspaceJson = getWorkspaceStateSnapshotJson();
    const persisted = JSON.parse(workspaceJson) as {
      tasks: Record<
        string,
        {
          agentDefs?: unknown[];
          agentIds?: string[];
          selectedAgentId?: string;
        }
      >;
    };

    expect(persisted.tasks['task-1']?.agentIds).toEqual(['agent-1', 'agent-2']);
    expect(persisted.tasks['task-1']?.agentDefs).toHaveLength(2);
    expect(persisted.tasks['task-1']?.selectedAgentId).toBe('agent-2');

    resetStoreForTest();
    isElectronRuntimeMock.mockReturnValue(true);

    expect(applyLoadedStateJson(workspaceJson)).toBe(true);
    expect(store.tasks['task-1']?.agentIds).toEqual(['agent-1', 'agent-2']);
    expect(store.tasks['task-1']?.selectedAgentId).toBe('agent-2');
    expect(store.agents['agent-1']?.def.name).toBe('Claude');
    expect(store.agents['agent-2']?.def.name).toBe('Codex');
    expect(store.activeAgentId).toBe('agent-2');
  });

  it('does not persist incomplete multi-agent definitions as a restorable agent set', () => {
    setStore('projects', [createTestProject()]);
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: ['agent-1', 'agent-2'],
        id: 'task-1',
        selectedAgentId: 'agent-2',
      }),
    });
    setStore('agents', {
      'agent-1': createTestAgent({
        def: createTestAgentDef({ id: 'claude', name: 'Claude' }),
        id: 'agent-1',
        taskId: 'task-1',
      }),
    });

    const workspaceJson = getWorkspaceStateSnapshotJson();
    const persisted = JSON.parse(workspaceJson) as {
      tasks: Record<
        string,
        {
          agentDefs?: unknown[];
          agentIds?: string[];
          selectedAgentId?: string;
        }
      >;
    };

    expect(persisted.tasks['task-1']?.agentIds).toBeUndefined();
    expect(persisted.tasks['task-1']?.agentDefs).toBeUndefined();
    expect(persisted.tasks['task-1']?.selectedAgentId).toBeUndefined();
  });

  it('persists and hydrates every saved definition for collapsed multi-agent tasks', () => {
    setStore('projects', [createTestProject()]);
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': createTestTask({
        agentIds: [],
        collapsed: true,
        id: 'task-1',
        savedAgentDef: createTestAgentDef({ id: 'claude', name: 'Claude' }),
        savedAgentDefs: [
          createTestAgentDef({ id: 'claude', name: 'Claude' }),
          createTestAgentDef({ id: 'codex', name: 'Codex' }),
        ],
      }),
    });

    const workspaceJson = getWorkspaceStateSnapshotJson();
    const persisted = JSON.parse(workspaceJson) as {
      tasks: Record<string, { agentDefs?: unknown[] }>;
    };

    expect(persisted.tasks['task-1']?.agentDefs).toHaveLength(2);

    resetStoreForTest();
    isElectronRuntimeMock.mockReturnValue(true);

    expect(applyLoadedStateJson(workspaceJson)).toBe(true);
    expect(store.tasks['task-1']?.collapsed).toBe(true);
    expect(store.tasks['task-1']?.savedAgentDefs?.map((agentDef) => agentDef.id)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('omits git-only project fields for non-git projects during save and hydration', () => {
    const persistedJson = JSON.stringify({
      projects: [
        {
          id: 'project-1',
          name: 'Folder',
          path: '/tmp/folder',
          color: '#123456',
          baseBranch: 'personal/main',
          branchPrefix: 'feature',
          defaultDirectMode: true,
          defaultTaskGitIsolation: 'current-branch',
          deleteBranchOnClose: false,
          projectMode: 'non-git',
        },
      ],
      taskOrder: [],
      tasks: {},
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(store.projects[0]).toMatchObject({
      id: 'project-1',
      projectMode: 'non-git',
    });
    expect(store.projects[0]).not.toHaveProperty('baseBranch');
    expect(store.projects[0]).not.toHaveProperty('branchPrefix');
    expect(store.projects[0]).not.toHaveProperty('defaultDirectMode');
    expect(store.projects[0]).not.toHaveProperty('defaultTaskGitIsolation');
    expect(store.projects[0]).not.toHaveProperty('deleteBranchOnClose');

    const workspaceJson = getWorkspaceStateSnapshotJson();
    const persisted = JSON.parse(workspaceJson) as {
      projects: Array<Record<string, unknown>>;
    };

    expect(persisted.projects[0]).toEqual(
      expect.objectContaining({
        id: 'project-1',
        projectMode: 'non-git',
      }),
    );
    expect(persisted.projects[0]).not.toHaveProperty('baseBranch');
    expect(persisted.projects[0]).not.toHaveProperty('branchPrefix');
    expect(persisted.projects[0]).not.toHaveProperty('defaultDirectMode');
    expect(persisted.projects[0]).not.toHaveProperty('defaultTaskGitIsolation');
    expect(persisted.projects[0]).not.toHaveProperty('deleteBranchOnClose');
  });

  it('hydrates only valid persisted project agent runner config', () => {
    expect(
      applyLoadedStateJson(
        JSON.stringify({
          projects: [
            {
              id: 'project-1',
              name: 'Project',
              path: '/tmp/project',
              color: '#123456',
              agentRunnerConfig: {
                image: 'agent:latest',
                provider: 'docker-container',
              },
            },
            {
              id: 'project-2',
              name: 'Invalid',
              path: '/tmp/invalid',
              color: '#654321',
              agentRunnerConfig: {
                image: 'agent:latest',
                provider: 'podman',
              },
            },
          ],
          taskOrder: [],
          tasks: {},
        }),
      ),
    ).toBe(true);

    expect(store.projects[0]?.agentRunnerConfig).toEqual({
      image: 'agent:latest',
      provider: 'docker-container',
    });
    expect(store.projects[1]?.agentRunnerConfig).toBeUndefined();
  });

  it('migrates legacy projectRoot state and restores running agents', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projectRoot: '/tmp/project',
            taskOrder: ['task-1'],
            tasks: {
              'task-1': {
                id: 'task-1',
                name: 'Task',
                branchName: 'feature/task-1',
                worktreePath: '/tmp/project/task-1',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentId: 'agent-1',
                agentDef: {
                  id: 'claude',
                  name: 'Claude',
                  command: 'claude',
                  args: [],
                },
              },
            },
            activeTaskId: 'task-1',
            sidebarVisible: true,
          }),
        );
      }
      if (channel === IPC.SaveAppState) {
        return Promise.resolve(undefined);
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await loadState();

    expect(store.projects).toHaveLength(1);
    expect(store.projects[0]?.path).toBe('/tmp/project');
    expect(store.projects[0]?.color).toBe('#8899aa');
    expect(store.tasks['task-1']?.projectId).toBe(store.projects[0]?.id);
    expect(store.activeTaskId).toBe('task-1');
    expect(store.activeAgentId).toBe('agent-1');
    expect(markAgentSpawnedMock).toHaveBeenCalledWith('agent-1');
    expect(syncTerminalCounterMock).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid persisted JSON without mutating the store', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockResolvedValue('{not-valid-json');

    await loadState();

    expect(store.projects).toHaveLength(0);
    expect(store.taskOrder).toHaveLength(0);
    expect(markAgentSpawnedMock).not.toHaveBeenCalled();
    expect(syncTerminalCounterMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse persisted state');

    warnSpy.mockRestore();
  });

  it('rejects malformed persisted state containers without mutating the store', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const malformedStates = [
      { taskOrder: ['task-1'], tasks: null },
      { taskOrder: ['task-1'], tasks: [] },
      { taskOrder: [42], tasks: {} },
      { collapsedTaskOrder: [42], taskOrder: [], tasks: {} },
      { activeTaskId: 42, taskOrder: [], tasks: {} },
    ];

    for (const state of malformedStates) {
      invokeMock.mockResolvedValueOnce(JSON.stringify(state));

      await expect(loadState()).resolves.toBe(false);
      expect(store.projects).toHaveLength(0);
      expect(store.taskOrder).toHaveLength(0);
      expect(markAgentSpawnedMock).not.toHaveBeenCalled();
      expect(syncTerminalCounterMock).not.toHaveBeenCalled();
    }
    expect(warnSpy).toHaveBeenCalledWith('Invalid persisted state structure, skipping load');

    warnSpy.mockRestore();
  });

  it('skips malformed persisted tasks while restoring valid neighboring tasks', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projectRoot: '/tmp/project',
            projects: { invalid: true },
            taskOrder: ['task-bad', 'task-good'],
            collapsedTaskOrder: ['task-collapsed-bad', 'task-collapsed'],
            tasks: {
              'task-bad': null,
              'task-collapsed-bad': {
                id: 'task-collapsed-bad',
                name: 'Collapsed Bad',
                branchName: 'feature/collapsed-bad',
                worktreePath: '/tmp/project/collapsed-bad',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
                collapsed: 'yes',
              },
              'task-good': {
                id: 'task-good',
                name: 'Task Good',
                branchName: 'feature/task-good',
                worktreePath: '/tmp/project/task-good',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
              },
              'task-collapsed': {
                id: 'task-collapsed',
                name: 'Task Collapsed',
                branchName: 'feature/task-collapsed',
                worktreePath: '/tmp/project/task-collapsed',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
                collapsed: true,
              },
            },
            activeTaskId: 'task-good',
            sidebarVisible: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await loadState();

    expect(store.projects).toHaveLength(1);
    expect(store.taskOrder).toEqual(['task-good']);
    expect(store.collapsedTaskOrder).toEqual(['task-collapsed']);
    expect(store.tasks['task-bad']).toBeUndefined();
    expect(store.tasks['task-collapsed-bad']).toBeUndefined();
    expect(store.tasks['task-good']).toMatchObject({
      name: 'Task Good',
      projectId: store.projects[0]?.id,
    });
    expect(store.tasks['task-collapsed']).toMatchObject({
      collapsed: true,
      projectId: store.projects[0]?.id,
    });
  });

  it('falls back from stale active selection to the first restored panel', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [
              { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
            ],
            taskOrder: ['terminal-1', 'task-1'],
            tasks: {
              'task-1': {
                id: 'task-1',
                name: 'Task 1',
                projectId: 'project-1',
                branchName: 'feature/task-1',
                worktreePath: '/tmp/project/task-1',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
              },
            },
            terminals: {
              'terminal-1': {
                id: 'terminal-1',
                name: 'Shell 1',
                agentId: 'terminal-agent-1',
              },
            },
            activeTaskId: 'missing-panel',
            sidebarVisible: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await loadState();

    expect(store.taskOrder).toEqual(['terminal-1', 'task-1']);
    expect(store.activeTaskId).toBe('terminal-1');
    expect(store.activeAgentId).toBe('terminal-agent-1');
  });

  it('filters corrupted task ordering and prevents a task from being both active and collapsed', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [
              {
                id: 'project-1',
                name: 'Project',
                path: '/tmp/project',
                color: '#123456',
                defaultDirectMode: true,
              },
            ],
            taskOrder: ['task-1', 'missing-task'],
            collapsedTaskOrder: ['task-1', 'task-2'],
            tasks: {
              'task-1': {
                id: 'task-1',
                name: 'Task 1 Reloaded',
                projectId: 'project-1',
                branchName: 'feature/task-1',
                worktreePath: '/tmp/project/task-1',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
              },
              'task-2': {
                id: 'task-2',
                name: 'Task 2',
                projectId: 'project-1',
                branchName: 'feature/task-2',
                worktreePath: '/tmp/project/task-2',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
                collapsed: true,
              },
            },
            activeTaskId: 'task-1',
            sidebarVisible: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await loadState();

    expect(store.taskOrder).toEqual(['task-1']);
    expect(store.collapsedTaskOrder).toEqual(['task-2']);
    expect(store.tasks['task-1']?.collapsed).not.toBe(true);
    expect(store.tasks['task-2']?.collapsed).toBe(true);
  });

  it('skips reapplying identical persisted state payloads', async () => {
    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Task 1',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentId: 'agent-1',
          agentDef: {
            id: 'claude',
            name: 'Claude',
            command: 'claude',
            args: [],
          },
        },
      },
      activeTaskId: 'task-1',
      sidebarVisible: true,
    });

    invokeMock.mockResolvedValue(persistedJson);

    await expect(loadState()).resolves.toBe(true);
    expect(markAgentSpawnedMock).toHaveBeenCalledTimes(1);
    expect(syncTerminalCounterMock).toHaveBeenCalledTimes(1);

    await expect(loadState()).resolves.toBe(false);
    expect(markAgentSpawnedMock).toHaveBeenCalledTimes(1);
    expect(syncTerminalCounterMock).toHaveBeenCalledTimes(1);
  });

  it('clears stale controller projection state when full-state load resets the store', async () => {
    applyTaskCommandControllerChanged({
      action: 'send a prompt',
      controllerId: 'peer-stale',
      taskId: 'task-1',
      version: 9,
    });

    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [
              { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
            ],
            taskOrder: ['task-1'],
            tasks: {
              'task-1': {
                id: 'task-1',
                name: 'Task 1',
                projectId: 'project-1',
                branchName: 'feature/task-1',
                worktreePath: '/tmp/project/task-1',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
              },
            },
            activeTaskId: 'task-1',
            sidebarVisible: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await loadState();

    expect(store.taskCommandControllers).toEqual({});

    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-fresh',
      taskId: 'task-1',
      version: 1,
    });

    expect(getTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-fresh',
      version: 1,
    });
  });

  it('clears transient prompt-dispatch state during a full-state load', () => {
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': {
        id: 'agent-1',
        taskId: 'task-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    markTaskPromptDispatch('agent-1', 0, 2_000);

    expect(getTaskActivityStatus('task-1', 2_300)).toBe('sending');

    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Reloaded task',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentId: 'agent-1',
          agentDef: {
            id: 'claude',
            name: 'Claude',
            command: 'claude',
            args: [],
          },
        },
      },
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(getTaskActivityStatus('task-1', 2_300)).toBe('idle');
  });

  it('clears stale git-status freshness state when full-state load resets the store', async () => {
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
      },
    });
    handleGitStatusSyncEvent({
      worktreePath: '/tmp/project/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });
    expect(getRecentTaskGitStatusPollAge('/tmp/project/task-1')).not.toBeNull();

    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Task 1 Reloaded',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
        },
      },
      activeTaskId: 'task-1',
      sidebarVisible: true,
      hasSeenDesktopIntro: true,
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);

    expect(resetTaskStatusRuntimeStateMock).toHaveBeenCalledTimes(1);
    expect(resetTerminalFocusedInputStateMock).toHaveBeenCalledTimes(1);
    expect(getRecentTaskGitStatusPollAge('/tmp/project/task-1')).toBeNull();
  });

  it('clears stale task steps projections when full-state load resets the store', () => {
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

    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Reloaded task',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
        },
      },
      activeTaskId: 'task-1',
      sidebarVisible: true,
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(store.taskSteps).toEqual({});
    expect(store.taskStepSummaries).toEqual({});
  });

  it('persists active and collapsed tasks with the expected optional fields', async () => {
    invokeMock.mockResolvedValue(undefined);
    setStore('projects', [
      {
        id: 'project-1',
        name: 'Project',
        path: '/tmp/project',
        color: '#123456',
        defaultDirectMode: true,
      },
    ]);
    setStore('taskOrder', ['task-1']);
    setStore('collapsedTaskOrder', ['task-2']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: ['shell-1'],
        notes: 'notes',
        lastPrompt: 'last prompt',
        directMode: true,
        baseBranch: ' personal/main ',
        planFileName: 'task-1-plan.md',
        planRelativePath: 'docs/plans/task-1-plan.md',
        stepsTracking: true,
      },
      'task-2': {
        id: 'task-2',
        name: 'Task 2',
        projectId: 'project-1',
        branchName: 'feature/task-2',
        worktreePath: '/tmp/project/task-2',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        collapsed: true,
        stepsTracking: false,
        savedAgentDef: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
      },
    });
    setStore('agents', {
      'agent-1': {
        id: 'agent-1',
        taskId: 'task-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    setStore('windowState', {
      x: 10,
      y: 20,
      width: 1200,
      height: 800,
      maximized: false,
    });
    setStore('taskPorts', {
      'task-1': {
        taskId: 'task-1',
        exposed: [
          {
            availability: 'available',
            host: null,
            label: 'Frontend',
            lastVerifiedAt: 1_000,
            port: 4173,
            protocol: 'https',
            source: 'manual',
            statusMessage: null,
            updatedAt: 1_000,
            verifiedHost: '127.0.0.1',
          },
        ],
        observed: [],
        updatedAt: 1_000,
      },
    });

    await saveState();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SaveAppState,
      expect.objectContaining({
        json: expect.any(String),
        sourceId: expect.any(String),
      }),
    );

    const saveArgs = invokeMock.mock.calls.find(
      ([channel]) => channel === IPC.SaveAppState,
    )?.[1] as {
      json: string;
    };
    const persisted = JSON.parse(saveArgs.json) as {
      collapsedTaskOrder: string[];
      projects: Array<Record<string, unknown>>;
      tasks: Record<string, Record<string, unknown>>;
      windowState: Record<string, unknown>;
    };

    expect(persisted.projects[0]).toMatchObject({
      defaultTaskGitIsolation: 'current-branch',
    });
    expect(persisted.projects[0]).not.toHaveProperty('defaultDirectMode');
    expect(persisted.tasks['task-1']).toMatchObject({
      baseBranch: 'personal/main',
      gitIsolation: 'current-branch',
      agentId: 'agent-1',
      exposedPorts: [
        {
          label: 'Frontend',
          port: 4173,
          protocol: 'https',
        },
      ],
      planFileName: 'task-1-plan.md',
      planRelativePath: 'docs/plans/task-1-plan.md',
      shellAgentIds: ['shell-1'],
      stepsTracking: true,
    });
    expect(persisted.tasks['task-1']).not.toHaveProperty('directMode');
    expect(persisted.tasks['task-2']).toMatchObject({
      collapsed: true,
      agentDef: expect.objectContaining({ id: 'claude' }),
      stepsTracking: false,
    });
    expect(persisted.collapsedTaskOrder).toEqual(['task-2']);
    expect(persisted.windowState).toEqual({
      x: 10,
      y: 20,
      width: 1200,
      height: 800,
      maximized: false,
    });
  });

  it('hydrates explicit git isolation fields while keeping direct-mode compatibility', () => {
    const persistedJson = JSON.stringify({
      projects: [
        {
          id: 'project-1',
          name: 'Project',
          path: '/tmp/project',
          color: '#123456',
          defaultTaskGitIsolation: 'current-branch',
          baseBranch: ' personal/main ',
        },
      ],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Task',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
          gitIsolation: 'current-branch',
          baseBranch: ' personal/main ',
        },
      },
      activeTaskId: null,
      sidebarVisible: true,
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(store.projects[0]).toMatchObject({
      baseBranch: 'personal/main',
      defaultTaskGitIsolation: 'current-branch',
      defaultDirectMode: true,
    });
    expect(store.tasks['task-1']).toMatchObject({
      baseBranch: 'personal/main',
      gitIsolation: 'current-branch',
      directMode: true,
    });
  });

  it('migrates legacy direct-mode persistence into explicit git isolation fields', () => {
    const persistedJson = JSON.stringify({
      projects: [
        {
          id: 'project-1',
          name: 'Project',
          path: '/tmp/project',
          color: '#123456',
          defaultDirectMode: true,
        },
      ],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Task',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
          directMode: true,
        },
      },
      activeTaskId: null,
      sidebarVisible: true,
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(store.projects[0]).toMatchObject({
      defaultTaskGitIsolation: 'current-branch',
      defaultDirectMode: true,
    });
    expect(store.tasks['task-1']).toMatchObject({
      gitIsolation: 'current-branch',
      directMode: true,
    });
  });

  it('keeps standalone terminals app-local while sharing the same task serialization for app and workspace snapshots', async () => {
    invokeMock.mockResolvedValue(undefined);
    setStore('projects', [
      { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
    ]);
    setStore('taskOrder', ['task-1', 'terminal-1']);
    setStore('collapsedTaskOrder', ['task-2']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: ['shell-1'],
        notes: 'notes',
        lastPrompt: 'last prompt',
      },
      'task-2': {
        id: 'task-2',
        name: 'Task 2',
        projectId: 'project-1',
        branchName: 'feature/task-2',
        worktreePath: '/tmp/project/task-2',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        collapsed: true,
        savedAgentDef: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
      },
    });
    setStore('agents', {
      'agent-1': {
        id: 'agent-1',
        taskId: 'task-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    setStore('terminals', {
      'terminal-1': {
        id: 'terminal-1',
        name: 'Shell',
        agentId: 'terminal-agent-1',
      },
    });

    const workspaceSnapshot = JSON.parse(getWorkspaceStateSnapshotJson()) as {
      collapsedTaskOrder: string[];
      taskOrder: string[];
      tasks: Record<string, Record<string, unknown>>;
      terminals?: Record<string, Record<string, unknown>>;
    };

    await saveState();

    const saveArgs = invokeMock.mock.calls.find(
      ([channel]) => channel === IPC.SaveAppState,
    )?.[1] as {
      json: string;
    };
    const persisted = JSON.parse(saveArgs.json) as {
      collapsedTaskOrder: string[];
      taskOrder: string[];
      tasks: Record<string, Record<string, unknown>>;
      terminals?: Record<string, Record<string, unknown>>;
    };

    expect(workspaceSnapshot.taskOrder).toEqual(['task-1']);
    expect(workspaceSnapshot.collapsedTaskOrder).toEqual(['task-2']);
    expect(workspaceSnapshot.tasks).toEqual(persisted.tasks);
    expect(workspaceSnapshot.terminals).toBeUndefined();
    expect(persisted.terminals).toEqual({
      'terminal-1': {
        agentId: 'terminal-agent-1',
        id: 'terminal-1',
        name: 'Shell',
      },
    });
  });

  it('skips persisted standalone terminals without an agent id during full app-state load', () => {
    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: ['terminal-1'],
      tasks: {},
      terminals: {
        'terminal-1': {
          id: 'terminal-1',
          name: 'Shell',
        },
      },
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(store.taskOrder).toEqual([]);
    expect(store.terminals).toEqual({});
  });

  it('skips invalid persisted standalone terminal records during full app-state load', () => {
    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: [
        'terminal-valid',
        'terminal-invalid-id',
        'terminal-invalid-name',
        'terminal-mismatched-id',
      ],
      tasks: {},
      terminals: {
        'terminal-valid': {
          agentId: 'terminal-agent-1',
          id: 'terminal-valid',
          name: 'Shell',
        },
        'terminal-invalid-id': {
          agentId: 'terminal-agent-2',
          id: 42,
          name: 'Broken',
        },
        'terminal-invalid-name': {
          agentId: 'terminal-agent-3',
          id: 'terminal-invalid-name',
          name: null,
        },
        'terminal-mismatched-id': {
          agentId: 'terminal-agent-4',
          id: 'terminal-other-id',
          name: 'Broken',
        },
      },
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(store.taskOrder).toEqual(['terminal-valid']);
    expect(store.terminals).toEqual({
      'terminal-valid': {
        agentId: 'terminal-agent-1',
        id: 'terminal-valid',
        name: 'Shell',
      },
    });
  });

  it('omits removing tasks and terminals from persisted state', async () => {
    invokeMock.mockResolvedValue(undefined);
    setStore('projects', [
      { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
    ]);
    setStore('taskOrder', ['task-1', 'terminal-1', 'removed-task', 'removed-terminal']);
    setStore('collapsedTaskOrder', ['task-2', 'removed-collapsed-task']);
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
      },
      'task-2': {
        id: 'task-2',
        name: 'Task 2',
        projectId: 'project-1',
        branchName: 'feature/task-2',
        worktreePath: '/tmp/project/task-2',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        collapsed: true,
      },
      'removed-task': {
        id: 'removed-task',
        name: 'Removed Task',
        projectId: 'project-1',
        branchName: 'feature/removed-task',
        worktreePath: '/tmp/project/removed-task',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        closeState: { kind: 'removing' },
      },
      'removed-collapsed-task': {
        id: 'removed-collapsed-task',
        name: 'Removed Collapsed Task',
        projectId: 'project-1',
        branchName: 'feature/removed-collapsed-task',
        worktreePath: '/tmp/project/removed-collapsed-task',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        closeState: { kind: 'removing' },
        collapsed: true,
      },
    });
    setStore('terminals', {
      'terminal-1': {
        id: 'terminal-1',
        name: 'Shell',
        agentId: 'terminal-agent-1',
      },
      'removed-terminal': {
        id: 'removed-terminal',
        name: 'Removed Shell',
        agentId: 'terminal-agent-2',
        closingStatus: 'removing',
      },
    });

    await saveState();

    const saveArgs = invokeMock.mock.calls.find(
      ([channel]) => channel === IPC.SaveAppState,
    )?.[1] as { json: string };
    const persisted = JSON.parse(saveArgs.json) as {
      collapsedTaskOrder: string[];
      taskOrder: string[];
      tasks: Record<string, Record<string, unknown>>;
      terminals?: Record<string, { agentId: string; id: string; name: string }>;
    };

    expect(persisted.taskOrder).toEqual(['task-1', 'terminal-1']);
    expect(persisted.collapsedTaskOrder).toEqual(['task-2']);
    expect(persisted.tasks).toHaveProperty('task-1');
    expect(persisted.tasks).toHaveProperty('task-2');
    expect(persisted.tasks).not.toHaveProperty('removed-task');
    expect(persisted.tasks).not.toHaveProperty('removed-collapsed-task');
    expect(persisted.terminals).toEqual({
      'terminal-1': {
        agentId: 'terminal-agent-1',
        id: 'terminal-1',
        name: 'Shell',
      },
    });
  });

  it('omits browser-local session fields from shared browser persistence', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    invokeMock.mockResolvedValue(undefined);
    setStore('projects', [
      { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
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
        notes: 'notes',
        lastPrompt: '',
      },
    });
    setStore('activeTaskId', 'task-1');
    setStore('sidebarVisible', false);
    setStore('fontScales', { 'task-1': 1.2 });
    setStore('panelSizes', { 'task-1:notes': 300 });
    setStore('globalScale', 1.1);
    setStore('terminalFontSize', 15);
    setStore('terminalFont', 'Fira Code');
    setStore('fontSmoothing', false);
    setStore('themePreset', 'graphite');
    setStore('sidebarSectionCollapsed', {
      projects: true,
      progress: false,
      sessions: false,
      tips: true,
    });
    setStore('showPlans', false);
    setStore('terminalHighLoadMode', true);
    setStore('taskNotificationsEnabled', true);
    setStore('inactiveColumnOpacity', 0.75);

    await saveState();

    const saveArgs = invokeMock.mock.calls.find(
      ([channel]) => channel === IPC.SaveAppState,
    )?.[1] as { json: string };
    const persisted = JSON.parse(saveArgs.json) as Record<string, unknown>;

    expect(persisted).not.toHaveProperty('activeTaskId');
    expect(persisted).not.toHaveProperty('sidebarVisible');
    expect(persisted).not.toHaveProperty('fontScales');
    expect(persisted).not.toHaveProperty('panelSizes');
    expect(persisted).not.toHaveProperty('globalScale');
    expect(persisted).not.toHaveProperty('terminalFontSize');
    expect(persisted).not.toHaveProperty('terminalFont');
    expect(persisted).not.toHaveProperty('fontSmoothing');
    expect(persisted).not.toHaveProperty('themePreset');
    expect(persisted).not.toHaveProperty('sidebarSectionCollapsed');
    expect(persisted).not.toHaveProperty('showPlans');
    expect(persisted).not.toHaveProperty('terminalHighLoadMode');
    expect(persisted).not.toHaveProperty('taskNotificationsEnabled');
    expect(persisted).not.toHaveProperty('inactiveColumnOpacity');
  });

  it('keeps browser task notifications at the local default when applying the full-state load path outside electron', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
            taskNotificationsEnabled: false,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('taskNotificationsEnabled', false);
    await loadState();

    expect(store.taskNotificationsEnabled).toBe(true);
    expect(store.taskNotificationsPreferenceInitialized).toBe(true);
  });

  it('restores persisted plan file names for active and collapsed tasks', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [
              { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
            ],
            taskOrder: ['task-1'],
            collapsedTaskOrder: ['task-2'],
            tasks: {
              'task-1': {
                id: 'task-1',
                name: 'Task 1',
                projectId: 'project-1',
                branchName: 'feature/task-1',
                worktreePath: '/tmp/project/task-1',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
                planFileName: 'task-1-plan.md',
                planRelativePath: 'docs/plans/task-1-plan.md',
                stepsTracking: true,
              },
              'task-2': {
                id: 'task-2',
                name: 'Task 2',
                projectId: 'project-1',
                branchName: 'feature/task-2',
                worktreePath: '/tmp/project/task-2',
                notes: '',
                lastPrompt: '',
                shellCount: 0,
                agentDef: null,
                planFileName: 'task-2-plan.md',
                planRelativePath: '.claude/plans/task-2-plan.md',
                stepsTracking: false,
                collapsed: true,
              },
            },
            activeTaskId: 'task-1',
            sidebarVisible: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    await loadState();

    expect(store.tasks['task-1']?.planFileName).toBe('task-1-plan.md');
    expect(store.tasks['task-1']?.planRelativePath).toBe('docs/plans/task-1-plan.md');
    expect(store.tasks['task-1']?.stepsTracking).toBe(true);
    expect(store.tasks['task-2']?.planFileName).toBe('task-2-plan.md');
    expect(store.tasks['task-2']?.planRelativePath).toBe('.claude/plans/task-2-plan.md');
    expect(store.tasks['task-2']?.stepsTracking).toBe(false);
  });

  it('applies browser workspace state without overwriting the local active task selection', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    setStore('activeTaskId', 'local-task');
    setStore('activeAgentId', 'local-agent');
    setStore('tasks', {
      'local-task': {
        id: 'local-task',
        name: 'Local',
        projectId: 'project-1',
        branchName: 'feature/local',
        worktreePath: '/tmp/local',
        agentIds: ['local-agent'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'local-agent': {
        id: 'local-agent',
        taskId: 'local-task',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    setStore('taskGitStatus', {
      'task-1': {
        worktreePath: '/tmp/project/task-1',
        branchName: 'feature/task-1',
        dirty_files: 1,
        head_sha: null,
        index_total: 0,
        conflict_files: 0,
        created_at: 0,
      } as never,
    });

    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Remote',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: 'remote notes',
          lastPrompt: '',
          shellCount: 0,
          agentId: 'remote-agent',
          agentDef: {
            id: 'claude',
            name: 'Claude',
            command: 'claude',
            args: [],
          },
        },
      },
      activeTaskId: 'task-1',
      sidebarVisible: true,
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 1)).toBe(true);
    expect(store.activeTaskId).toBe('local-task');
    expect(store.activeAgentId).toBe('local-agent');
    expect(store.tasks['task-1']?.name).toBe('Remote');
    expect(store.taskGitStatus['task-1']).toBeDefined();
  });

  it('loads browser workspace state through the incremental workspace path', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    invokeMock.mockResolvedValue({
      json: JSON.stringify({
        projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            id: 'task-1',
            name: 'Remote',
            projectId: 'project-1',
            branchName: 'feature/task-1',
            worktreePath: '/tmp/project/task-1',
            notes: 'remote notes',
            lastPrompt: '',
            shellCount: 0,
            agentDef: null,
          },
        },
      }),
      revision: 1,
    });

    await expect(loadWorkspaceState()).resolves.toBe(true);
    expect(store.tasks['task-1']?.name).toBe('Remote');
  });

  it('preserves existing task and agent identities during incremental browser workspace sync', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    const agentDef = createTestAgentDef({ id: 'claude', name: 'Claude' });
    setStore('projects', [createTestProject({ id: 'project-1', path: '/tmp/project' })]);
    setStore('tasks', {
      'task-1': createTestTask({
        id: 'task-1',
        projectId: 'project-1',
        agentIds: ['agent-1'],
        selectedAgentId: 'agent-1',
      }),
    });
    setStore('agents', {
      'agent-1': {
        ...createTestAgent({
          id: 'agent-1',
          taskId: 'task-1',
          def: agentDef,
          generation: 4,
        }),
        terminalSessionVersion: 2,
      },
    });

    const previousTask = store.tasks['task-1'];
    const previousAgent = store.agents['agent-1'];
    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Remote',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: 'remote notes',
          lastPrompt: '',
          shellCount: 0,
          agentId: 'agent-1',
          agentDef,
        },
      },
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 1)).toBe(true);

    expect(store.tasks['task-1']).toBe(previousTask);
    expect(store.agents['agent-1']).toBe(previousAgent);
    expect(store.tasks['task-1']?.name).toBe('Remote');
    expect(store.agents['agent-1']?.generation).toBe(4);
    expect(store.agents['agent-1']?.terminalSessionVersion).toBe(2);
  });

  it('surfaces browser workspace load transport failures to the caller', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    invokeMock.mockRejectedValueOnce(new Error('workspace load failed'));

    await expect(loadWorkspaceState()).rejects.toThrow('workspace load failed');
  });

  it('clears transient prompt-dispatch state during incremental workspace apply', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': {
        id: 'agent-1',
        taskId: 'task-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    markTaskPromptDispatch('agent-1', 0, 2_000);

    expect(getTaskActivityStatus('task-1', 2_300)).toBe('sending');

    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Remote',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentId: 'agent-1',
          agentDef: {
            id: 'claude',
            name: 'Claude',
            command: 'claude',
            args: [],
          },
        },
      },
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 4)).toBe(true);
    expect(getTaskActivityStatus('task-1', 2_300)).toBe('idle');
  });

  it('resets focused terminal input state during incremental workspace apply', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Remote',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
        },
      },
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 9)).toBe(true);
    expect(resetTerminalFocusedInputStateMock).toHaveBeenCalledTimes(1);
  });

  it('cleans stale task-scoped derived state during a repeated workspace sync without marking an apply', async () => {
    isElectronRuntimeMock.mockReturnValue(false);
    invokeMock.mockResolvedValue({
      json: JSON.stringify({
        projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
        taskOrder: ['task-1'],
        tasks: {
          'task-1': {
            id: 'task-1',
            name: 'Remote',
            projectId: 'project-1',
            branchName: 'feature/task-1',
            worktreePath: '/tmp/project/task-1',
            notes: 'remote notes',
            lastPrompt: '',
            shellCount: 0,
            agentDef: null,
          },
        },
      }),
      revision: 7,
    });

    await expect(loadWorkspaceState()).resolves.toBe(true);
    expect(syncTerminalCounterMock).toHaveBeenCalledTimes(1);

    setStore('taskCommandControllers', {
      'stale-task': {
        action: 'send a prompt',
        controllerId: 'peer-stale',
        version: 4,
      },
    });

    await expect(loadWorkspaceState()).resolves.toBe(false);
    expect(syncTerminalCounterMock).toHaveBeenCalledTimes(1);
    expect(getLoadedWorkspaceRevision()).toBe(7);
    expect(store.taskCommandControllers).toEqual({});
  });

  it('clears stale task command controllers when browser workspace updates remove a task', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    setStore('taskCommandControllers', {
      'removed-task': {
        action: 'merge this task',
        controllerId: 'client-a',
        version: 1,
      },
      'task-1': {
        action: 'send a prompt',
        controllerId: 'client-b',
        version: 2,
      },
    });

    const persistedJson = JSON.stringify({
      projects: [{ id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          id: 'task-1',
          name: 'Remote',
          projectId: 'project-1',
          branchName: 'feature/task-1',
          worktreePath: '/tmp/project/task-1',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
        },
      },
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 1)).toBe(true);
    expect(store.taskCommandControllers).toEqual({
      'task-1': {
        action: 'send a prompt',
        controllerId: 'client-b',
        version: 2,
      },
    });
  });

  it('preserves browser-local standalone terminal state during incremental browser sync', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    setStore('activeTaskId', 'terminal-1');
    setStore('activeAgentId', 'terminal-agent-1');
    setStore('taskOrder', ['terminal-1']);
    setStore('focusedPanel', { 'terminal-1': 'terminal' });
    setStore('fontScales', {
      'terminal-1': 1.1,
      'terminal-1:terminal': 1.2,
    });
    setStore('panelSizes', { 'terminal-1:terminal': 320 });
    setStore('terminals', {
      'terminal-1': {
        id: 'terminal-1',
        name: 'Shell',
        agentId: 'terminal-agent-1',
      },
    });
    setStore('agents', {
      'terminal-agent-1': {
        id: 'terminal-agent-1',
        taskId: 'terminal-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    setStore('agentActive', { 'terminal-agent-1': true });
    setStore('agentSupervision', { 'terminal-agent-1': {} as never });

    const persistedJson = JSON.stringify({
      activeTaskId: null,
      editorCommand: 'cleanup-full-load-takeovers',
      projects: [],
      sidebarVisible: true,
      taskOrder: [],
      tasks: {},
      terminals: {},
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 2)).toBe(true);
    expect(store.terminals['terminal-1']).toEqual({
      id: 'terminal-1',
      name: 'Shell',
      agentId: 'terminal-agent-1',
    });
    expect(store.agents['terminal-agent-1']).toBeDefined();
    expect(store.agentActive['terminal-agent-1']).toBe(true);
    expect(store.agentSupervision['terminal-agent-1']).toEqual({} as never);
    expect(store.focusedPanel['terminal-1']).toBe('terminal');
    expect(store.fontScales['terminal-1']).toBe(1.1);
    expect(store.fontScales['terminal-1:terminal']).toBe(1.2);
    expect(store.panelSizes['terminal-1:terminal']).toBe(320);
    expect(store.taskOrder).toEqual(['terminal-1']);
    expect(store.activeTaskId).toBe('terminal-1');
    expect(store.activeAgentId).toBe('terminal-agent-1');
    expect(clearAgentActivityMock).not.toHaveBeenCalledWith('terminal-agent-1');
  });

  it('does not restore standalone terminals from shared browser workspace state', () => {
    isElectronRuntimeMock.mockReturnValue(false);

    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: ['terminal-1'],
      tasks: {},
      terminals: {
        'terminal-1': {
          id: 'terminal-1',
          name: 'Shell',
          agentId: 'terminal-agent-1',
        },
      },
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 3)).toBe(true);
    expect(store.taskOrder).toEqual([]);
    expect(store.terminals).toEqual({});
  });

  it('cleans removed task workspace state during incremental browser sync', () => {
    isElectronRuntimeMock.mockReturnValue(false);
    setStore('taskOrder', ['task-1']);
    setStore('focusedPanel', { 'task-1': 'terminal' });
    setStore('fontScales', {
      'task-1': 1.1,
      'task-1:terminal': 1.2,
    });
    setStore('panelSizes', { 'task-1:terminal': 320 });
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: ['shell-1'],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': {
        id: 'agent-1',
        taskId: 'task-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
      'shell-1': {
        id: 'shell-1',
        taskId: 'task-1',
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: [],
          skip_permissions_args: [],
          description: 'Claude agent',
        },
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 0,
      },
    });
    setStore('agentActive', {
      'agent-1': true,
      'shell-1': true,
    });
    setStore('agentSupervision', {
      'agent-1': {} as never,
      'shell-1': {} as never,
    });
    setStore('taskGitStatus', {
      'task-1': {} as never,
    });
    setStore('taskPorts', {
      'task-1': {} as never,
    });
    setStore('taskConvergence', {
      'task-1': {} as never,
    });
    setStore('taskReview', {
      'task-1': {} as never,
    });
    setStore('taskReviewSignals', {
      'task-1': {} as never,
    });
    setStore('taskCommandControllers', {
      'task-1': {
        action: 'send a prompt',
        controllerId: 'client-a',
        version: 1,
      },
    });
    handleGitStatusSyncEvent({
      worktreePath: '/tmp/project/task-1',
      status: {
        has_committed_changes: true,
        has_uncommitted_changes: false,
      },
    });

    const persistedJson = JSON.stringify({
      activeTaskId: null,
      editorCommand: 'cleanup-full-load-startup',
      projects: [],
      sidebarVisible: true,
      taskOrder: [],
      tasks: {},
      terminals: {},
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 3)).toBe(true);
    expect(store.tasks['task-1']).toBeUndefined();
    expect(store.taskGitStatus['task-1']).toBeUndefined();
    expect(store.taskPorts['task-1']).toBeUndefined();
    expect(store.taskConvergence['task-1']).toBeUndefined();
    expect(store.taskReview['task-1']).toBeUndefined();
    expect(store.taskReviewSignals['task-1']).toBeUndefined();
    expect(store.taskCommandControllers['task-1']).toBeUndefined();
    expect(store.agents['agent-1']).toBeUndefined();
    expect(store.agents['shell-1']).toBeUndefined();
    expect(store.agentActive['agent-1']).toBeUndefined();
    expect(store.agentActive['shell-1']).toBeUndefined();
    expect(store.agentSupervision['agent-1']).toBeUndefined();
    expect(store.agentSupervision['shell-1']).toBeUndefined();
    expect(store.focusedPanel['task-1']).toBeUndefined();
    expect(store.fontScales['task-1']).toBeUndefined();
    expect(store.fontScales['task-1:terminal']).toBeUndefined();
    expect(store.panelSizes['task-1:terminal']).toBeUndefined();
    expect(store.taskOrder).toEqual([]);
    expect(clearAgentActivityMock).toHaveBeenCalledWith('agent-1');
    expect(clearAgentActivityMock).toHaveBeenCalledWith('shell-1');
    expect(getRecentTaskGitStatusPollAge('/tmp/project/task-1')).toBeNull();
  });

  it('clears local review, permission, and pending action state during full state load', () => {
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
    setStore('pendingAction', { taskId: 'task-1', type: 'merge' });

    expect(
      applyLoadedStateJson(
        JSON.stringify({
          projects: [],
          taskOrder: [],
          tasks: {},
          terminals: {},
        }),
      ),
    ).toBe(true);
    expect(store.permissionRequests).toEqual({});
    expect(store.permissionAutoRules).toEqual([]);
    expect(store.reviewComments).toEqual({});
    expect(store.reviewPanelOpen).toEqual({});
    expect(store.pendingAction).toBeNull();
  });

  it('invalidates retained task-command lease sessions for removed tasks during incremental workspace apply', async () => {
    vi.useFakeTimers();

    const clientId = getRuntimeClientId();
    invokeMock.mockImplementation((channel: IPC, payload?: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: clientId,
              taskId: 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: payload?.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: 'type in the terminal',
              controllerId: clientId,
              renewed: true,
              taskId: payload?.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

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
      },
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 60_000,
    });

    expect(await session.acquire()).toBe(true);
    expect(session.touch()).toBe(true);

    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: [],
      tasks: {},
      terminals: {},
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 4)).toBe(true);
    expect(session.touch()).toBe(false);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_100);
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({ taskId: 'task-1' }),
    );
    const renewCalls = invokeMock.mock.calls.filter(
      ([channel, args]) => channel === IPC.RenewTaskCommandLease && args?.taskId === 'task-1',
    );
    expect(renewCalls).toEqual([]);

    session.cleanup();
    vi.useRealTimers();
  });

  it('invalidates retained task-command lease sessions during full app-state load', async () => {
    vi.useFakeTimers();

    const clientId = getRuntimeClientId();
    invokeMock.mockImplementation((channel: IPC, payload?: { taskId?: string }) => {
      switch (channel) {
        case IPC.AcquireTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              acquired: true,
              action: 'type in the terminal',
              controllerId: clientId,
              taskId: 'task-1',
            }),
          );
        case IPC.ReleaseTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: null,
              controllerId: null,
              taskId: payload?.taskId ?? 'task-1',
            }),
          );
        case IPC.RenewTaskCommandLease:
          return Promise.resolve(
            withControllerVersion({
              action: 'type in the terminal',
              controllerId: clientId,
              renewed: true,
              taskId: payload?.taskId ?? 'task-1',
            }),
          );
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`);
      }
    });

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
      },
    });

    const session = createTaskCommandLeaseSession('task-1', 'type in the terminal', {
      idleReleaseMs: 60_000,
    });

    expect(await session.acquire()).toBe(true);
    expect(session.touch()).toBe(true);

    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: [],
      tasks: {},
      terminals: {},
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(session.touch()).toBe(false);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_100);
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.ReleaseTaskCommandLease,
      expect.objectContaining({ taskId: 'task-1' }),
    );
    const renewCalls = invokeMock.mock.calls.filter(
      ([channel, args]) => channel === IPC.RenewTaskCommandLease && args?.taskId === 'task-1',
    );
    expect(renewCalls).toEqual([]);

    session.cleanup();
    vi.useRealTimers();
  });

  it('clears incoming takeover requests for removed tasks during incremental browser sync', () => {
    setStore('taskOrder', ['task-1', 'task-2']);
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
      },
      'task-2': {
        id: 'task-2',
        name: 'Task 2',
        projectId: 'project-1',
        branchName: 'feature/task-2',
        worktreePath: '/tmp/project/task-2',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('incomingTaskTakeoverRequests', {
      'request-1': {
        action: 'type in the terminal',
        expiresAt: Date.now() + 60_000,
        requestId: 'request-1',
        requesterClientId: 'peer-a',
        requesterDisplayName: 'Peer A',
        taskId: 'task-1',
      },
      'request-2': {
        action: 'type in the terminal',
        expiresAt: Date.now() + 60_000,
        requestId: 'request-2',
        requesterClientId: 'peer-b',
        requesterDisplayName: 'Peer B',
        taskId: 'task-2',
      },
    });

    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: ['task-2'],
      tasks: {
        'task-2': {
          id: 'task-2',
          name: 'Task 2',
          projectId: 'project-1',
          branchName: 'feature/task-2',
          worktreePath: '/tmp/project/task-2',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
        },
      },
      terminals: {},
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 5)).toBe(true);
    expect(getIncomingTaskTakeoverRequest('request-1')).toBeNull();
    expect(getIncomingTaskTakeoverRequest('request-2')).toEqual(
      expect.objectContaining({
        taskId: 'task-2',
      }),
    );
  });

  it('clears incoming takeover requests during full app-state load', () => {
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
      },
    });
    setStore('incomingTaskTakeoverRequests', {
      'request-1': {
        action: 'type in the terminal',
        expiresAt: Date.now() + 60_000,
        requestId: 'request-1',
        requesterClientId: 'peer-a',
        requesterDisplayName: 'Peer A',
        taskId: 'task-1',
      },
    });

    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: [],
      tasks: {},
      terminals: {},
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(getIncomingTaskTakeoverRequest('request-1')).toBeNull();
  });

  it('clears terminal startup entries for removed tasks during incremental browser sync', () => {
    setStore('taskOrder', ['task-1', 'task-2']);
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
      },
      'task-2': {
        id: 'task-2',
        name: 'Task 2',
        projectId: 'project-1',
        branchName: 'feature/task-2',
        worktreePath: '/tmp/project/task-2',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'restoring');
    registerTerminalStartupCandidate('task-2:agent-2', 'task-2');
    setTerminalStartupPhase('task-2:agent-2', 'attaching');

    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: ['task-2'],
      tasks: {
        'task-2': {
          id: 'task-2',
          name: 'Task 2',
          projectId: 'project-1',
          branchName: 'feature/task-2',
          worktreePath: '/tmp/project/task-2',
          notes: '',
          lastPrompt: '',
          shellCount: 0,
          agentDef: null,
        },
      },
      terminals: {},
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 6)).toBe(true);
    expect(getTaskTerminalStartupSummary('task-1')).toBeNull();
    expect(getTaskTerminalStartupSummary('task-2')).toEqual(
      expect.objectContaining({
        count: 1,
        phase: 'attaching',
      }),
    );
  });

  it('applies browser cold bootstrap projection without restoring runtime-owned task state or standalone terminals', () => {
    const primaryAgentDef = {
      id: 'agent-def-1',
      name: 'Seeded Test Agent',
      command: 'test-agent',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: 'seeded test agent',
    };

    setStore('taskOrder', ['task-1', 'task-2']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task 1',
        projectId: 'project-1',
        branchName: 'feature/task-1',
        worktreePath: '/tmp/project/task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
      'task-2': {
        id: 'task-2',
        name: 'Task 2',
        projectId: 'project-1',
        branchName: 'feature/task-2',
        worktreePath: '/tmp/project/task-2',
        agentIds: ['agent-2'],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
      },
    });
    setStore('agents', {
      'agent-1': {
        id: 'agent-1',
        taskId: 'task-1',
        def: primaryAgentDef,
        resumed: true,
        status: 'running',
        exitCode: null,
        signal: null,
        lastOutput: [],
        generation: 1,
      },
    });
    applyTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-a',
      taskId: 'task-1',
      version: 4,
    });
    setStore('activeTaskId', 'task-1');
    setStore('activeAgentId', 'agent-1');
    setStore('peerSessions', {
      peer: {
        clientId: 'peer',
        displayName: 'Peer session',
        focusedTaskId: 'task-1',
        joinedAt: 1,
        name: 'Peer session',
        state: 'active',
        status: 'active',
      } as never,
    });
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'restoring');
    registerTerminalStartupCandidate('task-2:agent-2', 'task-2');
    setTerminalStartupPhase('task-2:agent-2', 'attaching');

    const projection = {
      availableAgents: [primaryAgentDef],
      collapsedTaskOrder: [],
      completedTaskCount: 0,
      completedTaskDate: store.completedTaskDate,
      customAgents: [],
      hydraCommand: '',
      hydraForceDispatchFromPromptPanel: true,
      hydraStartupMode: 'auto',
      lastProjectId: null,
      mergedLinesAdded: 0,
      mergedLinesRemoved: 0,
      projects: [],
      taskOrder: ['task-2', 'shell-1'],
      tasks: {
        'task-2': {
          agentIds: [],
          id: 'task-2',
          name: 'Task 2',
          projectId: 'project-1',
          branchName: 'feature/task-2',
          worktreePath: '/tmp/project/task-2',
          shellAgentIds: [],
          notes: '',
          lastPrompt: '',
        },
      },
      terminals: {
        'shell-1': {
          id: 'shell-1',
          name: 'Shell 1',
          agentId: 'shell-agent-1',
        },
      },
    } satisfies Parameters<typeof applyBrowserColdBootstrapWorkspaceProjection>[0];

    expect(applyBrowserColdBootstrapWorkspaceProjection(projection, 7)).toBe(true);
    expect(store.taskOrder).toEqual(['task-2']);
    expect(store.tasks['task-2']).toBeDefined();
    expect(store.terminals).toEqual({});
    expect(store.agents).toEqual({});
    expect(store.activeTaskId).toBeNull();
    expect(store.activeAgentId).toBeNull();
    expect(store.peerSessions).toEqual({});
    expect(getTaskCommandController('task-1')).toBeNull();
    expect(getTaskTerminalStartupSummary('task-1')).toBeNull();
    expect(getTaskTerminalStartupSummary('task-2')).toEqual(
      expect.objectContaining({
        count: 1,
        phase: 'attaching',
      }),
    );
    expect(getLoadedWorkspaceRevision()).toBe(7);
  });

  it('clears terminal startup entries during full app-state load', () => {
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
      },
    });
    registerTerminalStartupCandidate('task-1:agent-1', 'task-1');
    setTerminalStartupPhase('task-1:agent-1', 'restoring');

    const persistedJson = JSON.stringify({
      projects: [],
      taskOrder: [],
      tasks: {},
      terminals: {},
    });

    expect(applyLoadedStateJson(persistedJson)).toBe(true);
    expect(getTaskTerminalStartupSummary('task-1')).toBeNull();
  });

  it('persists and restores the desktop intro dismissal flag', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.SaveAppState) {
        return Promise.resolve(undefined);
      }
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
            hasSeenDesktopIntro: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('hasSeenDesktopIntro', true);
    await saveState();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SaveAppState,
      expect.objectContaining({
        json: expect.stringContaining('"hasSeenDesktopIntro":true'),
      }),
    );

    setStore('hasSeenDesktopIntro', false);
    await loadState();
    expect(store.hasSeenDesktopIntro).toBe(true);
  });

  it('persists and restores the task notifications preference', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.SaveAppState) {
        return Promise.resolve(undefined);
      }
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
            terminalHighLoadMode: true,
            taskNotificationsEnabled: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('terminalHighLoadMode', true);
    setStore('taskNotificationsEnabled', true);
    await saveState();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SaveAppState,
      expect.objectContaining({
        json: expect.stringContaining('"terminalHighLoadMode":true'),
      }),
    );

    setStore('terminalHighLoadMode', false);
    setStore('taskNotificationsEnabled', false);
    await loadState();
    expect(store.terminalHighLoadMode).toBe(true);
    expect(store.taskNotificationsEnabled).toBe(true);
  });

  it('preserves the current high load mode when persisted state omits it', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('terminalHighLoadMode', true);
    syncTerminalHighLoadMode(true);

    await loadState();

    expect(store.terminalHighLoadMode).toBe(true);
    expect(isTerminalHighLoadModeEnabled()).toBe(true);
  });

  it('defaults task notifications on when restoring legacy persisted state without an initialized preference marker', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
            taskNotificationsEnabled: false,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('taskNotificationsEnabled', false);
    await loadState();

    expect(store.taskNotificationsEnabled).toBe(true);
    expect(store.taskNotificationsPreferenceInitialized).toBe(true);
  });

  it('restores the legacy desktop notification field when the preference marker is present', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
            desktopNotificationsEnabled: false,
            taskNotificationsPreferenceInitialized: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('taskNotificationsEnabled', true);
    await loadState();

    expect(store.taskNotificationsEnabled).toBe(false);
    expect(store.taskNotificationsPreferenceInitialized).toBe(true);
  });

  it('persists and restores local sidebar section collapse state in the electron full-state path', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.SaveAppState) {
        return Promise.resolve(undefined);
      }
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
            sidebarSectionCollapsed: {
              projects: true,
              progress: false,
              sessions: false,
              tips: true,
            },
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('sidebarSectionCollapsed', {
      projects: true,
      progress: false,
      sessions: false,
      tips: true,
    });
    await saveState();

    expect(invokeMock).toHaveBeenCalledWith(
      IPC.SaveAppState,
      expect.objectContaining({
        json: expect.stringContaining(
          '"sidebarSectionCollapsed":{"projects":true,"progress":false,"sessions":false,"tips":true}',
        ),
      }),
    );

    setStore('sidebarSectionCollapsed', {
      projects: false,
      progress: true,
      sessions: true,
      tips: false,
    });
    await loadState();

    expect(store.sidebarSectionCollapsed).toEqual({
      projects: true,
      progress: false,
      sessions: false,
      tips: true,
    });
  });

  it('resets local sidebar section collapse state to defaults when older electron persisted state omits it', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            tasks: {},
            activeTaskId: null,
            sidebarVisible: true,
          }),
        );
      }

      throw new Error(`Unexpected IPC channel: ${channel}`);
    });

    setStore('sidebarSectionCollapsed', {
      projects: true,
      progress: false,
      sessions: false,
      tips: false,
    });
    await loadState();

    expect(store.sidebarSectionCollapsed).toEqual({
      projects: false,
      progress: true,
      sessions: true,
      tips: true,
    });
  });
});
