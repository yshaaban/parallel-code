export const TERMINAL_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Ubuntu Mono',
  'Inconsolata',
  'Hack',
  'Menlo',
  'Consolas',
] as const;

export type TerminalFont = (typeof TERMINAL_FONTS)[number];
