import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import type { TaskCommandTakeoverRequestMessage } from '../../electron/remote/protocol';

interface RemoteTaskTakeoverDialogProps {
  busyRequestId: string | null;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onExpire: (requestId: string) => void;
  request: TaskCommandTakeoverRequestMessage | null;
}

export function RemoteTaskTakeoverDialog(props: RemoteTaskTakeoverDialogProps): JSX.Element {
  const [now, setNow] = createSignal(Date.now());

  createEffect(() => {
    if (!props.request) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 250);

    onCleanup(() => {
      clearInterval(timer);
    });
  });

  createEffect(() => {
    const request = props.request;
    if (!request) {
      return;
    }

    const onExpire = props.onExpire;
    const requestId = request.requestId;
    const expiresInMs = Math.max(0, request.expiresAt - Date.now());
    const timeout = window.setTimeout(() => {
      onExpire(requestId);
    }, expiresInMs);

    onCleanup(() => {
      clearTimeout(timeout);
    });
  });

  const secondsRemaining = createMemo(() => {
    const request = props.request;
    if (!request) {
      return 0;
    }

    return Math.max(0, Math.ceil((request.expiresAt - now()) / 1_000));
  });

  const message = createMemo(() => {
    const request = props.request;
    if (!request) {
      return '';
    }

    return `${request.requesterDisplayName} wants to take control to ${request.action}.`;
  });

  const isBusy = createMemo(() => {
    const request = props.request;
    return request !== null && props.busyRequestId === request.requestId;
  });

  return (
    <Show when={props.request}>
      {(request) => {
        const requestId = request().requestId;

        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Allow mobile takeover"
            style={{
              position: 'fixed',
              inset: '0',
              display: 'flex',
              'align-items': 'flex-end',
              'justify-content': 'center',
              padding: '16px 12px calc(12px + env(safe-area-inset-bottom))',
              background: 'rgba(4, 7, 10, 0.58)',
              'z-index': '120',
            }}
          >
            <div
              style={{
                width: 'min(100%, 420px)',
                padding: '18px 16px 16px',
                background:
                  'linear-gradient(180deg, rgba(18, 24, 31, 0.98) 0%, rgba(11, 15, 20, 0.98) 100%)',
                border: '1px solid rgba(255, 197, 105, 0.22)',
                'border-radius': '22px',
                display: 'grid',
                gap: '14px',
                'box-shadow': '0 24px 48px rgba(0, 0, 0, 0.34)',
                animation: 'slideUp 0.24s ease-out',
              }}
            >
              <div style={{ display: 'grid', gap: '6px' }}>
                <div
                  style={{
                    'font-size': '17px',
                    'font-weight': '700',
                    color: 'var(--text-primary)',
                  }}
                >
                  Allow takeover?
                </div>
                <p
                  style={{
                    'font-size': '13px',
                    color: 'var(--text-secondary)',
                    'line-height': '1.55',
                  }}
                >
                  {message()}
                </p>
              </div>

              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'space-between',
                  gap: '12px',
                }}
              >
                <span style={{ 'font-size': '12px', color: 'var(--text-muted)' }}>
                  Times out in {secondsRemaining()}s
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    class="surface-btn tap-feedback"
                    disabled={isBusy()}
                    onClick={() => props.onDeny(requestId)}
                    style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      'border-radius': '12px',
                      padding: '10px 12px',
                      color: 'var(--text-secondary)',
                      'font-size': '13px',
                      cursor: isBusy() ? 'default' : 'pointer',
                      opacity: isBusy() ? '0.7' : '1',
                    }}
                  >
                    {isBusy() ? 'Sending…' : 'Keep control'}
                  </button>
                  <button
                    type="button"
                    class="accent-btn tap-feedback"
                    disabled={isBusy()}
                    onClick={() => props.onApprove(requestId)}
                    style={{
                      background: 'var(--accent)',
                      border: 'none',
                      'border-radius': '12px',
                      padding: '10px 12px',
                      color: '#031018',
                      'font-size': '13px',
                      'font-weight': '700',
                      cursor: isBusy() ? 'default' : 'pointer',
                      opacity: isBusy() ? '0.7' : '1',
                    }}
                  >
                    {isBusy() ? 'Sending…' : 'Allow'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
