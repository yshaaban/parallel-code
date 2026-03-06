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
    e.key.toLowerCase() === s.key.toLowerCase() &&
    ctrlMatch &&
    metaMatch &&
    !!e.altKey === !!s.alt &&
    !!e.shiftKey === !!s.shift
  );
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

export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept when typing in input/textarea — unless the shortcut is global
    const tag = (e.target as HTMLElement)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Suppress non-dialog-safe shortcuts when a dialog overlay is open
    const dialogOpen = document.querySelector('.dialog-overlay') !== null;

    for (const s of shortcuts) {
      if (shouldBypassShortcutInBrowserTerminal(e, s)) continue;
      if (matches(e, s) && (!inInput || s.global) && (!dialogOpen || s.dialogSafe)) {
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
