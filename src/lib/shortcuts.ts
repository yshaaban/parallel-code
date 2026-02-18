type ShortcutHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  cmdOrCtrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** When true, the shortcut fires even when an input/textarea/select is focused (e.g. inside a terminal). */
  global?: boolean;
  handler: ShortcutHandler;
}

const shortcuts: Shortcut[] = [];

function matches(e: KeyboardEvent, s: Shortcut): boolean {
  const ctrlMatch = s.cmdOrCtrl
    ? (e.ctrlKey || e.metaKey)
    : !!e.ctrlKey === !!s.ctrl;

  return (
    e.key.toLowerCase() === s.key.toLowerCase() &&
    ctrlMatch &&
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
  return shortcuts.some((s) => s.global && matches(e, s));
}

export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept when typing in input/textarea — unless the shortcut is global
    const tag = (e.target as HTMLElement)?.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    for (const s of shortcuts) {
      if (matches(e, s) && (!inInput || s.global)) {
        e.preventDefault();
        e.stopPropagation();
        s.handler(e);
        return;
      }
    }
  };

  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}
