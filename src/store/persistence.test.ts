import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { store } from './core';
import {
  applyLoadedWorkspaceStateJson,
  loadState,
  loadWorkspaceState,
  saveState,
} from './persistence';
import { setStore } from './core';
import { resetStoreForTest } from '../test/store-test-helpers';

const {
  clearAgentActivityMock,
  invokeMock,
  isElectronRuntimeMock,
  markAgentSpawnedMock,
  randomPastelColorMock,
  syncTerminalCounterMock,
} = vi.hoisted(() => ({
  clearAgentActivityMock: vi.fn(),
  invokeMock: vi.fn(),
  isElectronRuntimeMock: vi.fn(),
  markAgentSpawnedMock: vi.fn(),
  randomPastelColorMock: vi.fn(() => '#8899aa'),
  syncTerminalCounterMock: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
  isElectronRuntime: isElectronRuntimeMock,
}));

vi.mock('./projects', () => ({
  randomPastelColor: randomPastelColorMock,
}));

vi.mock('./taskStatus', () => ({
  clearAgentActivity: clearAgentActivityMock,
  markAgentSpawned: markAgentSpawnedMock,
}));

vi.mock('./terminals', () => ({
  syncTerminalCounter: syncTerminalCounterMock,
}));

describe('persistence integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
    isElectronRuntimeMock.mockReturnValue(true);
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

  it('filters corrupted task ordering and prevents a task from being both active and collapsed', async () => {
    invokeMock.mockImplementation((channel: IPC) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [
              { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
            ],
            taskOrder: ['task-1', 'missing-task'],
            collapsedTaskOrder: ['task-1', 'task-2'],
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

  it('persists active and collapsed tasks with the expected optional fields', async () => {
    invokeMock.mockResolvedValue(undefined);
    setStore('projects', [
      { id: 'project-1', name: 'Project', path: '/tmp/project', color: '#123456' },
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
        planFileName: 'task-1-plan.md',
        planRelativePath: 'docs/plans/task-1-plan.md',
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
      tasks: Record<string, Record<string, unknown>>;
      windowState: Record<string, unknown>;
    };

    expect(persisted.tasks['task-1']).toMatchObject({
      directMode: true,
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
    });
    expect(persisted.tasks['task-2']).toMatchObject({
      collapsed: true,
      agentDef: expect.objectContaining({ id: 'claude' }),
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
        closingStatus: 'removing',
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
        closingStatus: 'removing',
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
    setStore('terminalFont', 'Fira Code');
    setStore('themePreset', 'graphite');
    setStore('showPlans', false);
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
    expect(persisted).not.toHaveProperty('terminalFont');
    expect(persisted).not.toHaveProperty('themePreset');
    expect(persisted).not.toHaveProperty('showPlans');
    expect(persisted).not.toHaveProperty('inactiveColumnOpacity');
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
    expect(store.tasks['task-2']?.planFileName).toBe('task-2-plan.md');
    expect(store.tasks['task-2']?.planRelativePath).toBe('.claude/plans/task-2-plan.md');
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

  it('cleans up removed terminal workspace state during incremental browser sync', () => {
    isElectronRuntimeMock.mockReturnValue(false);
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
      projects: [],
      taskOrder: [],
      tasks: {},
      terminals: {},
    });

    expect(applyLoadedWorkspaceStateJson(persistedJson, 2)).toBe(true);
    expect(store.terminals['terminal-1']).toBeUndefined();
    expect(store.agents['terminal-agent-1']).toBeUndefined();
    expect(store.agentActive['terminal-agent-1']).toBeUndefined();
    expect(store.agentSupervision['terminal-agent-1']).toBeUndefined();
    expect(store.focusedPanel['terminal-1']).toBeUndefined();
    expect(store.fontScales['terminal-1']).toBeUndefined();
    expect(store.fontScales['terminal-1:terminal']).toBeUndefined();
    expect(store.panelSizes['terminal-1:terminal']).toBeUndefined();
    expect(store.taskOrder).toEqual([]);
    expect(clearAgentActivityMock).toHaveBeenCalledWith('terminal-agent-1');
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
});
