import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { LOOK_PRESETS, type LookPreset } from './look';
import { getMonacoPresetColorsForTests } from './monaco-theme';
import { getTerminalTheme } from './theme';

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../styles.css');
const MIN_NORMAL_TEXT_CONTRAST = 4.5;
const MIN_SUPPORTING_TEXT_CONTRAST = 3;

type CssVariableMap = Record<string, string>;

function readStylesheet(): string {
  return readFileSync(CSS_PATH, 'utf8');
}

function extractBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Missing CSS selector ${selector}`);
  }

  const bodyStart = source.indexOf('{', start);
  const bodyEnd = source.indexOf('\n}', bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error(`Missing CSS body for ${selector}`);
  }

  return source.slice(bodyStart + 1, bodyEnd);
}

function extractVariables(block: string): CssVariableMap {
  const variables: CssVariableMap = {};
  const variablePattern = /--([a-z0-9-]+):\s*([^;]+);/giu;
  let match: RegExpExecArray | null;

  while ((match = variablePattern.exec(block)) !== null) {
    variables[match[1]] = match[2].trim();
  }

  return variables;
}

function getPresetVariables(source: string, preset: LookPreset): CssVariableMap {
  return {
    ...extractVariables(extractBlock(source, ':root')),
    ...extractVariables(extractBlock(source, `html[data-look='${preset}']`)),
  };
}

function getHexColor(variables: CssVariableMap, name: string): string {
  const value = variables[name];
  if (!value || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new Error(`Expected ${name} to be a six-digit hex color, got ${value ?? 'missing'}`);
  }

  return value;
}

function getSrgbChannel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function getRelativeLuminance(hex: string): number {
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);

  return (
    0.2126 * getSrgbChannel(red) + 0.7152 * getSrgbChannel(green) + 0.0722 * getSrgbChannel(blue)
  );
}

function getContrastRatio(first: string, second: string): number {
  const firstLum = getRelativeLuminance(first);
  const secondLum = getRelativeLuminance(second);
  const lighter = Math.max(firstLum, secondLum);
  const darker = Math.min(firstLum, secondLum);

  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrastAtLeast(
  variables: CssVariableMap,
  foregroundName: string,
  backgroundName: string,
  minContrast: number,
): void {
  const foreground = getHexColor(variables, foregroundName);
  const background = getHexColor(variables, backgroundName);
  const contrast = getContrastRatio(foreground, background);

  expect(
    contrast,
    `${foregroundName} ${foreground} on ${backgroundName} ${background}`,
  ).toBeGreaterThanOrEqual(minContrast);
}

describe('look preset contrast tokens', () => {
  it('keeps readable text and semantic colors across local theme presets', () => {
    const source = readStylesheet();

    for (const { id } of LOOK_PRESETS) {
      const variables = getPresetVariables(source, id);

      for (const background of ['bg-elevated', 'bg-input', 'task-panel-bg', 'island-bg']) {
        expectContrastAtLeast(variables, 'fg', background, MIN_NORMAL_TEXT_CONTRAST);
        expectContrastAtLeast(variables, 'fg-muted', background, MIN_NORMAL_TEXT_CONTRAST);
        expectContrastAtLeast(variables, 'fg-subtle', background, MIN_SUPPORTING_TEXT_CONTRAST);
        expectContrastAtLeast(variables, 'success', background, MIN_NORMAL_TEXT_CONTRAST);
        expectContrastAtLeast(variables, 'error', background, MIN_NORMAL_TEXT_CONTRAST);
        expectContrastAtLeast(variables, 'warning', background, MIN_NORMAL_TEXT_CONTRAST);
        expectContrastAtLeast(variables, 'link', background, MIN_NORMAL_TEXT_CONTRAST);
      }

      expectContrastAtLeast(variables, 'accent-text', 'accent', MIN_NORMAL_TEXT_CONTRAST);
    }
  });

  it('keeps Monaco preset colors aligned with shell theme tokens', () => {
    const source = readStylesheet();

    for (const { id } of LOOK_PRESETS) {
      const variables = getPresetVariables(source, id);
      const monacoColors = getMonacoPresetColorsForTests(id);

      expect(monacoColors.accent).toBe(getHexColor(variables, 'accent'));
      expect(monacoColors.bgElevated).toBe(getHexColor(variables, 'bg-elevated'));
      expect(monacoColors.border).toBe(getHexColor(variables, 'border'));
      expect(monacoColors.fg).toBe(getHexColor(variables, 'fg'));
      expect(monacoColors.fgMuted).toBe(getHexColor(variables, 'fg-muted'));
      expect(monacoColors.fgSubtle).toBe(getHexColor(variables, 'fg-subtle'));
    }
  });

  it('keeps terminal backgrounds aligned with task panel tokens', () => {
    const source = readStylesheet();

    for (const { id } of LOOK_PRESETS) {
      const variables = getPresetVariables(source, id);
      const terminalTheme = getTerminalTheme(id);

      expect(terminalTheme.background).toBe(getHexColor(variables, 'task-panel-bg'));
    }
  });
});
