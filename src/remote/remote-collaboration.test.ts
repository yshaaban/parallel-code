import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

vi.mock('./client-id', () => ({
  getRemoteClientId: vi.fn(() => 'remote-client-1234'),
}));

import {
  applyRemoteIpcEvent,
  applyRemoteStateBootstrap,
  applyRemoteTaskCommandControllerChanged,
  clearIncomingRemoteTakeoverRequests,
  getIncomingRemoteTakeoverRequests,
  getRemoteTaskCommandController,
  getRemoteControllingTaskIds,
  getRemoteTaskControllerOwnerStatus,
  getRemoteTaskOwnerStatus,
  replaceRemotePeerPresences,
  resetRemoteCollaborationStateForTests,
  subscribeRemoteTaskCommandControllerChanges,
  upsertIncomingRemoteTakeoverRequest,
} from './remote-collaboration';

describe('remote collaboration state', () => {
  beforeEach(() => {
    resetRemoteCollaborationStateForTests();
  });

  afterEach(() => {
    resetRemoteCollaborationStateForTests();
  });

  it('derives controlled task ids from backend task-command controller truth', () => {
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      taskId: 'task-1',
      version: 1,
    });

    expect(getRemoteControllingTaskIds()).toEqual(['task-1']);
    expect(getRemoteTaskControllerOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      isSelf: true,
      label: 'You typing',
    });
    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      isSelf: true,
      label: 'You typing',
    });
  });

  it('uses peer presence only for display cues when controller snapshots have not arrived yet', () => {
    replaceRemotePeerPresences([
      {
        activeTaskId: 'task-1',
        clientId: 'peer-1',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'remote-terminal',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toBeNull();
    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    });
  });

  it('treats the desktop terminal panel as a typing surface for presence-backed cues', () => {
    replaceRemotePeerPresences([
      {
        activeTaskId: 'task-1',
        clientId: 'peer-1',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Ivan',
        focusedSurface: 'terminal',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);

    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    });
  });

  it('ignores stale controller change events that arrive after a newer snapshot', () => {
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      taskId: 'task-1',
      version: 5,
    });
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-old',
      taskId: 'task-1',
      version: 4,
    });

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      isSelf: false,
      label: 'Another session typing',
    });
  });

  it('applies remote task-command controller ipc-events through the explicit live-event classifier', () => {
    applyRemoteIpcEvent(IPC.TaskCommandControllerChanged, {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 1,
    });

    expect(getRemoteTaskCommandController('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: 1,
    });
  });

  it('explicitly ignores live ipc-event channels that the remote UI does not consume yet', () => {
    const listener = vi.fn();
    const cleanup = subscribeRemoteTaskCommandControllerChanges(listener);
    const ignoredChannels = [
      IPC.AgentSupervisionChanged,
      IPC.GitStatusChanged,
      IPC.TaskConvergenceChanged,
      IPC.TaskReviewChanged,
    ] as const;

    for (const channel of ignoredChannels) {
      applyRemoteIpcEvent(channel, {});
    }

    expect(getRemoteTaskCommandController('task-1')).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    cleanup();
  });

  it('ignores malformed task-command controller ipc-event payloads', () => {
    applyRemoteIpcEvent(IPC.TaskCommandControllerChanged, {
      action: 'type in the terminal',
      controllerId: 'peer-1',
      taskId: 'task-1',
      version: '1',
    });

    expect(getRemoteTaskCommandController('task-1')).toBeNull();
  });

  it('ignores stale task-controller bootstrap payloads', () => {
    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [
          {
            action: 'type in the terminal',
            controllerId: 'peer-new',
            taskId: 'task-1',
            version: 5,
          },
        ],
        version: 5,
      },
    ]);
    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [
          {
            action: 'type in the terminal',
            controllerId: 'peer-old',
            taskId: 'task-1',
            version: 4,
          },
        ],
        version: 4,
      },
    ]);

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      isSelf: false,
      label: 'Another session typing',
    });
  });

  it('notifies listeners when bootstrap replacement changes or clears controllers', () => {
    const listener = vi.fn();
    const cleanup = subscribeRemoteTaskCommandControllerChanges(listener);

    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [
          {
            action: 'type in the terminal',
            controllerId: 'peer-new',
            taskId: 'task-1',
            version: 5,
          },
        ],
        version: 5,
      },
    ]);

    expect(listener).toHaveBeenCalledWith({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      taskId: 'task-1',
      version: 5,
    });

    applyRemoteStateBootstrap([
      {
        category: 'task-command-controller',
        mode: 'replace',
        payload: [],
        version: 6,
      },
    ]);

    expect(listener).toHaveBeenLastCalledWith({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 6,
    });

    cleanup();
  });

  it('keeps the controller cleared when a stale controller event arrives after removal', () => {
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-new',
      taskId: 'task-1',
      version: 5,
    });
    applyRemoteTaskCommandControllerChanged({
      action: null,
      controllerId: null,
      taskId: 'task-1',
      version: 6,
    });
    replaceRemotePeerPresences([
      {
        activeTaskId: 'task-1',
        clientId: 'remote-client-1234',
        controllingAgentIds: [],
        controllingTaskIds: ['task-1'],
        displayName: 'Mobile Self',
        focusedSurface: 'terminal',
        lastSeenAt: Date.now(),
        visibility: 'visible',
      },
    ]);
    applyRemoteTaskCommandControllerChanged({
      action: 'type in the terminal',
      controllerId: 'peer-stale',
      taskId: 'task-1',
      version: 5,
    });

    expect(getRemoteTaskControllerOwnerStatus('task-1')).toBeNull();
    expect(getRemoteTaskOwnerStatus('task-1')).toEqual({
      action: 'type in the terminal',
      controllerId: 'remote-client-1234',
      isSelf: true,
      label: 'You typing',
    });
  });

  it('can clear incoming takeover requests on transport loss', () => {
    upsertIncomingRemoteTakeoverRequest({
      action: 'type in the terminal',
      expiresAt: Date.now() + 10_000,
      requestId: 'request-1',
      requesterClientId: 'peer-1',
      requesterDisplayName: 'Ivan',
      taskId: 'task-1',
      type: 'task-command-takeover-request',
    });

    clearIncomingRemoteTakeoverRequests();

    expect(getIncomingRemoteTakeoverRequests()).toEqual([]);
  });
});
