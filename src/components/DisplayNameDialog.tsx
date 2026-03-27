import { Show, createEffect, createSignal, type JSX } from 'solid-js';
import type { AppStartupSummary } from '../app/app-startup-status';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

interface DisplayNameDialogProps {
  allowClose?: boolean;
  confirmLabel?: string;
  description?: string;
  initialValue?: string;
  onClose?: () => void;
  open: boolean;
  onSave: (value: string) => void;
  startupSummary?: AppStartupSummary | null;
  title?: string;
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

  function close(): void {
    if (!props.allowClose) {
      return;
    }

    props.onClose?.();
  }

  function getTitle(): string {
    return props.title ?? 'Choose a display name';
  }

  function getDescription(): string {
    return (
      props.description ??
      'Other joined sessions will see this name when you are viewing, typing, or controlling a task.'
    );
  }

  function getConfirmLabel(): string {
    return props.confirmLabel ?? 'Continue';
  }

  return (
    <Dialog open={props.open} onClose={close} width="420px">
      <DialogHeader
        description={getDescription()}
        descriptionTone="muted"
        title={getTitle()}
        titleSize="lg"
      />
      <Show when={props.startupSummary}>
        {(startupSummary) => (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: 'flex',
              'align-items': 'flex-start',
              gap: '10px',
              padding: '10px 12px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '10px',
              color: theme.fg,
            }}
          >
            <span
              class="inline-spinner"
              aria-hidden="true"
              style={{ width: '12px', height: '12px' }}
            />
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              <span style={typography.metaStrong}>{startupSummary().label}</span>
              <span
                style={{
                  ...typography.meta,
                  color: theme.fgMuted,
                  'min-height': typography.meta['font-size'],
                  visibility: startupSummary().detail ? 'visible' : 'hidden',
                }}
              >
                {startupSummary().detail ?? ''}
              </span>
            </div>
          </div>
        )}
      </Show>
      <label
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
          ...typography.meta,
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
            ...typography.ui,
            'font-family': 'inherit',
          }}
        />
      </label>
      <div
        style={{
          display: 'flex',
          gap: '10px',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <Show when={props.allowClose}>
          <button
            type="button"
            onClick={close}
            style={{
              padding: '9px 20px',
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fg,
              cursor: 'pointer',
              ...typography.uiStrong,
            }}
          >
            Cancel
          </button>
        </Show>
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
            ...typography.uiStrong,
          }}
        >
          {getConfirmLabel()}
        </button>
      </div>
    </Dialog>
  );
}
