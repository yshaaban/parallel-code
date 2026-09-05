import { parsePersistedKeybindingOverrides } from '../domain/keybindings';
import { copyNewTaskDefaults, resolveNewTaskDefaults } from '../domain/new-task-defaults';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isLookPreset } from '../lib/look';
import { isFiniteNumber } from '../lib/type-guards';
import { parsePersistedWindowState } from './persistence-legacy-state';
import { normalizeSidebarSectionCollapsedState } from './sidebar-section-state';
import { getPersistedTaskNotificationsEnabled } from './task-notification-preference';
import {
  clampTerminalFontSize,
  DEFAULT_FONT_SMOOTHING,
  DEFAULT_TERMINAL_FONT_SIZE,
} from './terminal-font-settings';
import type { AppStore, PersistedLocalShellPreferenceFields } from './types';

const DEFAULT_GLOBAL_SCALE = 1;
const DEFAULT_INACTIVE_COLUMN_OPACITY = 0.6;
const DEFAULT_THEME_PRESET = 'minimal';

type LocalShellPreferenceKey = keyof PersistedLocalShellPreferenceFields;

export type LocalShellPreferences = Pick<AppStore, LocalShellPreferenceKey>;

export type LocalShellPreferenceFallbacks = Pick<
  AppStore,
  'terminalHighLoadMode' | 'terminalLocalInputFeedbackEnabled'
>;

export type LocalShellPreferenceInput = {
  [Key in keyof PersistedLocalShellPreferenceFields]?: unknown;
} & { desktopNotificationsEnabled?: unknown };

export type ElectronLocalShellPreferences = Omit<
  LocalShellPreferences,
  'verboseLogging' | 'windowState'
> & {
  verboseLogging?: true;
  windowState?: NonNullable<LocalShellPreferences['windowState']>;
};

export type BrowserLocalShellPreferences = Omit<
  LocalShellPreferences,
  'taskNotificationsPreferenceInitialized' | 'verboseLogging'
> & {
  taskNotificationsPreferenceInitialized: true;
  verboseLogging?: true;
};

function resolveTerminalFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }

  return clampTerminalFontSize(value);
}

function normalizeInactiveColumnOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.3 || value > 1) {
    return DEFAULT_INACTIVE_COLUMN_OPACITY;
  }

  return Math.round(value * 100) / 100;
}

function isStringNumberRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry),
  );
}

export function getLocalShellPreferencesSnapshot(
  source: LocalShellPreferences,
): LocalShellPreferences {
  return {
    fontScales: { ...source.fontScales },
    fontSmoothing: source.fontSmoothing,
    globalScale: source.globalScale,
    inactiveColumnOpacity: source.inactiveColumnOpacity,
    keybindings: parsePersistedKeybindingOverrides(source.keybindings),
    newTaskDefaults: copyNewTaskDefaults(source.newTaskDefaults),
    panelSizes: { ...source.panelSizes },
    showPlans: source.showPlans,
    sidebarSectionCollapsed: { ...source.sidebarSectionCollapsed },
    sidebarVisible: source.sidebarVisible,
    taskNotificationsEnabled: source.taskNotificationsEnabled,
    taskNotificationsPreferenceInitialized: source.taskNotificationsPreferenceInitialized,
    terminalFont: source.terminalFont,
    terminalFontSize: source.terminalFontSize,
    terminalHighLoadMode: source.terminalHighLoadMode,
    terminalLocalInputFeedbackEnabled: source.terminalLocalInputFeedbackEnabled,
    themePreset: source.themePreset,
    verboseLogging: source.verboseLogging,
    windowState: source.windowState ? { ...source.windowState } : null,
  };
}

export function buildElectronLocalShellPreferences(
  source: LocalShellPreferences,
): ElectronLocalShellPreferences {
  const { verboseLogging, windowState, ...preferences } = getLocalShellPreferencesSnapshot(source);

  return {
    ...preferences,
    ...(verboseLogging ? { verboseLogging: true } : {}),
    ...(windowState ? { windowState } : {}),
  };
}

export function buildBrowserLocalShellPreferences(
  source: LocalShellPreferences,
): BrowserLocalShellPreferences {
  const { verboseLogging, ...preferences } = getLocalShellPreferencesSnapshot(source);

  return {
    ...preferences,
    taskNotificationsPreferenceInitialized: true,
    ...(verboseLogging ? { verboseLogging: true } : {}),
  };
}

export function resolveLocalShellPreferences(
  raw: LocalShellPreferenceInput,
  fallbacks: LocalShellPreferenceFallbacks,
): LocalShellPreferences {
  return {
    fontScales: isStringNumberRecord(raw.fontScales) ? raw.fontScales : {},
    fontSmoothing:
      typeof raw.fontSmoothing === 'boolean' ? raw.fontSmoothing : DEFAULT_FONT_SMOOTHING,
    globalScale: isFiniteNumber(raw.globalScale) ? raw.globalScale : DEFAULT_GLOBAL_SCALE,
    inactiveColumnOpacity: normalizeInactiveColumnOpacity(raw.inactiveColumnOpacity),
    keybindings: parsePersistedKeybindingOverrides(raw.keybindings),
    newTaskDefaults: resolveNewTaskDefaults(raw.newTaskDefaults),
    panelSizes: isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {},
    showPlans: typeof raw.showPlans === 'boolean' ? raw.showPlans : true,
    sidebarSectionCollapsed: normalizeSidebarSectionCollapsedState(raw.sidebarSectionCollapsed),
    sidebarVisible: typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true,
    taskNotificationsEnabled: getPersistedTaskNotificationsEnabled(raw),
    taskNotificationsPreferenceInitialized: true,
    terminalFont: isTerminalFont(raw.terminalFont) ? raw.terminalFont : DEFAULT_TERMINAL_FONT,
    terminalFontSize: resolveTerminalFontSize(raw.terminalFontSize),
    terminalHighLoadMode:
      typeof raw.terminalHighLoadMode === 'boolean'
        ? raw.terminalHighLoadMode
        : fallbacks.terminalHighLoadMode,
    terminalLocalInputFeedbackEnabled:
      typeof raw.terminalLocalInputFeedbackEnabled === 'boolean'
        ? raw.terminalLocalInputFeedbackEnabled
        : fallbacks.terminalLocalInputFeedbackEnabled,
    themePreset: isLookPreset(raw.themePreset) ? raw.themePreset : DEFAULT_THEME_PRESET,
    verboseLogging: raw.verboseLogging === true,
    windowState: parsePersistedWindowState(raw.windowState),
  };
}

export function createDefaultLocalShellPreferences(
  fallbacks: LocalShellPreferenceFallbacks,
): LocalShellPreferences {
  return resolveLocalShellPreferences({}, fallbacks);
}

export function applyFullStateLocalShellPreferences(
  target: LocalShellPreferences,
  preferences: LocalShellPreferences,
): void {
  Object.assign(target, preferences);
}

export function applyBrowserSessionLocalShellPreferences(
  target: LocalShellPreferences,
  preferences: LocalShellPreferences,
): void {
  const { fontScales, panelSizes, ...preferencesWithoutSparseMaps } = preferences;
  Object.assign(target, preferencesWithoutSparseMaps);
  Object.assign(target.fontScales, fontScales);
  Object.assign(target.panelSizes, panelSizes);
}
