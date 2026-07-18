export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 20;
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const DEFAULT_FONT_SMOOTHING = true;

export function clampTerminalFontSize(value: number): number {
  return Math.round(Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, value)));
}
