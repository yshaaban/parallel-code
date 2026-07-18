import { describe, expect, it } from 'vitest';
import { createDefaultKeybindingOverrides } from '../domain/keybindings';
import { DEFAULT_TERMINAL_FONT } from '../lib/fonts';
import { createInitialAppStore } from './core';
import {
  applyFullStateLocalShellPreferences,
  buildBrowserLocalShellPreferences,
  buildElectronLocalShellPreferences,
  createDefaultLocalShellPreferences,
  getLocalShellPreferencesSnapshot,
  resolveLocalShellPreferences,
} from './local-shell-preferences';
import { DEFAULT_FONT_SMOOTHING, DEFAULT_TERMINAL_FONT_SIZE } from './terminal-font-settings';

describe('local shell preferences', () => {
  it('uses the canonical default shape for fresh app stores', () => {
    const initialStore = createInitialAppStore();
    const defaults = createDefaultLocalShellPreferences({
      terminalHighLoadMode: initialStore.terminalHighLoadMode,
      terminalLocalInputFeedbackEnabled: initialStore.terminalLocalInputFeedbackEnabled,
    });

    expect(getLocalShellPreferencesSnapshot(initialStore)).toEqual(defaults);
  });

  it('creates a detached snapshot of every nested preference value', () => {
    const source = createInitialAppStore();
    source.fontScales = { 'task-1': 1.2 };
    source.panelSizes = { 'task-1:agent-1': 0.4 };
    source.sidebarSectionCollapsed = {
      projects: true,
      progress: false,
      sessions: false,
      tips: false,
    };
    source.keybindings = {
      overrides: {
        'app.new-task': { chords: [{ ctrl: true, key: 'n' }] },
      },
      version: 1,
    };
    source.windowState = {
      height: 720,
      maximized: false,
      width: 1280,
      x: 10,
      y: 20,
    };

    const snapshot = getLocalShellPreferencesSnapshot(source);

    expect(snapshot.fontScales).not.toBe(source.fontScales);
    expect(snapshot.panelSizes).not.toBe(source.panelSizes);
    expect(snapshot.sidebarSectionCollapsed).not.toBe(source.sidebarSectionCollapsed);
    expect(snapshot.keybindings).not.toBe(source.keybindings);
    expect(snapshot.keybindings.overrides['app.new-task']).not.toBe(
      source.keybindings.overrides['app.new-task'],
    );
    expect(snapshot.windowState).not.toBe(source.windowState);

    snapshot.fontScales['task-1'] = 2;
    snapshot.panelSizes['task-1:agent-1'] = 0.8;
    snapshot.sidebarSectionCollapsed.projects = false;
    const snapshotChord = snapshot.keybindings.overrides['app.new-task']?.chords?.[0];
    if (snapshotChord) snapshotChord.key = 'x';
    if (snapshot.windowState) snapshot.windowState.width = 640;

    expect(source.fontScales['task-1']).toBe(1.2);
    expect(source.panelSizes['task-1:agent-1']).toBe(0.4);
    expect(source.sidebarSectionCollapsed.projects).toBe(true);
    expect(source.keybindings.overrides['app.new-task']?.chords?.[0]?.key).toBe('n');
    expect(source.windowState.width).toBe(1280);
  });

  it('resolves omitted and malformed values through one canonical default policy', () => {
    const preferences = resolveLocalShellPreferences(
      {
        fontScales: { valid: 1, invalid: Number.NaN },
        fontSmoothing: 'yes',
        globalScale: Number.POSITIVE_INFINITY,
        inactiveColumnOpacity: 0.2,
        panelSizes: [],
        taskNotificationsEnabled: false,
        terminalFont: 'invalid-font',
        terminalFontSize: Number.NaN,
        themePreset: 'invalid-theme',
        windowState: { height: -1, width: 0, x: 0, y: 0 },
      },
      {
        terminalHighLoadMode: true,
        terminalLocalInputFeedbackEnabled: false,
      },
    );

    expect(preferences).toEqual({
      fontScales: {},
      fontSmoothing: DEFAULT_FONT_SMOOTHING,
      globalScale: 1,
      inactiveColumnOpacity: 0.6,
      keybindings: createDefaultKeybindingOverrides(),
      panelSizes: {},
      showPlans: true,
      sidebarSectionCollapsed: {
        projects: false,
        progress: true,
        sessions: true,
        tips: true,
      },
      sidebarVisible: true,
      taskNotificationsEnabled: true,
      taskNotificationsPreferenceInitialized: true,
      terminalFont: DEFAULT_TERMINAL_FONT,
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      terminalHighLoadMode: true,
      terminalLocalInputFeedbackEnabled: false,
      themePreset: 'minimal',
      verboseLogging: false,
      windowState: null,
    });
  });

  it('normalizes valid persisted values and legacy notification compatibility exactly', () => {
    const preferences = resolveLocalShellPreferences(
      {
        desktopNotificationsEnabled: false,
        fontScales: { 'task-1': 1.2 },
        fontSmoothing: false,
        globalScale: 1.1,
        inactiveColumnOpacity: 0.746,
        panelSizes: { 'left:right': 0.4 },
        showPlans: false,
        sidebarSectionCollapsed: {
          projects: true,
          progress: false,
        },
        sidebarVisible: false,
        taskNotificationsPreferenceInitialized: true,
        terminalFont: 'JetBrains Mono',
        terminalFontSize: 19.6,
        terminalHighLoadMode: false,
        terminalLocalInputFeedbackEnabled: true,
        themePreset: 'graphite',
        verboseLogging: true,
        windowState: {
          height: 720,
          maximized: false,
          width: 1280,
          x: 10,
          y: 20,
        },
      },
      {
        terminalHighLoadMode: true,
        terminalLocalInputFeedbackEnabled: false,
      },
    );

    expect(preferences).toMatchObject({
      fontScales: { 'task-1': 1.2 },
      fontSmoothing: false,
      globalScale: 1.1,
      inactiveColumnOpacity: 0.75,
      panelSizes: { 'left:right': 0.4 },
      showPlans: false,
      sidebarSectionCollapsed: {
        projects: true,
        progress: false,
        sessions: true,
        tips: true,
      },
      sidebarVisible: false,
      taskNotificationsEnabled: false,
      taskNotificationsPreferenceInitialized: true,
      terminalFont: 'JetBrains Mono',
      terminalFontSize: 20,
      terminalHighLoadMode: false,
      terminalLocalInputFeedbackEnabled: true,
      themePreset: 'graphite',
      verboseLogging: true,
      windowState: {
        height: 720,
        maximized: false,
        width: 1280,
        x: 10,
        y: 20,
      },
    });
  });

  it('keeps the desktop and browser encoding differences explicit', () => {
    const source = createInitialAppStore();
    source.fontScales = { 'task-1': 1.2 };
    source.fontSmoothing = false;
    source.globalScale = 1.1;
    source.inactiveColumnOpacity = 0.75;
    source.panelSizes = { 'left:right': 0.4 };
    source.showPlans = false;
    source.sidebarSectionCollapsed = {
      projects: true,
      progress: false,
      sessions: false,
      tips: true,
    };
    source.sidebarVisible = false;
    source.taskNotificationsEnabled = false;
    source.taskNotificationsPreferenceInitialized = false;
    source.terminalFont = 'JetBrains Mono';
    source.terminalFontSize = 16;
    source.terminalHighLoadMode = true;
    source.terminalLocalInputFeedbackEnabled = false;
    source.themePreset = 'graphite';
    source.verboseLogging = false;
    source.windowState = null;

    const commonEncodedPreferences = {
      fontScales: { 'task-1': 1.2 },
      fontSmoothing: false,
      globalScale: 1.1,
      inactiveColumnOpacity: 0.75,
      keybindings: createDefaultKeybindingOverrides(),
      panelSizes: { 'left:right': 0.4 },
      showPlans: false,
      sidebarSectionCollapsed: {
        projects: true,
        progress: false,
        sessions: false,
        tips: true,
      },
      sidebarVisible: false,
      taskNotificationsEnabled: false,
      terminalFont: 'JetBrains Mono',
      terminalFontSize: 16,
      terminalHighLoadMode: true,
      terminalLocalInputFeedbackEnabled: false,
      themePreset: 'graphite',
    };
    const electronPreferences = buildElectronLocalShellPreferences(source);
    const browserPreferences = buildBrowserLocalShellPreferences(source);

    expect(electronPreferences).toEqual({
      ...commonEncodedPreferences,
      taskNotificationsPreferenceInitialized: false,
    });
    expect(browserPreferences).toEqual({
      ...commonEncodedPreferences,
      taskNotificationsPreferenceInitialized: true,
      windowState: null,
    });

    source.verboseLogging = true;
    source.windowState = {
      height: 720,
      maximized: true,
      width: 1280,
      x: 10,
      y: 20,
    };

    expect(buildElectronLocalShellPreferences(source)).toEqual({
      ...commonEncodedPreferences,
      taskNotificationsPreferenceInitialized: false,
      verboseLogging: true,
      windowState: source.windowState,
    });
    expect(buildBrowserLocalShellPreferences(source)).toEqual({
      ...commonEncodedPreferences,
      taskNotificationsPreferenceInitialized: true,
      verboseLogging: true,
      windowState: source.windowState,
    });
  });

  it('replaces the complete resolved preference shape during a full-state load', () => {
    const target = createInitialAppStore();
    const preferences = createDefaultLocalShellPreferences({
      terminalHighLoadMode: true,
      terminalLocalInputFeedbackEnabled: false,
    });

    target.sidebarVisible = false;
    target.terminalHighLoadMode = false;
    target.terminalLocalInputFeedbackEnabled = true;
    applyFullStateLocalShellPreferences(target, preferences);

    expect(target.sidebarVisible).toBe(true);
    expect(target.terminalHighLoadMode).toBe(true);
    expect(target.terminalLocalInputFeedbackEnabled).toBe(false);
  });
});
