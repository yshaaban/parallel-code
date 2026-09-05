import type { LookPreset } from './look';

/** Theme tokens referencing CSS variables defined in styles.css */
export const theme = {
  // Backgrounds (3-tier: black → task columns → panels inside)
  bg: 'var(--bg)',
  bgElevated: 'var(--bg-elevated)',
  bgInput: 'var(--bg-input)',
  bgHover: 'var(--bg-hover)',
  bgSelected: 'var(--bg-selected)',
  bgSelectedSubtle: 'var(--bg-selected-subtle)',

  // Borders
  border: 'var(--border)',
  borderSubtle: 'var(--border-subtle)',
  borderFocus: 'var(--border-focus)',

  // Text
  fg: 'var(--fg)',
  fgMuted: 'var(--fg-muted)',
  fgSubtle: 'var(--fg-subtle)',

  // Accent
  accent: 'var(--accent)',
  accentHover: 'var(--accent-hover)',
  accentText: 'var(--accent-text)',
  link: 'var(--link)',

  // Semantic
  success: 'var(--success)',
  error: 'var(--error)',
  errorText: 'var(--error-text)',
  warning: 'var(--warning)',

  // Modal scrim
  overlay: 'var(--overlay)',

  // Island containers (task columns, sidebar)
  islandBg: 'var(--island-bg)',
  islandBorder: 'var(--island-border)',
  islandRadius: 'var(--island-radius)',
  taskContainerBg: 'var(--task-container-bg)',
  taskPanelBg: 'var(--task-panel-bg)',
} as const;

/** Opaque terminal background per preset — matches --task-panel-bg */
const terminalBackground: Record<LookPreset, string> = {
  classic: '#222326',
  graphite: '#121820',
  indigo: '#121529',
  ember: '#1b1312',
  glacier: '#1d2833',
  minimal: '#262626',
};

export interface TerminalSearchDecorationTheme {
  activeMatchBackground: string;
  activeMatchBorder: string;
  activeMatchColorOverviewRuler: string;
  matchBackground: string;
  matchBorder: string;
  matchOverviewRuler: string;
}

const terminalSearchDecorationThemes: Record<LookPreset, TerminalSearchDecorationTheme> = {
  classic: {
    activeMatchBackground: '#9badff',
    activeMatchBorder: '#ffffff',
    activeMatchColorOverviewRuler: '#9badff',
    matchBackground: '#7d8ccc',
    matchBorder: '#9badff',
    matchOverviewRuler: '#7d8ccc',
  },
  graphite: {
    activeMatchBackground: '#2ec8ff',
    activeMatchBorder: '#ffffff',
    activeMatchColorOverviewRuler: '#2ec8ff',
    matchBackground: '#2f758f',
    matchBorder: '#2ec8ff',
    matchOverviewRuler: '#2f758f',
  },
  indigo: {
    activeMatchBackground: '#9b9aff',
    activeMatchBorder: '#ffffff',
    activeMatchColorOverviewRuler: '#9b9aff',
    matchBackground: '#5d5bb4',
    matchBorder: '#9b9aff',
    matchOverviewRuler: '#5d5bb4',
  },
  ember: {
    activeMatchBackground: '#ff944d',
    activeMatchBorder: '#ffffff',
    activeMatchColorOverviewRuler: '#ff944d',
    matchBackground: '#9b5d35',
    matchBorder: '#ff944d',
    matchOverviewRuler: '#9b5d35',
  },
  glacier: {
    activeMatchBackground: '#50e2d3',
    activeMatchBorder: '#ffffff',
    activeMatchColorOverviewRuler: '#50e2d3',
    matchBackground: '#348c84',
    matchBorder: '#50e2d3',
    matchOverviewRuler: '#348c84',
  },
  minimal: {
    activeMatchBackground: '#c8bfa0',
    activeMatchBorder: '#ffffff',
    activeMatchColorOverviewRuler: '#c8bfa0',
    matchBackground: '#7e7866',
    matchBorder: '#c8bfa0',
    matchOverviewRuler: '#7e7866',
  },
};

/** Returns an xterm-compatible theme object for the given preset */
export function getTerminalTheme(preset: LookPreset) {
  return {
    background: terminalBackground[preset],
  };
}

export function getTerminalSearchDecorationTheme(
  preset: LookPreset,
): TerminalSearchDecorationTheme {
  return terminalSearchDecorationThemes[preset];
}
