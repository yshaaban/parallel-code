export interface TerminalShortcutKeyEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  type?: string;
}

export interface TerminalShortcutContext {
  browserMode: boolean;
  hasSelection: boolean;
  isMac: boolean;
}

export type TerminalShortcutAction =
  | { kind: 'allow'; preventDefault: false }
  | { kind: 'block'; preventDefault: boolean }
  | { kind: 'copy'; preventDefault: true }
  | { kind: 'paste'; preventDefault: true }
  | { kind: 'send-input'; data: string; preventDefault: true };

const ALLOW_TERMINAL_SHORTCUT: TerminalShortcutAction = {
  kind: 'allow',
  preventDefault: false,
};

const BLOCK_TERMINAL_SHORTCUT: TerminalShortcutAction = {
  kind: 'block',
  preventDefault: false,
};

const COPY_TERMINAL_SHORTCUT: TerminalShortcutAction = {
  kind: 'copy',
  preventDefault: true,
};

const PASTE_TERMINAL_SHORTCUT: TerminalShortcutAction = {
  kind: 'paste',
  preventDefault: true,
};

export function getTerminalShortcutAction(
  event: TerminalShortcutKeyEventLike,
  context: TerminalShortcutContext,
): TerminalShortcutAction {
  const key = event.key.toLowerCase();
  const isShiftEnter =
    key === 'enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;

  if (event.type === 'keyup' && isShiftEnter) {
    return BLOCK_TERMINAL_SHORTCUT;
  }

  if (event.type !== undefined && event.type !== 'keydown') {
    return ALLOW_TERMINAL_SHORTCUT;
  }
  const isPrimaryCopy = context.isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'c'
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === 'c';
  const isPrimaryPaste = context.isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'v'
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === 'v';
  const isPrimaryFind =
    (context.isMac ? event.metaKey : event.ctrlKey) &&
    !event.altKey &&
    !(context.isMac ? event.ctrlKey : event.metaKey) &&
    !event.shiftKey &&
    key === 'f';
  const isExplicitTerminalCopy =
    !context.isMac &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.shiftKey &&
    key === 'c';
  const isExplicitTerminalPaste =
    !context.isMac &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.shiftKey &&
    key === 'v';

  if (isShiftEnter) {
    return {
      data: '\x1b\r',
      kind: 'send-input',
      preventDefault: true,
    };
  }

  if (context.isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (key === 'arrowleft') {
      return {
        data: '\x1b[H',
        kind: 'send-input',
        preventDefault: true,
      };
    }

    if (key === 'arrowright') {
      return {
        data: '\x1b[F',
        kind: 'send-input',
        preventDefault: true,
      };
    }
  }

  if (context.browserMode) {
    if (isPrimaryFind) {
      return BLOCK_TERMINAL_SHORTCUT;
    }

    if (
      (context.isMac && isPrimaryCopy) ||
      (!context.isMac && isPrimaryCopy && context.hasSelection)
    ) {
      return BLOCK_TERMINAL_SHORTCUT;
    }

    if (isPrimaryPaste || isExplicitTerminalPaste) {
      return PASTE_TERMINAL_SHORTCUT;
    }

    if (isExplicitTerminalCopy) {
      return COPY_TERMINAL_SHORTCUT;
    }
  }

  if (
    context.isMac
      ? isPrimaryCopy
      : isExplicitTerminalCopy || (isPrimaryCopy && context.hasSelection)
  ) {
    return COPY_TERMINAL_SHORTCUT;
  }

  if (
    context.isMac
      ? isPrimaryPaste
      : isExplicitTerminalPaste || (!context.browserMode && isPrimaryPaste)
  ) {
    return PASTE_TERMINAL_SHORTCUT;
  }

  return ALLOW_TERMINAL_SHORTCUT;
}
