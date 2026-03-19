import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetStoreForTest } from '../test/store-test-helpers';
import {
  getTaskNotificationCapability,
  requestTaskNotificationPermission,
} from './task-notification-capabilities';

describe('task-notification-capabilities', () => {
  beforeEach(() => {
    const notificationStub = {
      permission: 'default' as NotificationPermission,
      requestPermission: vi.fn().mockResolvedValue('denied'),
    };

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: notificationStub,
    });
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: notificationStub,
    });
    resetStoreForTest();
  });

  it('resets the module-local capability owner through the shared store reset path', async () => {
    await requestTaskNotificationPermission();

    expect(getTaskNotificationCapability()).toMatchObject({
      permission: 'denied',
      provider: 'web',
      supported: true,
    });

    resetStoreForTest();

    expect(getTaskNotificationCapability()).toMatchObject({
      checking: false,
      permission: 'default',
      provider: 'web',
      supported: true,
    });
  });
});
