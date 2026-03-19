import { fireEvent, render, screen } from '@solidjs/testing-library';
import { Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskNotificationCapability } from '../domain/task-notification';
import { setStore } from '../store/core';
import { resetStoreForTest } from '../test/store-test-helpers';

const {
  refreshTaskNotificationCapabilityMock,
  requestTaskNotificationPermissionMock,
  setTaskNotificationsEnabledMock,
  taskNotificationCapabilityRef,
} = vi.hoisted(() => ({
  refreshTaskNotificationCapabilityMock: vi.fn(),
  requestTaskNotificationPermissionMock: vi.fn(),
  setTaskNotificationsEnabledMock: vi.fn(),
  taskNotificationCapabilityRef: {
    current: {
      checking: false,
      permission: 'granted',
      provider: 'electron',
      supported: true,
    } as TaskNotificationCapability,
  },
}));

vi.mock('./Dialog', () => ({
  Dialog: (props: { children: JSX.Element; open: boolean }) => (
    <Show when={props.open}>
      <div>{props.children}</div>
    </Show>
  ),
}));

vi.mock('./CustomAgentEditor', () => ({
  CustomAgentEditor: () => <div>Custom agent editor</div>,
}));

vi.mock('../store/store', async () => {
  const actual = await vi.importActual<typeof import('../store/store')>('../store/store');
  return {
    ...actual,
    setTaskNotificationsEnabled: setTaskNotificationsEnabledMock,
  };
});

vi.mock('../app/task-notification-capabilities', () => ({
  getTaskNotificationCapability: () => taskNotificationCapabilityRef.current,
  refreshTaskNotificationCapability: refreshTaskNotificationCapabilityMock,
  requestTaskNotificationPermission: requestTaskNotificationPermissionMock,
  resetTaskNotificationCapabilityStateForTests: vi.fn(),
}));

import { SettingsDialog } from './SettingsDialog';

describe('SettingsDialog', () => {
  beforeEach(() => {
    resetStoreForTest();
    setTaskNotificationsEnabledMock.mockReset();
    refreshTaskNotificationCapabilityMock.mockReset();
    requestTaskNotificationPermissionMock.mockReset();
    requestTaskNotificationPermissionMock.mockResolvedValue({
      checking: false,
      permission: 'granted',
      provider: 'web',
      supported: true,
    } satisfies TaskNotificationCapability);
    taskNotificationCapabilityRef.current = {
      checking: false,
      permission: 'granted',
      provider: 'electron',
      supported: true,
    };
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        ipcRenderer: {
          invoke: vi.fn(),
          on: vi.fn(() => vi.fn()),
          removeAllListeners: vi.fn(),
        },
      },
    });
  });

  it('shows the task notifications toggle in Electron and wires it to the shared ui setter', () => {
    setStore('taskNotificationsEnabled', false);

    render(() => <SettingsDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText('Task notifications'));

    expect(setTaskNotificationsEnabledMock).toHaveBeenCalledWith(true);
  });

  it('keeps the browser task notification toggle interactive before permission is granted', () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: undefined,
    });
    taskNotificationCapabilityRef.current = {
      checking: false,
      permission: 'default',
      provider: 'web',
      supported: true,
    };

    render(() => <SettingsDialog open onClose={() => {}} />);

    const checkbox = screen.getByLabelText('Task notifications');
    expect(checkbox.getAttribute('disabled')).toBeNull();
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Allow browser notifications' })).toBeDefined();
  });

  it('requests browser permission when enabling task notifications from the toggle', () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: undefined,
    });
    setStore('taskNotificationsEnabled', false);
    taskNotificationCapabilityRef.current = {
      checking: false,
      permission: 'default',
      provider: 'web',
      supported: true,
    };

    render(() => <SettingsDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText('Task notifications'));

    expect(requestTaskNotificationPermissionMock).toHaveBeenCalledTimes(1);
    expect(setTaskNotificationsEnabledMock).toHaveBeenCalledWith(true);
  });

  it('requests browser permission from the explicit browser action when notifications stay enabled', () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: undefined,
    });
    taskNotificationCapabilityRef.current = {
      checking: false,
      permission: 'default',
      provider: 'web',
      supported: true,
    };

    render(() => <SettingsDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Allow browser notifications' }));

    expect(requestTaskNotificationPermissionMock).toHaveBeenCalledTimes(1);
    expect(setTaskNotificationsEnabledMock).toHaveBeenCalledWith(true);
  });

  it('hides task notification controls when no provider is available', () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: undefined,
    });
    taskNotificationCapabilityRef.current = {
      checking: false,
      permission: 'unavailable',
      provider: 'none',
      supported: false,
    };

    render(() => <SettingsDialog open onClose={() => {}} />);

    expect(screen.queryByLabelText('Task notifications')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow browser notifications' })).toBeNull();
  });
});
