import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../../store/core';
import type { PermissionRequest } from '../../store/types';
import {
  createTestAgent,
  createTestAgentDef,
  createTestTask,
  resetStoreForTest,
} from '../../test/store-test-helpers';

const { handleTaskPermissionResponseMock } = vi.hoisted(() => ({
  handleTaskPermissionResponseMock: vi.fn(),
}));

vi.mock('../../app/task-permission-workflows', () => ({
  handleTaskPermissionResponse: handleTaskPermissionResponseMock,
}));

import { createTaskPanelPermissionController } from './task-panel-permission-controller';

type TaskPanelPermissionController = ReturnType<typeof createTaskPanelPermissionController>;

function createPermissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    agentId: 'agent-1',
    arguments: '{}',
    description: 'Read a file',
    detectedAt: 1_000,
    id: 'permission-1',
    status: 'pending',
    taskId: 'task-1',
    tool: 'read_file',
    ...overrides,
  };
}

function createTestAgentWithLabel(
  agentId: string,
  label: string,
): ReturnType<typeof createTestAgent> {
  return createTestAgent({
    def: createTestAgentDef({ name: label }),
    id: agentId,
    taskId: 'task-1',
  });
}

describe('task-panel permission controller', () => {
  let disposeRoot: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
  });

  afterEach(() => {
    disposeRoot?.();
    disposeRoot = undefined;
  });

  function createController(): TaskPanelPermissionController {
    const task = createTestTask({
      agentIds: ['agent-1', 'agent-2'],
      id: 'task-1',
      shellAgentIds: ['agent-2', 'shell-1'],
    });

    setStore('tasks', { 'task-1': task });
    setStore('agents', {
      'agent-1': createTestAgentWithLabel('agent-1', 'Claude'),
      'agent-2': createTestAgentWithLabel('agent-2', 'Claude'),
      'shell-1': createTestAgentWithLabel('shell-1', 'Shell'),
    });

    let controller: TaskPanelPermissionController | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      controller = createTaskPanelPermissionController({
        task: () => task,
      });
    });

    if (!controller) {
      throw new Error('Failed to create permission controller');
    }

    return controller;
  }

  it('labels duplicate agent permission blockers without showing stale or unrelated requests', () => {
    setStore('permissionRequests', {
      'agent-1': [createPermissionRequest({ agentId: 'agent-1', id: 'permission-1' })],
      'agent-2': [
        createPermissionRequest({ agentId: 'agent-2', id: 'permission-2' }),
        createPermissionRequest({
          agentId: 'agent-2',
          id: 'permission-3',
          status: 'approved',
        }),
      ],
      'shell-1': [
        createPermissionRequest({
          agentId: 'shell-1',
          id: 'permission-4',
          taskId: 'other-task',
        }),
      ],
    });

    const controller = createController();

    expect(
      controller.pendingPermissionEntries().map((entry) => ({
        agentId: entry.agentId,
        requestId: entry.request.id,
        sourceLabel: entry.sourceLabel,
      })),
    ).toEqual([
      { agentId: 'agent-1', requestId: 'permission-1', sourceLabel: 'Claude 1' },
      { agentId: 'agent-2', requestId: 'permission-2', sourceLabel: 'Claude 2' },
    ]);
  });

  it('routes approval and denial through the agent that owns the pending request', async () => {
    setStore('permissionRequests', {
      'agent-1': [createPermissionRequest({ agentId: 'agent-1', id: 'permission-1' })],
      'agent-2': [createPermissionRequest({ agentId: 'agent-2', id: 'permission-2' })],
    });
    const controller = createController();

    await controller.approvePermissionRequest('permission-2');
    await controller.denyPermissionRequest('permission-1');
    await controller.denyPermissionRequest('missing-permission');

    expect(handleTaskPermissionResponseMock).toHaveBeenCalledTimes(2);
    expect(handleTaskPermissionResponseMock).toHaveBeenNthCalledWith(
      1,
      'agent-2',
      'permission-2',
      'approve',
    );
    expect(handleTaskPermissionResponseMock).toHaveBeenNthCalledWith(
      2,
      'agent-1',
      'permission-1',
      'deny',
    );
  });
});
