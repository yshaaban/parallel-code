import { describe, expect, it } from 'vitest';
import {
  createTaskCommandOwnerStatus,
  findMostRecentControllingSession,
  getPresenceBackedTaskCommandOwnerStatus,
  getTaskCommandControllerOwnerStatus,
} from './task-command-owner-status';

describe('task-command owner status helpers', () => {
  it('creates self-aware owner labels', () => {
    expect(
      createTaskCommandOwnerStatus({
        action: 'type in the terminal',
        controllerId: 'client-self',
        displayName: 'Ignored',
        selfClientId: 'client-self',
      }),
    ).toEqual({
      action: 'type in the terminal',
      controllerId: 'client-self',
      isSelf: true,
      label: 'You typing',
    });
  });

  it('prefers the most recent controlling session that matches the task', () => {
    expect(
      findMostRecentControllingSession(
        'task-1',
        [
          {
            activeTaskId: 'task-1',
            clientId: 'peer-old',
            controllingAgentIds: [],
            controllingTaskIds: ['task-1'],
            displayName: 'Old',
            focusedSurface: 'prompt',
            lastSeenAt: 10,
            visibility: 'visible',
          },
          {
            activeTaskId: 'task-1',
            clientId: 'peer-new',
            controllingAgentIds: [],
            controllingTaskIds: ['task-1'],
            displayName: 'New',
            focusedSurface: 'terminal',
            lastSeenAt: 20,
            visibility: 'visible',
          },
        ],
        { selfClientId: 'client-self' },
      ),
    )?.toMatchObject({
      clientId: 'peer-new',
      displayName: 'New',
    });
  });

  it('derives presence-backed typing status from the focused surface', () => {
    expect(
      getPresenceBackedTaskCommandOwnerStatus(
        'task-1',
        [
          {
            activeTaskId: 'task-1',
            clientId: 'peer-1',
            controllingAgentIds: [],
            controllingTaskIds: ['task-1'],
            displayName: 'Ivan',
            focusedSurface: 'terminal',
            lastSeenAt: 20,
            visibility: 'visible',
          },
        ],
        {
          fallbackAction: 'control this task',
          selfClientId: 'client-self',
        },
      ),
    ).toEqual({
      action: 'type in the terminal',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan typing',
    });
  });

  it('builds controller-backed owner status from the shared snapshot shape', () => {
    expect(
      getTaskCommandControllerOwnerStatus(
        {
          action: null,
          controllerId: 'peer-1',
        },
        {
          fallbackAction: 'control this task',
          getDisplayName: (controllerId) => (controllerId === 'peer-1' ? 'Ivan' : null),
          selfClientId: 'client-self',
        },
      ),
    ).toEqual({
      action: 'control this task',
      controllerId: 'peer-1',
      isSelf: false,
      label: 'Ivan active',
    });
  });
});
