import { isElectronRuntime } from './ipc';

type ShortcutHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  cmdOrCtrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** When true, the shortcut fires even when an input/textarea/select is focused (e.g. inside a terminal). */
  global?: boolean;
  /** When true, the shortcut fires even when a dialog overlay is open. */
  dialogSafe?: boolean;
  handler: ShortcutHandler;
}

const shortcuts: Shortcut[] = [];

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.xterm') !== null;
}

function shouldBypassShortcutInBrowserTerminal(e: KeyboardEvent, s: Shortcut): boolean {
  if (isElectronRuntime() || !isTerminalTarget(e.target) || !s.cmdOrCtrl) return false;
  const key = s.key.toLowerCase();

  // Don't steal common browser/tab-management shortcuts from the focused web terminal.
  return (
    (!s.shift && (key === 'n' || key === 'w')) ||
    (!!s.shift && (key === 'd' || key === 't' || key === 'w'))
  );
}

function matches(e: KeyboardEvent, s: Shortcut): boolean {
  const ctrlMatch = s.cmdOrCtrl ? e.ctrlKey || e.metaKey : !!e.ctrlKey === !!s.ctrl;
  // For non-cmdOrCtrl shortcuts, require metaKey to not be pressed
  const metaMatch = s.cmdOrCtrl || !e.metaKey;

  return (
    keyMatches(e, s.key) &&
    ctrlMatch &&
    metaMatch &&
    !!e.altKey === !!s.alt &&
    !!e.shiftKey === !!s.shift
  );
}

function keyMatches(event: KeyboardEvent, shortcutKey: string): boolean {
  if (event.key.toLowerCase() === shortcutKey.toLowerCase()) {
    return true;
  }

  if (/^[0-9]$/u.test(shortcutKey)) {
    return event.code === `Digit${shortcutKey}` || event.code === `Numpad${shortcutKey}`;
  }

  return false;
}

function isDialogOpen(): boolean {
  return document.querySelector('.dialog-overlay') !== null;
}

export function registerShortcut(shortcut: Shortcut): () => void {
  shortcuts.push(shortcut);
  return () => {
    const idx = shortcuts.indexOf(shortcut);
    if (idx >= 0) shortcuts.splice(idx, 1);
  };
}

/** Returns true if the event matches any shortcut with `global: true`. */
export function matchesGlobalShortcut(e: KeyboardEvent): boolean {
  return shortcuts.some(
    (s) => s.global && !shouldBypassShortcutInBrowserTerminal(e, s) && matches(e, s),
  );
}

/** Returns true if the event matches a dialog-safe shortcut while a dialog overlay is open. */
export function matchesDialogSafeShortcut(e: KeyboardEvent): boolean {
  if (!isDialogOpen()) {
    return false;
  }

  return shortcuts.some(
    (s) => s.dialogSafe && !shouldBypassShortcutInBrowserTerminal(e, s) && matches(e, s),
  );
}

export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept when typing in input/textarea — unless the shortcut is global
    const tag = (e.target as HTMLElement)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Suppress non-dialog-safe shortcuts when a dialog overlay is open
    const dialogOpen = isDialogOpen();

    for (const s of shortcuts) {
      if (shouldBypassShortcutInBrowserTerminal(e, s)) continue;
      const allowWhenInputFocused = s.global || (dialogOpen && s.dialogSafe);
      if (matches(e, s) && (!inInput || allowWhenInputFocused) && (!dialogOpen || s.dialogSafe)) {
        e.preventDefault();
        e.stopPropagation();
        s.handler(e);
        return;
      }
    }
  };

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
