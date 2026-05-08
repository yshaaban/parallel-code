import { isElectronRuntime } from './ipc';
import { getKeybindingChords } from '../store/keybindings';
import { getKeybindingDefinition } from '../domain/keybindings';
import type { KeybindingActionId, KeyChord } from '../domain/keybindings';

type ShortcutHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  actionId?: KeybindingActionId;
  key?: string;
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

function getStaticShortcutChord(shortcut: Shortcut): KeyChord[] {
  if (!shortcut.key) {
    return [];
  }

  return [
    {
      key: shortcut.key,
      ...(shortcut.alt ? { alt: true } : {}),
      ...(shortcut.cmdOrCtrl ? { cmdOrCtrl: true } : {}),
      ...(shortcut.ctrl ? { ctrl: true } : {}),
      ...(shortcut.shift ? { shift: true } : {}),
    },
  ];
}

function getShortcutChords(shortcut: Shortcut): KeyChord[] {
  if (shortcut.actionId) {
    return getKeybindingChords(shortcut.actionId);
  }

  return getStaticShortcutChord(shortcut);
}

function isShortcutGlobal(shortcut: Shortcut): boolean {
  if (shortcut.global !== undefined) {
    return shortcut.global;
  }

  if (!shortcut.actionId) {
    return false;
  }

  return getKeybindingDefinition(shortcut.actionId)?.global === true;
}

function isShortcutDialogSafe(shortcut: Shortcut): boolean {
  if (shortcut.dialogSafe !== undefined) {
    return shortcut.dialogSafe;
  }

  if (!shortcut.actionId) {
    return false;
  }

  return getKeybindingDefinition(shortcut.actionId)?.dialogSafe === true;
}

function shouldBypassChordInBrowserTerminal(e: KeyboardEvent, chord: KeyChord): boolean {
  if (isElectronRuntime() || !isTerminalTarget(e.target) || !chord.cmdOrCtrl) {
    return false;
  }

  const key = chord.key.toLowerCase();

  // Don't steal common browser/tab-management shortcuts from the focused web terminal.
  return (
    (!chord.shift && (key === 'n' || key === 'w')) ||
    (!!chord.shift && (key === 'd' || key === 't' || key === 'w'))
  );
}

function shouldBypassShortcutInBrowserTerminal(e: KeyboardEvent, shortcut: Shortcut): boolean {
  return getShortcutChords(shortcut).some(
    (chord) => matchesChord(e, chord) && shouldBypassChordInBrowserTerminal(e, chord),
  );
}

function matchesChord(e: KeyboardEvent, chord: KeyChord): boolean {
  const ctrlMatch = chord.cmdOrCtrl ? e.ctrlKey || e.metaKey : !!e.ctrlKey === !!chord.ctrl;
  // For non-cmdOrCtrl shortcuts, require metaKey to not be pressed
  const metaMatch = chord.cmdOrCtrl || !e.metaKey;

  return (
    keyMatches(e, chord.key) &&
    ctrlMatch &&
    metaMatch &&
    !!e.altKey === !!chord.alt &&
    !!e.shiftKey === !!chord.shift
  );
}

function matches(e: KeyboardEvent, shortcut: Shortcut): boolean {
  return getShortcutChords(shortcut).some((chord) => matchesChord(e, chord));
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
    if (idx >= 0) {
      shortcuts.splice(idx, 1);
    }
  };
}

/** Returns true if the event matches any shortcut with `global: true`. */
export function matchesGlobalShortcut(e: KeyboardEvent): boolean {
  return shortcuts.some(
    (s) => isShortcutGlobal(s) && !shouldBypassShortcutInBrowserTerminal(e, s) && matches(e, s),
  );
}

/** Returns true if the event matches a dialog-safe shortcut while a dialog overlay is open. */
export function matchesDialogSafeShortcut(e: KeyboardEvent): boolean {
  if (!isDialogOpen()) {
    return false;
  }

  return shortcuts.some(
    (s) => isShortcutDialogSafe(s) && !shouldBypassShortcutInBrowserTerminal(e, s) && matches(e, s),
  );
}

export function initShortcuts(): () => void {
  function handleKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const dialogOpen = isDialogOpen();

    for (const shortcut of shortcuts) {
      if (shouldBypassShortcutInBrowserTerminal(e, shortcut)) {
        continue;
      }

      const globalShortcut = isShortcutGlobal(shortcut);
      const dialogSafeShortcut = isShortcutDialogSafe(shortcut);
      const allowWhenInputFocused = globalShortcut || (dialogOpen && dialogSafeShortcut);
      if (
        matches(e, shortcut) &&
        (!inInput || allowWhenInputFocused) &&
        (!dialogOpen || dialogSafeShortcut)
      ) {
        e.preventDefault();
        e.stopPropagation();
        shortcut.handler(e);
        return;
      }
    }
  }

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
