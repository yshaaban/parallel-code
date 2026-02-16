type ShortcutHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  handler: ShortcutHandler;
}

const shortcuts: Shortcut[] = [];

function matches(e: KeyboardEvent, s: Shortcut): boolean {
  return (
    e.key.toLowerCase() === s.key.toLowerCase() &&
    !!e.ctrlKey === !!s.ctrl &&
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

export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept when typing in input/textarea
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    for (const s of shortcuts) {
      if (matches(e, s)) {
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
