import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../electron/ipc/channels.js';
import { BROWSER_CLIENT_ID_HEADER } from '../src/domain/browser-ipc.js';
import { registerBrowserIpcRoutes } from './browser-ipc.js';
import { createTaskNameRegistry, type TaskNameRegistry } from './task-names.js';

type RouteOptions = Parameters<typeof registerBrowserIpcRoutes>[0];
type TestServerOptions = {
  broadcastControl?: RouteOptions['broadcastControl'];
  emitGitStatusChanged?: RouteOptions['emitGitStatusChanged'];
  handlers: RouteOptions['handlers'];
  removeGitStatus?: RouteOptions['removeGitStatus'];
  taskNames?: TaskNameRegistry;
};

async function startTestServer(
  options: TestServerOptions,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  const server = createServer(app);

  registerBrowserIpcRoutes({
    app,
    broadcastControl: options.broadcastControl ?? vi.fn(),
    emitGitStatusChanged: options.emitGitStatusChanged ?? vi.fn(),
    handlers: options.handlers,
    isAllowedMutationRequest: () => true,
    isAuthorizedRequest: () => true,
    removeGitStatus: options.removeGitStatus,
    taskNames: options.taskNames ?? createTaskNameRegistry(),
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close(): Promise<void> {
      return closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function postBrowserIpc(
  baseUrl: string,
  channel: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/ipc/${channel}`, {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    method: 'POST',
  });
}

describe('browser IPC routes', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it('rejects unknown IPC route channels before dispatch', async () => {
    const loadAppState = vi.fn();
    const server = await startTestServer({
      handlers: {
        [IPC.LoadAppState]: loadAppState,
      },
    });
    cleanup.push(server.close);

    const response = await postBrowserIpc(server.baseUrl, 'not_an_ipc_channel', {});

    await expect(response.json()).resolves.toEqual({ error: 'unknown ipc channel' });
    expect(response.status).toBe(404);
    expect(loadAppState).not.toHaveBeenCalled();
  });

  it.each([
    { body: [], label: 'array' },
    { body: null, label: 'null' },
    { body: 'not an object', label: 'string' },
    { body: 42, label: 'number' },
  ])('rejects $label IPC request bodies before dispatch', async ({ body }) => {
    const loadAppState = vi.fn();
    const server = await startTestServer({
      handlers: {
        [IPC.LoadAppState]: loadAppState,
      },
    });
    cleanup.push(server.close);

    const response = await postBrowserIpc(server.baseUrl, IPC.LoadAppState, body);

    await expect(response.json()).resolves.toEqual({
      error: 'IPC request body must be a JSON object',
    });
    expect(response.status).toBe(400);
    expect(loadAppState).not.toHaveBeenCalled();
  });

  it('passes object IPC request bodies and injects browser controller identity', async () => {
    const writeToAgent = vi.fn().mockResolvedValue({ accepted: true });
    const server = await startTestServer({
      handlers: {
        [IPC.WriteToAgent]: writeToAgent,
      },
    });
    cleanup.push(server.close);

    const response = await postBrowserIpc(
      server.baseUrl,
      IPC.WriteToAgent,
      {
        agentId: 'agent-1',
        data: 'echo ok\n',
      },
      {
        [BROWSER_CLIENT_ID_HEADER]: ' browser-client-1 ',
      },
    );

    await expect(response.json()).resolves.toEqual({ result: { accepted: true } });
    expect(response.status).toBe(200);
    expect(writeToAgent).toHaveBeenCalledWith({
      agentId: 'agent-1',
      controllerId: 'browser-client-1',
      data: 'echo ok\n',
    });
  });

  it('synchronizes created task metadata and broadcasts the created task event', async () => {
    const broadcastControl = vi.fn();
    const taskNames = createTaskNameRegistry();
    const createTask = vi.fn().mockResolvedValue({
      branch_name: 'feature/task-1',
      git_isolation: 'existing-worktree',
      id: 'task-1',
      worktree_path: '/repo/.worktrees/task-1',
    });
    const server = await startTestServer({
      broadcastControl,
      handlers: {
        [IPC.CreateTask]: createTask,
      },
      taskNames,
    });
    cleanup.push(server.close);

    const response = await postBrowserIpc(server.baseUrl, IPC.CreateTask, {
      agentDefId: 'claude',
      agentDefName: 'Claude',
      name: 'Fix preview',
    });

    await expect(response.json()).resolves.toEqual({
      result: {
        branch_name: 'feature/task-1',
        git_isolation: 'existing-worktree',
        id: 'task-1',
        worktree_path: '/repo/.worktrees/task-1',
      },
    });
    expect(response.status).toBe(200);
    expect(taskNames.getTaskName('task-1')).toBe('Fix preview');
    expect(taskNames.getTaskMetadata('task-1')).toMatchObject({
      agentDefId: 'claude',
      agentDefName: 'Claude',
      branchName: 'feature/task-1',
      directMode: false,
      folderName: 'task-1',
      gitIsolation: 'existing-worktree',
      worktreeOwnership: 'external',
    });
    expect(broadcastControl).toHaveBeenCalledWith({
      type: 'task-event',
      event: 'created',
      taskId: 'task-1',
      branchName: 'feature/task-1',
      name: 'Fix preview',
      worktreePath: '/repo/.worktrees/task-1',
    });
  });

  it('removes deleted task metadata and refreshes the affected git status owner', async () => {
    const broadcastControl = vi.fn();
    const emitGitStatusChanged = vi.fn();
    const removeGitStatus = vi.fn();
    const taskNames = createTaskNameRegistry();
    taskNames.registerCreatedTask('task-1', {
      branchName: 'feature/task-1',
      taskName: 'Fix preview',
      worktreePath: '/repo/.worktrees/task-1',
      worktreeOwnership: 'managed',
    });
    const deleteTask = vi.fn().mockResolvedValue({ ok: true });
    const server = await startTestServer({
      broadcastControl,
      emitGitStatusChanged,
      handlers: {
        [IPC.DeleteTask]: deleteTask,
      },
      removeGitStatus,
      taskNames,
    });
    cleanup.push(server.close);

    const response = await postBrowserIpc(server.baseUrl, IPC.DeleteTask, {
      branchName: 'feature/task-1',
      projectRoot: '/repo',
      taskId: 'task-1',
      worktreePath: '/repo/.worktrees/task-1',
    });

    await expect(response.json()).resolves.toEqual({ result: { ok: true } });
    expect(response.status).toBe(200);
    expect(taskNames.getTaskMetadata('task-1')).toBeNull();
    expect(broadcastControl).toHaveBeenCalledWith({
      type: 'task-event',
      event: 'deleted',
      taskId: 'task-1',
      branchName: 'feature/task-1',
      worktreePath: '/repo/.worktrees/task-1',
    });
    expect(emitGitStatusChanged).toHaveBeenCalledWith({
      branchName: 'feature/task-1',
      projectRoot: '/repo',
      worktreePath: '/repo/.worktrees/task-1',
    });
    expect(removeGitStatus).toHaveBeenCalledWith('/repo/.worktrees/task-1');
  });

  it('removes cleaned-up current-branch task metadata and broadcasts deletion', async () => {
    const broadcastControl = vi.fn();
    const emitGitStatusChanged = vi.fn();
    const removeGitStatus = vi.fn();
    const taskNames = createTaskNameRegistry();
    taskNames.registerCreatedTask('task-1', {
      branchName: 'main',
      directMode: true,
      taskName: 'Current branch task',
      worktreePath: '/repo',
      worktreeOwnership: 'managed',
    });
    const cleanupTaskRuntime = vi.fn().mockResolvedValue(undefined);
    const server = await startTestServer({
      broadcastControl,
      emitGitStatusChanged,
      handlers: {
        [IPC.CleanupTaskRuntime]: cleanupTaskRuntime,
      },
      removeGitStatus,
      taskNames,
    });
    cleanup.push(server.close);

    const response = await postBrowserIpc(server.baseUrl, IPC.CleanupTaskRuntime, {
      agentIds: [],
      removeTaskState: true,
      taskId: 'task-1',
      worktreePath: '/repo',
    });

    await expect(response.json()).resolves.toEqual({});
    expect(response.status).toBe(200);
    expect(taskNames.getTaskMetadata('task-1')).toBeNull();
    expect(broadcastControl).toHaveBeenCalledWith({
      type: 'task-event',
      event: 'deleted',
      taskId: 'task-1',
      worktreePath: '/repo',
    });
    expect(emitGitStatusChanged).toHaveBeenCalledWith({
      worktreePath: '/repo',
    });
    expect(removeGitStatus).toHaveBeenCalledWith('/repo');
  });
});
