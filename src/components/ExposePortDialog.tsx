import { createEffect, createSignal, type JSX, type Setter } from 'solid-js';
import { theme } from '../lib/theme';
import { Dialog } from './Dialog';

interface ExposePortDialogProps {
  defaultPort?: number;
  defaultLabel?: string | null;
  open: boolean;
  onClose: () => void;
  onExpose: (port: number, label?: string) => Promise<void> | void;
}

function normalizeDialogLabel(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function updatePortText(
  setPortText: Setter<string>,
  event: InputEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement },
): void {
  setPortText(event.currentTarget.value.replace(/[^\d]/g, ''));
}

export function ExposePortDialog(props: ExposePortDialogProps): JSX.Element {
  const [portText, setPortText] = createSignal(props.defaultPort ? String(props.defaultPort) : '');
  const [labelText, setLabelText] = createSignal(props.defaultLabel ?? '');
  const [submitting, setSubmitting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  createEffect(() => {
    if (!props.open) {
      return;
    }

    setPortText(props.defaultPort ? String(props.defaultPort) : '');
    setLabelText(props.defaultLabel ?? '');
    setSubmitting(false);
    setErrorMessage(null);
  });

  function handlePortInput(
    event: InputEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement },
  ): void {
    updatePortText(setPortText, event);
  }

  async function handleSubmit(): Promise<void> {
    const port = Number.parseInt(portText(), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setErrorMessage('Enter a valid port between 1 and 65535.');
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      await props.onExpose(port, normalizeDialogLabel(labelText()));
      props.onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to expose port');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} width="420px">
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <div>
          <div style={{ 'font-size': '18px', 'font-weight': '700', color: theme.fg }}>
            Expose task port
          </div>
          <div style={{ 'font-size': '12px', color: theme.fgMuted, 'margin-top': '4px' }}>
            Map a localhost port for previewing and browser-mode proxying.
          </div>
        </div>

        <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <span style={{ 'font-size': '12px', color: theme.fgMuted }}>Port</span>
          <input
            value={portText()}
            onInput={handlePortInput}
            placeholder="5173"
            inputmode="numeric"
            style={{
              background: theme.bgElevated,
              color: theme.fg,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 12px',
              'font-size': '14px',
              outline: 'none',
            }}
          />
        </label>

        <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <span style={{ 'font-size': '12px', color: theme.fgMuted }}>Label (optional)</span>
          <input
            value={labelText()}
            onInput={(event) => setLabelText(event.currentTarget.value)}
            placeholder="Frontend dev server"
            style={{
              background: theme.bgElevated,
              color: theme.fg,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 12px',
              'font-size': '14px',
              outline: 'none',
            }}
          />
        </label>

        <div style={{ 'font-size': '12px', color: errorMessage() ? theme.error : theme.fgMuted }}>
          {errorMessage() ??
            'Observed ports are suggestions. Exposed ports are the only ones proxied in browser mode.'}
        </div>

        <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '10px' }}>
          <button
            onClick={() => props.onClose()}
            style={{
              background: 'transparent',
              color: theme.fgMuted,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '8px 12px',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            disabled={submitting()}
            onClick={() => {
              void handleSubmit();
            }}
            style={{
              background: theme.accent,
              color: '#081018',
              border: 'none',
              'border-radius': '8px',
              padding: '8px 12px',
              cursor: submitting() ? 'wait' : 'pointer',
              'font-weight': '700',
              opacity: submitting() ? 0.7 : 1,
            }}
          >
            {submitting() ? 'Exposing...' : 'Expose'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
