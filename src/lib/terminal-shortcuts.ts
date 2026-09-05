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
  | { kind: 'find'; preventDefault: true }
  | { kind: 'paste'; preventDefault: true }
  | { kind: 'scrollback'; preventDefault: true; unit: 'line' | 'page'; delta: -1 | 1 }
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

const FIND_TERMINAL_SHORTCUT: TerminalShortcutAction = {
  kind: 'find',
  preventDefault: true,
};

export function isPrimaryTerminalFindShortcut(
  event: TerminalShortcutKeyEventLike,
  isMac: boolean,
): boolean {
  if (event.type !== undefined && event.type !== 'keydown') {
    return false;
  }

  return (
    event.key.toLowerCase() === 'f' &&
    (isMac ? event.metaKey : event.ctrlKey) &&
    !(isMac ? event.ctrlKey : event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

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
  const isPrimaryFind = isPrimaryTerminalFindShortcut(event, context.isMac);
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
  const isScrollbackShortcut = context.isMac
    ? event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;

  if (isShiftEnter) {
    return {
      data: '\x1b\r',
      kind: 'send-input',
      preventDefault: true,
    };
  }

  if (isPrimaryFind) {
    return FIND_TERMINAL_SHORTCUT;
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

  if (isScrollbackShortcut) {
    switch (key) {
      case 'arrowup':
        return { delta: -1, kind: 'scrollback', preventDefault: true, unit: 'line' };
      case 'arrowdown':
        return { delta: 1, kind: 'scrollback', preventDefault: true, unit: 'line' };
      case 'pageup':
        return { delta: -1, kind: 'scrollback', preventDefault: true, unit: 'page' };
      case 'pagedown':
        return { delta: 1, kind: 'scrollback', preventDefault: true, unit: 'page' };
    }
  }

  if (context.browserMode) {
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
