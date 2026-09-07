import { createSignal, onCleanup, type JSX } from 'solid-js';

import './terminal-maximize.css';

// Presentation only: one mounted terminal may cover the workspace in this renderer.
// No task selection, session lifetime, command lease, or persisted state lives here.
let restoreActiveTerminal: (() => void) | undefined;

export function TerminalMaximizeControl(props: {
  surface: () => HTMLElement | undefined;
  searchOpen: boolean;
  focusTerminal: () => void;
}): JSX.Element {
  const [maximized, setMaximized] = createSignal(false);
  let ancestors: HTMLElement[] = [];
  let surface: HTMLElement | undefined;

  function hasDialog(): boolean {
    return document.querySelector('.dialog-overlay') !== null;
  }

  function restore(): void {
    if (!maximized()) return;
    surface?.removeAttribute('data-terminal-maximized');
    for (const ancestor of ancestors) {
      ancestor.removeAttribute('data-terminal-maximize-ancestor');
    }
    ancestors = [];
    setMaximized(false);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusin', onFocusIn, true);
    if (restoreActiveTerminal === restore) restoreActiveTerminal = undefined;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (
      event.key !== 'Escape' ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.defaultPrevented ||
      props.searchOpen ||
      hasDialog()
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    restore();
    props.focusTerminal();
  }

  function onFocusIn(event: FocusEvent): void {
    if (event.target instanceof Node && !surface?.contains(event.target) && !hasDialog()) {
      restore();
    }
  }

  function toggle(): void {
    if (maximized()) {
      restore();
    } else {
      surface = props.surface();
      if (!surface?.isConnected || hasDialog()) return;
      restoreActiveTerminal?.();
      // Fixed descendants must escape task appearance transforms and layout containment.
      // Attributes override CSS only while open; original inline styles are never rewritten.
      for (let parent = surface.parentElement; parent; parent = parent.parentElement) {
        ancestors.push(parent);
        parent.setAttribute('data-terminal-maximize-ancestor', '');
      }
      surface.setAttribute('data-terminal-maximized', 'true');
      setMaximized(true);
      restoreActiveTerminal = restore;
      window.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('focusin', onFocusIn, true);
    }
    props.focusTerminal();
  }

  onCleanup(restore);

  return (
    <button
      type="button"
      class="icon-btn terminal-maximize-button"
      aria-label={maximized() ? 'Restore terminal' : 'Maximize terminal'}
      aria-pressed={maximized()}
      title={maximized() ? 'Restore terminal (Esc)' : 'Maximize terminal'}
      style={{ top: props.searchOpen ? '52px' : '8px' }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
      // Keep click bubbling: the owning task/agent pane selects the exact command target.
      onClick={toggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d={
            maximized()
              ? 'M6 1v5H1m14 0h-5V1M1 10h5v5m4 0v-5h5'
              : 'M1 6V1h5m4 0h5v5M1 10v5h5m4 0h5v-5'
          }
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}
