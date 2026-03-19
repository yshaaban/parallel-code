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
});
