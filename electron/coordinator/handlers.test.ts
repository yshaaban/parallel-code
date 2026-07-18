import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../ipc/channels.js';
import type { HandlerContext } from '../ipc/handler-context.js';

const mocks = vi.hoisted(() => ({
  applyCoordinatorActivityHint: vi.fn(),
  createCoordinatorRunForTask: vi.fn(),
  executeCoordinatorProducer: vi.fn(
    async (_context: unknown, operation: () => Promise<unknown> | unknown) => operation(),
  ),
  executeCoordinatorRendererAction: vi.fn(),
  executeCoordinatorToolCall: vi.fn(),
}));

vi.mock('./service.js', () => ({
  applyCoordinatorActivityHint: mocks.applyCoordinatorActivityHint,
  createCoordinatorRunForTask: mocks.createCoordinatorRunForTask,
  getCoordinatorPersistenceHealth: vi.fn(() => null),
}));

vi.mock('./runtime.js', () => ({
  getCoordinatorDiagnostics: vi.fn(() => ({})),
}));

vi.mock('./tool-gateway.js', () => ({
  executeCoordinatorProducer: mocks.executeCoordinatorProducer,
  executeCoordinatorRendererAction: mocks.executeCoordinatorRendererAction,
  executeCoordinatorToolCall: mocks.executeCoordinatorToolCall,
}));

import { createCoordinatorIpcHandlers } from './handlers.js';

function createContext(): HandlerContext {
  return {
    isPackaged: false,
    sendToChannel: vi.fn(),
    userDataPath: '/tmp/parallel-code-coordinator-handlers-test',
  };
}

describe('coordinator IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeCoordinatorProducer.mockImplementation(
      async (_context: unknown, operation: () => Promise<unknown> | unknown) => operation(),
    );
  });

  it('routes direct run and activity mutations through the shared producer owner', async () => {
    const context = createContext();
    const handlers = createCoordinatorIpcHandlers(context, {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });
    const activityHint = {
      agentGeneration: 1,
      blocked: true,
      clientId: 'browser-client',
      kind: 'terminal-focus' as const,
      seq: 2,
      taskId: 'task-coordinator',
    };
    const createRun = {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git' as const,
      projectRoot: '/repo',
    };
    const expectedRun = { credentialPath: '/tmp/credential', run: { id: 'run-1' } };
    mocks.createCoordinatorRunForTask.mockReturnValue(expectedRun);

    await handlers[IPC.CoordinatorActivityHint]?.(activityHint);
    await expect(handlers[IPC.CoordinatorCreateRun]?.(createRun)).resolves.toBe(expectedRun);

    expect(mocks.executeCoordinatorProducer).toHaveBeenNthCalledWith(
      1,
      context,
      expect.any(Function),
    );
    expect(mocks.executeCoordinatorProducer).toHaveBeenNthCalledWith(
      2,
      context,
      expect.any(Function),
    );
    expect(mocks.applyCoordinatorActivityHint).toHaveBeenCalledWith(activityHint);
    expect(mocks.createCoordinatorRunForTask).toHaveBeenCalledWith(context, createRun);
  });

  it('does not mutate state when producer admission rejects the request', async () => {
    const context = createContext();
    const handlers = createCoordinatorIpcHandlers(context, {
      deleteTask: vi.fn(),
      registerCreatedTask: vi.fn(),
    });
    mocks.executeCoordinatorProducer.mockRejectedValueOnce(
      new Error('Coordinator runtime is stopping'),
    );

    await expect(
      handlers[IPC.CoordinatorCreateRun]?.({
        coordinatorAgentId: 'agent-coordinator',
        coordinatorTaskId: 'task-coordinator',
        projectId: 'project-1',
        projectMode: 'git',
        projectRoot: '/repo',
      }),
    ).rejects.toThrow('Coordinator runtime is stopping');
    expect(mocks.createCoordinatorRunForTask).not.toHaveBeenCalled();
  });
});
