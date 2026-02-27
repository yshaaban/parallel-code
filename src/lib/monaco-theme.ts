import * as monaco from 'monaco-editor';
import type { LookPreset } from './look';

interface PresetColors {
  bgElevated: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  border: string;
  accent: string;
}

// Colors must match the CSS variables in src/styles.css for each look preset.
// Diff highlight colors use the GitHub Dark palette (shared across all presets).
const presetColors: Record<LookPreset, PresetColors> = {
  classic: {
    bgElevated: '#222326',
    fg: '#cccdd2',
    fgMuted: '#8b8d93',
    fgSubtle: '#6d7076',
    border: '#2c2e31',
    accent: '#4c6fff',
  },
  graphite: {
    bgElevated: '#121820',
    fg: '#d7e4f0',
    fgMuted: '#9bb0c3',
    fgSubtle: '#678197',
    border: '#223040',
    accent: '#2ec8ff',
  },
  indigo: {
    bgElevated: '#121529',
    fg: '#deddff',
    fgMuted: '#b1b2de',
    fgSubtle: '#8286b6',
    border: '#2c3560',
    accent: '#7a78ff',
  },
  ember: {
    bgElevated: '#1b1312',
    fg: '#f2ddd1',
    fgMuted: '#d5ab94',
    fgSubtle: '#9f7561',
    border: '#47302a',
    accent: '#ff944d',
  },
  glacier: {
    bgElevated: '#1d2833',
    fg: '#e5eff5',
    fgMuted: '#bed2dc',
    fgSubtle: '#92aebb',
    border: '#344c5c',
    accent: '#50e2d3',
  },
  minimal: {
    bgElevated: '#161514',
    fg: '#e8e8e8',
    fgMuted: '#b8b8b8',
    fgSubtle: '#909090',
    border: '#2a2a2a',
    accent: '#c8bfa0',
  },
};

function buildThemeData(c: PresetColors): monaco.editor.IStandaloneThemeData {
  return {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: c.fgSubtle.slice(1) },
      { token: 'keyword', foreground: c.accent.slice(1) },
    ],
    colors: {
      'editor.background': c.bgElevated,
      'editor.foreground': c.fg,
      'editor.lineHighlightBackground': '#ffffff06',
      'editorLineNumber.foreground': c.fgSubtle,
      'editorLineNumber.activeForeground': c.fgMuted,
      'editor.selectionBackground': c.accent + '33',
      'editorWidget.background': c.bgElevated,
      'editorWidget.border': c.border,
      // GitHub-inspired diff palette, toned down for dark backgrounds
      'diffEditor.insertedLineBackground': '#2ea04315',
      'diffEditor.removedLineBackground': '#f8514915',
      'diffEditor.insertedTextBackground': '#2ea04340',
      'diffEditor.removedTextBackground': '#f8514940',
      'diffEditorGutter.insertedLineBackground': '#2ea04326',
      'diffEditorGutter.removedLineBackground': '#f8514926',
      'scrollbarSlider.background': c.fgSubtle + '40',
      'scrollbarSlider.hoverBackground': c.fgSubtle + '60',
    },
  };
}

export function monacoThemeName(preset: LookPreset): string {
  return `parallel-${preset}`;
}

export function registerMonacoThemes(): void {
  for (const [preset, colors] of Object.entries(presetColors)) {
    monaco.editor.defineTheme(monacoThemeName(preset as LookPreset), buildThemeData(colors));
  }
}
