import { createEffect, createSignal, type JSX } from 'solid-js';
import { typography } from '../lib/typography';

interface RemoteSessionNameDialogProps {
  initialValue: string;
  onSave: (value: string) => void;
  open: boolean;
}

export function RemoteSessionNameDialog(props: RemoteSessionNameDialogProps): JSX.Element {
  let inputRef: HTMLInputElement | undefined;
  const [value, setValue] = createSignal(props.initialValue);

  createEffect(() => {
    if (!props.open) {
      return;
    }

    setValue(props.initialValue);
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  });

  function handleSave(): void {
    const nextValue = value().trim();
    if (!nextValue) {
      return;
    }

    props.onSave(nextValue);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Name this mobile session"
      style={{
        position: 'fixed',
        inset: '0',
        display: props.open ? 'flex' : 'none',
        'align-items': 'flex-end',
        'justify-content': 'center',
        background: 'rgba(4, 7, 10, 0.68)',
        padding: '20px 14px calc(14px + env(safe-area-inset-bottom))',
        'z-index': '100',
        animation: 'fadeIn 0.2s ease-out',
      }}
    >
      <div
        style={{
          width: 'min(100%, 420px)',
          padding: '18px 16px 16px',
          background:
            'linear-gradient(180deg, rgba(18, 24, 31, 0.98) 0%, rgba(11, 15, 20, 0.98) 100%)',
          border: '1px solid rgba(46, 200, 255, 0.16)',
          'border-radius': '22px',
          display: 'grid',
          gap: '14px',
          'box-shadow': '0 24px 48px rgba(0, 0, 0, 0.34)',
          animation: 'slideUp 0.24s ease-out',
        }}
      >
        <div style={{ display: 'grid', gap: '6px' }}>
          <div style={{ ...typography.display, color: 'var(--text-primary)' }}>
            Name this mobile session
          </div>
          <p style={{ ...typography.ui, color: 'var(--text-secondary)' }}>
            Shown on desktop while you control a task.
          </p>
        </div>

        <label style={{ display: 'grid', gap: '8px' }}>
          <span style={{ ...typography.meta, color: 'var(--text-muted)' }}>Session name</span>
          <input
            ref={inputRef}
            type="text"
            value={value()}
            maxLength={40}
            onInput={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSave();
              }
            }}
            style={{
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              'border-radius': '14px',
              padding: '12px 14px',
              color: 'var(--text-primary)',
              ...typography.body,
              outline: 'none',
            }}
          />
        </label>

        <button
          type="button"
          class="accent-btn tap-feedback"
          disabled={value().trim().length === 0}
          onClick={handleSave}
          style={{
            width: '100%',
            border: 'none',
            'border-radius': '14px',
            padding: '12px 16px',
            background: value().trim().length === 0 ? 'var(--bg-elevated)' : 'var(--accent)',
            color: value().trim().length === 0 ? 'var(--text-muted)' : '#031018',
            ...typography.uiStrong,
            cursor: value().trim().length === 0 ? 'default' : 'pointer',
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
