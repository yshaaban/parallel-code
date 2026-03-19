import { fireEvent, render, screen } from '@solidjs/testing-library';
import { Show, type JSX } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetStoreForTest } from '../test/store-test-helpers';

const { setDesktopNotificationsEnabledMock } = vi.hoisted(() => ({
  setDesktopNotificationsEnabledMock: vi.fn(),
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
    setDesktopNotificationsEnabled: setDesktopNotificationsEnabledMock,
  };
});

import { SettingsDialog } from './SettingsDialog';

describe('SettingsDialog', () => {
  beforeEach(() => {
    resetStoreForTest();
    setDesktopNotificationsEnabledMock.mockReset();
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

  it('shows the desktop notifications toggle in Electron and wires it to the shared ui setter', () => {
    render(() => <SettingsDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText('Desktop notifications'));

    expect(setDesktopNotificationsEnabledMock).toHaveBeenCalledWith(true);
  });

  it('hides the desktop notifications toggle outside Electron', () => {
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: undefined,
    });

    render(() => <SettingsDialog open onClose={() => {}} />);

    expect(screen.queryByLabelText('Desktop notifications')).toBeNull();
  });
});
