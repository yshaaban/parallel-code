import { createEffect, createSignal, type JSX } from 'solid-js';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';

interface DisplayNameDialogProps {
  initialValue?: string;
  open: boolean;
  onSave: (value: string) => void;
}

export function DisplayNameDialog(props: DisplayNameDialogProps): JSX.Element {
  let inputRef: HTMLInputElement | undefined;
  const [value, setValue] = createSignal(props.initialValue ?? '');

  createEffect(() => {
    if (!props.open) {
      return;
    }

    setValue(props.initialValue ?? '');
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  });

  function save(): void {
    const nextValue = value().trim();
    if (!nextValue) {
      return;
    }

    props.onSave(nextValue);
  }

  return (
    <Dialog open={props.open} onClose={() => {}} width="420px">
      <h2
        style={{
          margin: '0',
          'font-size': '18px',
          'font-weight': '700',
          color: theme.fg,
        }}
      >
        Choose a display name
      </h2>
      <p
        style={{
          margin: '0',
          'font-size': '13px',
          color: theme.fgMuted,
          'line-height': '1.5',
        }}
      >
        Other joined sessions will see this name when you are viewing, typing, or controlling a
        task.
      </p>
      <label
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
          'font-size': '12px',
          color: theme.fgMuted,
        }}
      >
        <span>Display name</span>
        <input
          ref={inputRef}
          value={value()}
          maxLength={40}
          onInput={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          }}
          style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '10px',
            color: theme.fg,
            padding: '10px 12px',
            'font-size': '14px',
            'font-family': 'inherit',
          }}
        />
      </label>
      <div
        style={{
          display: 'flex',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <button
          type="button"
          disabled={value().trim().length === 0}
          onClick={save}
          style={{
            padding: '9px 20px',
            background: theme.accent,
            border: 'none',
            'border-radius': '8px',
            color: theme.accentText,
            cursor: value().trim().length === 0 ? 'not-allowed' : 'pointer',
            opacity: value().trim().length === 0 ? '0.55' : '1',
            'font-size': '13px',
            'font-weight': '600',
          }}
        >
          Continue
        </button>
      </div>
    </Dialog>
  );
}
