import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientIdQueueRef } = vi.hoisted(() => ({
  clientIdQueueRef: {
    current: [] as string[],
  },
}));

vi.mock('../lib/client-id', () => ({
  getPersistentClientId: vi.fn(() => clientIdQueueRef.current.shift() ?? 'default-tab'),
}));

import { createTaskNotificationClaimCoordinator } from './task-notification-claims';

describe('task-notification-claims', () => {
  beforeEach(() => {
    clientIdQueueRef.current = [];
    localStorage.clear();
  });

  it('deduplicates the same notification burst across different tab ids', () => {
    clientIdQueueRef.current = ['tab-1', 'tab-2'];

    const firstCoordinator = createTaskNotificationClaimCoordinator();
    const secondCoordinator = createTaskNotificationClaimCoordinator();

    expect(firstCoordinator.claim('ready:task-1')).toBe(true);
    expect(secondCoordinator.claim('ready:task-1')).toBe(false);

    firstCoordinator.dispose();
    secondCoordinator.dispose();
  });

  it('ignores malformed stored claims without blocking valid notification claims', () => {
    clientIdQueueRef.current = ['tab-1'];
    localStorage.setItem(
      'parallel-code-task-notification-claims',
      JSON.stringify({
        'ready:invalid-null': null,
        'ready:invalid-expiration': {
          expiresAt: 'soon',
          ownerId: 'tab-2',
        },
        'ready:invalid-negative-expiration': {
          expiresAt: -1,
          ownerId: 'tab-2',
        },
        'ready:invalid-fractional-expiration': {
          expiresAt: Date.now() + 10_000.5,
          ownerId: 'tab-2',
        },
        'ready:owned-by-other-tab': {
          expiresAt: Date.now() + 10_000,
          ownerId: 'tab-2',
        },
      }),
    );

    const coordinator = createTaskNotificationClaimCoordinator();

    expect(coordinator.claim('ready:invalid-null')).toBe(true);
    expect(coordinator.claim('ready:invalid-expiration')).toBe(true);
    expect(coordinator.claim('ready:invalid-negative-expiration')).toBe(true);
    expect(coordinator.claim('ready:invalid-fractional-expiration')).toBe(true);
    expect(coordinator.claim('ready:owned-by-other-tab')).toBe(false);

    coordinator.dispose();
  });
});
