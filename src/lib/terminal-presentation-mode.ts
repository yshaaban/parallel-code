export type TerminalPresentationModeKind = 'error' | 'live' | 'loading';

export type TerminalPresentationMode =
  | { kind: 'error' }
  | { kind: 'live' }
  | { kind: 'loading'; label: string };
