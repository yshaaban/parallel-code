import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { store } from './core';
import { loadState, saveState } from './persistence';
import { setStore } from './core';
import { resetStoreForTest } from '../test/store-test-helpers';

const { invokeMock, markAgentSpawnedMock, randomPastelColorMock, syncTerminalCounterMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    markAgentSpawnedMock: vi.fn(),
    randomPastelColorMock: vi.fn(() => '#8899aa'),
    syncTerminalCounterMock: vi.fn(),
  }));

vi.mock('../lib/ipc', () => ({
  invoke: invokeMock,
}));

vi.mock('./projects', () => ({
  randomPastelColor: randomPastelColorMock,
}));

vi.mock('./taskStatus', () => ({
  markAgentSpawned: markAgentSpawnedMock,
}));

vi.mock('./terminals', () => ({
  syncTerminalCounter: syncTerminalCounterMock,
}));

describe('persistence integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
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
});
