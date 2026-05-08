import { Show, createEffect, createUniqueId, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createFocusRestore } from '../lib/focus-restore';
import { createFocusTrap } from '../lib/focus-trap';
import { isTopmostDialog, popDialog, pushDialog } from '../lib/dialog-stack';
import { theme } from '../lib/theme';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  width?: string;
  zIndex?: number;
  panelStyle?: JSX.CSSProperties;
  labelledBy?: string;
  describedBy?: string;
  children: JSX.Element;
}

export function Dialog(props: DialogProps): JSX.Element {
  let panelRef: HTMLDivElement | undefined;
  const dialogId = createUniqueId();

  createFocusRestore(() => props.open);
  createFocusTrap(
    () => props.open && isTopmostDialog(dialogId),
    () => panelRef,
  );

  createEffect(() => {
    if (!props.open) {
      return;
    }

    pushDialog(dialogId);
    onCleanup(() => popDialog(dialogId));
  });

  createEffect(() => {
    if (!props.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopmostDialog(dialogId)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  });

  // Scroll the panel with arrow/page keys, but ONLY when the panel itself
  // is focused — not when events bubble from interactive children like
  // <select>, <input>, etc.  We use a native listener (not SolidJS delegation)
  // so we can check e.target reliably.
  createEffect(() => {
    if (!props.open) return;
    const el = panelRef;
    if (!el) return;

    const step = 40;
    const page = 200;
    const handler = (e: KeyboardEvent) => {
      if (e.target !== el) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        el.scrollTop += step;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        el.scrollTop -= step;
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        el.scrollTop += page;
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        el.scrollTop -= page;
      }
    };
    el.addEventListener('keydown', handler);
    onCleanup(() => el.removeEventListener('keydown', handler));
  });

  return (
    <Portal>
      <Show when={props.open}>
        <div
          class="dialog-overlay"
          style={{
            position: 'fixed',
            inset: '0',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            background: 'rgba(0,0,0,0.55)',
            'z-index': String(props.zIndex ?? 1000),
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div
            ref={panelRef}
            tabIndex={0}
            role="dialog"
            aria-modal={isTopmostDialog(dialogId) ? 'true' : undefined}
            aria-labelledby={props.labelledBy}
            aria-describedby={props.describedBy}
            class="dialog-panel"
            style={{
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              'border-radius': '14px',
              padding: '28px',
              width: props.width ?? '400px',
              'max-height': '80vh',
              overflow: 'auto',
              display: 'flex',
              'flex-direction': 'column',
              gap: '16px',
              outline: 'none',
              'box-shadow': '0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset',
              ...props.panelStyle,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {props.children}
          </div>
        </div>
      </Show>
    </Portal>
  );
}
