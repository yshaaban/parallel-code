import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from './channels.js';
import type { HandlerContext } from './handler-context.js';

const {
  destroyTaskContainersMock,
  getTaskContainerLogsMock,
  inspectTaskContainersMock,
  startTaskContainersMock,
  stopTaskContainersMock,
} = vi.hoisted(() => ({
  destroyTaskContainersMock: vi.fn(),
  getTaskContainerLogsMock: vi.fn(),
  inspectTaskContainersMock: vi.fn(),
  startTaskContainersMock: vi.fn(),
  stopTaskContainersMock: vi.fn(),
}));

vi.mock('./task-containers.js', () => ({
  destroyTaskContainers: destroyTaskContainersMock,
  getTaskContainerLogs: getTaskContainerLogsMock,
  inspectTaskContainers: inspectTaskContainersMock,
  startTaskContainers: startTaskContainersMock,
  stopTaskContainers: stopTaskContainersMock,
}));

import { createTaskContainerIpcHandlers } from './task-container-handlers.js';

function createContext(): HandlerContext {
  return {
    isPackaged: false,
    sendToChannel: vi.fn(),
    userDataPath: '/tmp/parallel-task-container-handlers',
  };
}

describe('createTaskContainerIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectTaskContainersMock.mockResolvedValue({ status: 'ready' });
    startTaskContainersMock.mockResolvedValue({ status: 'running' });
    stopTaskContainersMock.mockResolvedValue({ status: 'ready' });
    destroyTaskContainersMock.mockResolvedValue({ status: 'ready' });
    getTaskContainerLogsMock.mockResolvedValue({ text: '', truncated: false });
  });

  it('normalizes repo-scoped container config before forwarding inspect requests', async () => {
    const handlers = createTaskContainerIpcHandlers(createContext());

    await handlers[IPC.ContainersInspectTask]?.({
      projectContainerConfig: {
        composeFile: 'compose.yaml',
        previewPorts: [{ label: 'Web', port: 3000, protocol: 'http' }],
        requiredEnvFiles: ['.env.local'],
      },
      projectPath: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-1',
    });

    expect(inspectTaskContainersMock).toHaveBeenCalledWith({
      projectContainerConfig: {
        composeFile: 'compose.yaml',
        previewPorts: [{ label: 'Web', port: 3000, protocol: 'http' }],
        requiredEnvFiles: ['.env.local'],
      },
      projectPath: '/tmp/project',
      taskId: 'task-1',
      userDataPath: '/tmp/parallel-task-container-handlers',
      worktreePath: '/tmp/project/.worktrees/task-1',
    });
  });

  it('rejects invalid preview port config before reaching the backend owner', async () => {
    const handlers = createTaskContainerIpcHandlers(createContext());

    expect(() =>
      handlers[IPC.ContainersInspectTask]?.({
        projectContainerConfig: {
          previewPorts: [{ port: '3000' }],
        },
        projectPath: '/tmp/project',
        taskId: 'task-1',
        worktreePath: '/tmp/project/.worktrees/task-1',
      }),
    ).toThrow('projectContainerConfig.previewPorts[0].port must be an integer');

    expect(inspectTaskContainersMock).not.toHaveBeenCalled();
  });

  it('rejects compose file overrides that escape the task worktree before reaching the backend owner', () => {
    const handlers = createTaskContainerIpcHandlers(createContext());

    expect(() =>
      handlers[IPC.ContainersInspectTask]?.({
        projectContainerConfig: {
          composeFile: '../outside/compose.yaml',
        },
        projectPath: '/tmp/project',
        taskId: 'task-1',
        worktreePath: '/tmp/project/.worktrees/task-1',
      }),
    ).toThrow('projectContainerConfig.composeFile must not contain ".."');

    expect(inspectTaskContainersMock).not.toHaveBeenCalled();
  });

  it('forwards optional log line counts through the logs handler', async () => {
    const handlers = createTaskContainerIpcHandlers(createContext());

    await handlers[IPC.ContainersGetTaskLogs]?.({
      lines: 50,
      projectPath: '/tmp/project',
      taskId: 'task-1',
      worktreePath: '/tmp/project/.worktrees/task-1',
    });

    expect(getTaskContainerLogsMock).toHaveBeenCalledWith({
      lines: 50,
      projectPath: '/tmp/project',
      taskId: 'task-1',
      userDataPath: '/tmp/parallel-task-container-handlers',
      worktreePath: '/tmp/project/.worktrees/task-1',
    });
  });
});
