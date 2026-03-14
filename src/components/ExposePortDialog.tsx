import { For, Show, createEffect, createSignal, on, type JSX, type Setter } from 'solid-js';
import type { TaskPortExposureCandidate } from '../domain/server-state';
import { theme } from '../lib/theme';
import { Dialog } from './Dialog';

interface ExposePortDialogProps {
  candidates: ReadonlyArray<TaskPortExposureCandidate>;
  defaultPort?: number;
  defaultLabel?: string | null;
  open: boolean;
  onClose: () => void;
  onExpose: (port: number, label?: string) => Promise<void> | void;
  onRefreshCandidates: () => Promise<void> | void;
  scanError: string | null;
  scanning: boolean;
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

function getCandidateSourceLabel(source: TaskPortExposureCandidate['source']): string {
  return source === 'task' ? 'Task' : 'Local';
}

function getCandidateFallbackMessage(scanError: string | null): string {
  return (
    scanError ?? 'No active local server ports found. You can still expose a custom port below.'
  );
}

export function ExposePortDialog(props: ExposePortDialogProps): JSX.Element {
  const [portText, setPortText] = createSignal(props.defaultPort ? String(props.defaultPort) : '');
  const [labelText, setLabelText] = createSignal(props.defaultLabel ?? '');
  const [submitting, setSubmitting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  createEffect(
    on(
      () => props.open,
      (isOpen) => {
        if (!isOpen) {
          return;
        }

        setPortText(props.defaultPort ? String(props.defaultPort) : '');
        setLabelText(props.defaultLabel ?? '');
        setSubmitting(false);
        setErrorMessage(null);
      },
    ),
  );

  function handlePortInput(
    event: InputEvent & { currentTarget: HTMLInputElement; target: HTMLInputElement },
  ): void {
    updatePortText(setPortText, event);
  }

  async function submitExpose(port: number): Promise<void> {
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

  async function handleSubmit(): Promise<void> {
    const port = Number.parseInt(portText(), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setErrorMessage('Enter a valid port between 1 and 65535.');
      return;
    }

    await submitExpose(port);
  }

  function handleCandidateExpose(port: number): void {
    setPortText(String(port));
    void submitExpose(port);
  }

  function handleRefreshCandidates(): void {
    void props.onRefreshCandidates();
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} width="360px">
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
        <div>
          <div style={{ 'font-size': '16px', 'font-weight': '700', color: theme.fg }}>
            Expose task port
          </div>
          <div style={{ 'font-size': '11px', color: theme.fgMuted, 'margin-top': '3px' }}>
            Choose an actively listening local port for preview and browser-mode proxying.
          </div>
        </div>

        <div
          style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}
        >
          <div style={{ 'font-size': '12px', color: theme.fgMuted }}>Listening ports</div>
          <button
            disabled={props.scanning}
            onClick={handleRefreshCandidates}
            style={{
              background: 'transparent',
              color: theme.fgMuted,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '6px 10px',
              cursor: props.scanning ? 'wait' : 'pointer',
              'font-size': '12px',
            }}
          >
            {props.scanning ? 'Scanning...' : 'Rescan'}
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            'max-height': '220px',
            overflow: 'auto',
          }}
        >
          <Show
            when={props.candidates.length > 0}
            fallback={
              <div
                style={{
                  background: theme.bgElevated,
                  color: props.scanError ? theme.error : theme.fgMuted,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  padding: '10px 12px',
                  'font-size': '12px',
                }}
              >
                {getCandidateFallbackMessage(props.scanError)}
              </div>
            }
          >
            <For each={props.candidates}>
              {(candidate) => (
                <div
                  style={{
                    display: 'flex',
                    'flex-direction': 'column',
                    gap: '6px',
                    background: theme.bgElevated,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    padding: '10px 12px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      'justify-content': 'space-between',
                      'align-items': 'center',
                      gap: '8px',
                    }}
                  >
                    <div style={{ color: theme.fg, 'font-size': '13px', 'font-weight': '700' }}>
                      Port {candidate.port}
                    </div>
                    <span
                      style={{
                        color: theme.accent,
                        'font-size': '10px',
                        'font-weight': '700',
                        'text-transform': 'uppercase',
                      }}
                    >
                      {getCandidateSourceLabel(candidate.source)}
                    </span>
                  </div>
                  <div style={{ color: theme.fgMuted, 'font-size': '11px' }}>
                    {candidate.suggestion}
                  </div>
                  <button
                    onClick={() => handleCandidateExpose(candidate.port)}
                    disabled={submitting()}
                    style={{
                      width: 'fit-content',
                      background: theme.bgElevated,
                      color: theme.fg,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '8px',
                      padding: '6px 10px',
                      cursor: submitting() ? 'wait' : 'pointer',
                      'font-size': '12px',
                      'font-weight': '600',
                    }}
                  >
                    Expose port
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div
          style={{
            'font-size': '11px',
            color: theme.fgMuted,
            'text-transform': 'uppercase',
            'letter-spacing': '0.04em',
          }}
        >
          Custom port
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
              padding: '8px 10px',
              'font-size': '13px',
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
              padding: '8px 10px',
              'font-size': '13px',
              outline: 'none',
            }}
          />
        </label>

        <div style={{ 'font-size': '12px', color: errorMessage() ? theme.error : theme.fgMuted }}>
          {errorMessage() ??
            'Exposed ports are the only ones proxied in browser mode. Use custom entry if the scanner misses your server.'}
        </div>

        <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '10px' }}>
          <button
            onClick={() => props.onClose()}
            style={{
              background: 'transparent',
              color: theme.fgMuted,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '7px 11px',
              cursor: 'pointer',
              'font-size': '12px',
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
              padding: '7px 11px',
              cursor: submitting() ? 'wait' : 'pointer',
              'font-weight': '700',
              'font-size': '12px',
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
