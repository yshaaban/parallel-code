import type { LookPreset } from "./look";

/** Theme tokens referencing CSS variables defined in styles.css */
export const theme = {
  // Backgrounds (3-tier: black → task columns → panels inside)
  bg: "var(--bg)",
  bgElevated: "var(--bg-elevated)",
  bgInput: "var(--bg-input)",
  bgHover: "var(--bg-hover)",
  bgSelected: "var(--bg-selected)",
  bgSelectedSubtle: "var(--bg-selected-subtle)",

  // Borders
  border: "var(--border)",
  borderSubtle: "var(--border-subtle)",
  borderFocus: "var(--border-focus)",

  // Text
  fg: "var(--fg)",
  fgMuted: "var(--fg-muted)",
  fgSubtle: "var(--fg-subtle)",

  // Accent
  accent: "var(--accent)",
  accentHover: "var(--accent-hover)",
  accentText: "var(--accent-text)",
  link: "var(--link)",

  // Semantic
  success: "var(--success)",
  error: "var(--error)",
  warning: "var(--warning)",

  // Island containers (task columns, sidebar)
  islandBg: "var(--island-bg)",
  islandBorder: "var(--island-border)",
  islandRadius: "var(--island-radius)",
  taskContainerBg: "var(--task-container-bg)",
  taskPanelBg: "var(--task-panel-bg)",

} as const;

/** Opaque terminal background per preset — matches --task-panel-bg */
const terminalBackground: Record<LookPreset, string> = {
  classic:  "#1a1b1d",
  graphite: "#121820",
  indigo:   "#121529",
  ember:    "#1b1312",
  glacier:  "#151e26",
  minimal:  "#161616",
};

/** Returns an xterm-compatible theme object for the given preset */
export function getTerminalTheme(preset: LookPreset) {
  return {
    background: terminalBackground[preset],
  };
}
