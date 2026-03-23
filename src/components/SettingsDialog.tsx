import { For, Show, createEffect, createMemo, type JSX } from 'solid-js';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { isElectronRuntime } from '../lib/browser-auth';
import { getAvailableTerminalFonts, getTerminalFontFamily, LIGATURE_FONTS } from '../lib/fonts';
import { HYDRA_STARTUP_MODES, isHydraStartupMode, type HydraStartupMode } from '../lib/hydra';
import { LOOK_PRESETS } from '../lib/look';
import { theme } from '../lib/theme';
import {
  getTaskNotificationCapability,
  refreshTaskNotificationCapability,
  requestTaskNotificationPermission,
} from '../app/task-notification-capabilities';
import { setHydraCommand } from '../app/hydra-settings';
import type { TaskNotificationCapability } from '../domain/task-notification';
import {
  store,
  setTerminalFont,
  setThemePreset,
  setAutoTrustFolders,
  setShowPlans,
  setTaskNotificationsEnabled,
  setInactiveColumnOpacity,
  setEditorCommand,
  setHydraForceDispatchFromPromptPanel,
  setHydraStartupMode,
} from '../store/store';
import { CustomAgentEditor } from './CustomAgentEditor';
import { mod } from '../lib/platform';
import { SectionLabel } from './SectionLabel';
import { typography } from '../lib/typography';
import type { TerminalFont } from '../lib/fonts';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface TaskNotificationSettingState {
  canToggle: boolean;
  description: string;
  permissionButtonLabel: string | null;
  showEnableButton: boolean;
  showSetting: boolean;
}

const HYDRA_STARTUP_MODE_LABELS: Record<HydraStartupMode, string> = {
  auto: 'Auto',
  dispatch: 'Dispatch',
  smart: 'Smart',
  council: 'Council',
};

function getTaskNotificationDescription(
  capability: TaskNotificationCapability,
  enabled: boolean,
): string {
  if (capability.provider === 'electron') {
    if (capability.checking) {
      return 'Checking system notification support...';
    }

    if (!capability.supported) {
      return 'System notifications are unavailable on this desktop runtime.';
    }

    if (!enabled) {
      return 'Task notifications are off.';
    }

    return 'Show native desktop notifications when tasks become ready for review or need attention while the app window is unfocused.';
  }

  if (capability.provider === 'web') {
    switch (capability.permission) {
      case 'granted':
        if (!enabled) {
          return 'Task notifications are off.';
        }
        return 'Show browser notifications when tasks become ready for review or need attention while this tab is hidden.';
      case 'default':
        if (!enabled) {
          return 'Turn on task notifications to request browser permission and receive task-ready and waiting alerts while this tab is hidden.';
        }
        return 'Task notifications are on, but this browser still needs permission before alerts can appear while the tab is hidden.';
      case 'denied':
        if (!enabled) {
          return 'Task notifications are off, and browser notifications are currently blocked for this site.';
        }
        return 'Browser notifications are blocked for this site. Re-enable them in your browser settings to use task notifications.';
      case 'unavailable':
        return 'Browser notifications are unavailable in this environment.';
    }
  }

  return 'Task notifications are unavailable in this environment.';
}

function getTaskNotificationSettingState(
  capability: TaskNotificationCapability,
  enabled: boolean,
): TaskNotificationSettingState {
  return {
    canToggle: !capability.checking && capability.supported,
    description: getTaskNotificationDescription(capability, enabled),
    permissionButtonLabel:
      capability.provider === 'web' && capability.permission === 'default'
        ? 'Allow browser notifications'
        : null,
    showEnableButton:
      capability.provider === 'web' && capability.permission === 'default' && enabled,
    showSetting: capability.provider !== 'none',
  };
}

export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const fonts = createMemo<TerminalFont[]>(() => {
    const available = getAvailableTerminalFonts();
    // Always include the currently selected font so it stays visible even if detection misses it
    if (available.includes(store.terminalFont)) return available;
    return [store.terminalFont, ...available];
  });
  const hydraAgent = createMemo(() =>
    store.availableAgents.find((agent) => agent.adapter === 'hydra' || agent.id === 'hydra'),
  );
  const taskNotificationSettingState = createMemo(() =>
    getTaskNotificationSettingState(
      getTaskNotificationCapability(),
      store.taskNotificationsEnabled,
    ),
  );

  createEffect(() => {
    if (!props.open) {
      return;
    }

    void refreshTaskNotificationCapability(isElectronRuntime());
  });

  async function handleTaskNotificationsChange(enabled: boolean): Promise<void> {
    setTaskNotificationsEnabled(enabled);
    if (!enabled) {
      return;
    }

    const capability = getTaskNotificationCapability();
    if (capability.provider === 'web' && capability.permission === 'default') {
      await requestTaskNotificationPermission();
    }
  }

  async function handleEnableBrowserNotifications(): Promise<void> {
    setTaskNotificationsEnabled(true);
    await requestTaskNotificationPermission();
  }

  function handleHydraCommandInput(value: string): void {
    setHydraCommand(value);
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="640px"
      zIndex={1100}
      panelStyle={{ 'max-width': 'calc(100vw - 32px)', padding: '24px', gap: '18px' }}
    >
      <DialogHeader
        description={
          <>
            Customize your workspace. Shortcut:{' '}
            <kbd
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '4px',
                padding: '1px 6px',
                color: theme.fgMuted,
                ...typography.monoMeta,
              }}
            >
              {mod}+,
            </kbd>
          </>
        }
        onClose={props.onClose}
        title="Settings"
      />

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <SectionLabel>Theme</SectionLabel>
        <div class="settings-theme-grid">
          <For each={LOOK_PRESETS}>
            {(preset) => (
              <button
                type="button"
                class={`settings-theme-card${store.themePreset === preset.id ? ' active' : ''}`}
                onClick={() => setThemePreset(preset.id)}
              >
                <span class="settings-theme-title">{preset.label}</span>
                <span class="settings-theme-desc">{preset.description}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <SectionLabel>Hydra</SectionLabel>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '10px',
            padding: '10px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <label
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
            }}
          >
            <span style={{ ...typography.ui, color: theme.fg }}>Hydra command override</span>
            <input
              type="text"
              value={store.hydraCommand}
              onInput={(e) => handleHydraCommandInput(e.currentTarget.value)}
              placeholder="hydra"
              style={{
                background: theme.taskPanelBg,
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                padding: '6px 10px',
                color: theme.fg,
                ...typography.monoUi,
                outline: 'none',
              }}
            />
          </label>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={store.hydraForceDispatchFromPromptPanel}
              onChange={(e) => setHydraForceDispatchFromPromptPanel(e.currentTarget.checked)}
              style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
            />
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              <span style={{ ...typography.ui, color: theme.fg }}>
                Force-dispatch prompt-panel sends
              </span>
              <span style={{ ...typography.meta, color: theme.fgSubtle }}>
                Prefix prompt-panel messages with `!` so Hydra dispatches work instead of opening
                concierge chat.
              </span>
            </div>
          </label>
          <label
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
            }}
          >
            <span style={{ ...typography.ui, color: theme.fg }}>Startup mode</span>
            <select
              value={store.hydraStartupMode}
              onChange={(e) =>
                setHydraStartupMode(
                  isHydraStartupMode(e.currentTarget.value) ? e.currentTarget.value : 'auto',
                )
              }
              style={{
                background: theme.taskPanelBg,
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                padding: '6px 10px',
                color: theme.fg,
                ...typography.ui,
                outline: 'none',
              }}
            >
              <For each={HYDRA_STARTUP_MODES}>
                {(mode) => <option value={mode}>{HYDRA_STARTUP_MODE_LABELS[mode]}</option>}
              </For>
            </select>
          </label>
          <span style={{ ...typography.meta, color: theme.fgSubtle }}>
            Hydra tasks run inside the parallel-code worktree. `hydra setup` and `hydra init` are
            never run automatically.
          </span>
          <Show when={hydraAgent()}>
            {(agent) => (
              <span style={{ ...typography.meta, color: theme.fgSubtle }}>
                {agent().availabilityReason ??
                  (agent().available === false
                    ? 'Hydra runtime is unavailable.'
                    : 'Hydra runtime is available.')}
              </span>
            )}
          </Show>
        </div>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <SectionLabel>Behavior</SectionLabel>
        <label
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            cursor: 'pointer',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="checkbox"
            checked={store.autoTrustFolders}
            onChange={(e) => setAutoTrustFolders(e.currentTarget.checked)}
            style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <span style={{ ...typography.ui, color: theme.fg }}>Auto-trust folders</span>
            <span style={{ ...typography.meta, color: theme.fgSubtle }}>
              Automatically accept trust and permission dialogs from agents
            </span>
          </div>
        </label>
        <Show when={taskNotificationSettingState().showSetting}>
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
              cursor: taskNotificationSettingState().canToggle ? 'pointer' : 'default',
              padding: '8px 12px',
              'border-radius': '8px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
            }}
          >
            <input
              type="checkbox"
              checked={store.taskNotificationsEnabled}
              disabled={!taskNotificationSettingState().canToggle}
              onChange={(e) => {
                void handleTaskNotificationsChange(e.currentTarget.checked);
              }}
              aria-label="Task notifications"
              style={{
                'accent-color': theme.accent,
                cursor: taskNotificationSettingState().canToggle ? 'pointer' : 'not-allowed',
              }}
            />
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              <span style={{ ...typography.ui, color: theme.fg }}>Task notifications</span>
              <span style={{ ...typography.meta, color: theme.fgSubtle }}>
                {taskNotificationSettingState().description}
              </span>
            </div>
          </label>
        </Show>
        <Show when={taskNotificationSettingState().showEnableButton}>
          <button
            type="button"
            onClick={() => {
              void handleEnableBrowserNotifications();
            }}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '8px 12px',
              color: theme.fg,
              cursor: 'pointer',
              ...typography.metaStrong,
              'text-align': 'left',
            }}
          >
            {taskNotificationSettingState().permissionButtonLabel}
          </button>
        </Show>
        <label
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            cursor: 'pointer',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="checkbox"
            checked={store.showPlans}
            onChange={(e) => setShowPlans(e.currentTarget.checked)}
            style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <span style={{ ...typography.ui, color: theme.fg }}>Show plans</span>
            <span style={{ ...typography.meta, color: theme.fgSubtle }}>
              Display Claude Code plan files in a tab next to Notes
            </span>
          </div>
        </label>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <SectionLabel>Editor</SectionLabel>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
            }}
          >
            <span style={{ ...typography.ui, color: theme.fg, 'white-space': 'nowrap' }}>
              Editor command
            </span>
            <input
              type="text"
              value={store.editorCommand}
              onInput={(e) => setEditorCommand(e.currentTarget.value)}
              placeholder="e.g. code, cursor, zed, subl"
              style={{
                flex: '1',
                background: theme.taskPanelBg,
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                padding: '6px 10px',
                color: theme.fg,
                ...typography.monoUi,
                outline: 'none',
              }}
            />
          </label>
          <span style={{ ...typography.meta, color: theme.fgSubtle }}>
            CLI command to open worktree folders. Click the path bar in a task to open it.
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <SectionLabel>Focus Dimming</SectionLabel>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
            }}
          >
            <span style={{ ...typography.ui, color: theme.fg }}>Inactive column opacity</span>
            <span
              style={{
                ...typography.monoMeta,
                color: theme.fgMuted,
                'min-width': '36px',
                'text-align': 'right',
              }}
            >
              {Math.round(store.inactiveColumnOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min="30"
            max="100"
            step="5"
            value={store.inactiveColumnOpacity * 100}
            onInput={(e) => setInactiveColumnOpacity(Number(e.currentTarget.value) / 100)}
            style={{
              width: '100%',
              'accent-color': theme.accent,
              cursor: 'pointer',
            }}
          />
          <div
            style={{
              display: 'flex',
              'justify-content': 'space-between',
              ...typography.label,
              color: theme.fgSubtle,
            }}
          >
            <span>More dimmed</span>
            <span>No dimming</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <SectionLabel>Custom Agents</SectionLabel>
        <CustomAgentEditor />
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <SectionLabel>Terminal Font</SectionLabel>
        <div class="settings-font-grid">
          <For each={fonts()}>
            {(font) => (
              <button
                type="button"
                class={`settings-font-card${store.terminalFont === font ? ' active' : ''}`}
                onClick={() => setTerminalFont(font)}
              >
                <span class="settings-font-name">{font}</span>
                <span
                  class="settings-font-preview"
                  style={{ 'font-family': getTerminalFontFamily(font) }}
                >
                  AaBb 0Oo1Il →
                </span>
              </button>
            )}
          </For>
        </div>
        <Show when={LIGATURE_FONTS.has(store.terminalFont)}>
          <span style={{ ...typography.meta, color: theme.fgSubtle }}>
            This font includes ligatures which may impact rendering performance.
          </span>
        </Show>
      </div>
    </Dialog>
  );
}
