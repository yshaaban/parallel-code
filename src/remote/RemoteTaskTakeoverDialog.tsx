import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import type { TaskCommandTakeoverRequestMessage } from '../../electron/remote/protocol';
import { typography } from '../lib/typography';
import './remote-task-takeover-dialog.css';

interface RemoteTaskTakeoverDialogProps {
  busyRequestIds: ReadonlySet<string>;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onExpire: (requestId: string) => void;
  requests: ReadonlyArray<TaskCommandTakeoverRequestMessage>;
}

interface RemoteTakeoverRequestCardProps {
  busy: boolean;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onExpire: (requestId: string) => void;
  request: TaskCommandTakeoverRequestMessage;
}

function RemoteTakeoverRequestCard(props: RemoteTakeoverRequestCardProps): JSX.Element {
  const [now, setNow] = createSignal(Date.now());

  createEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 250);

    onCleanup(() => {
      clearInterval(timer);
    });
  });

  createEffect(() => {
    const onExpire = props.onExpire;
    const requestId = props.request.requestId;
    const expiresInMs = Math.max(0, props.request.expiresAt - Date.now());
    const timeout = window.setTimeout(() => {
      onExpire(requestId);
    }, expiresInMs);

    onCleanup(() => {
      clearTimeout(timeout);
    });
  });

  const message = createMemo(
    () => `${props.request.requesterDisplayName} wants to take control to ${props.request.action}.`,
  );
  const secondsRemaining = createMemo(() =>
    Math.max(0, Math.ceil((props.request.expiresAt - now()) / 1_000)),
  );

  return (
    <div data-request-id={props.request.requestId} class="remote-takeover-card">
      <div style={{ display: 'grid', gap: '6px' }}>
        <div
          style={{
            ...typography.display,
            color: 'var(--text-primary)',
          }}
        >
          Allow takeover?
        </div>
        <p
          style={{
            ...typography.ui,
            color: 'var(--text-secondary)',
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
        <span style={{ ...typography.meta, color: 'var(--text-muted)' }}>
          Times out in {secondsRemaining()}s
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            class="surface-btn tap-feedback"
            disabled={props.busy}
            onClick={() => props.onDeny(props.request.requestId)}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              'border-radius': '12px',
              padding: '10px 12px',
              color: 'var(--text-secondary)',
              ...typography.ui,
              cursor: props.busy ? 'default' : 'pointer',
              opacity: props.busy ? '0.7' : '1',
            }}
          >
            {props.busy ? 'Sending…' : 'Keep control'}
          </button>
          <button
            type="button"
            class="accent-btn tap-feedback"
            disabled={props.busy}
            onClick={() => props.onApprove(props.request.requestId)}
            style={{
              background: 'var(--accent)',
              border: 'none',
              'border-radius': '12px',
              padding: '10px 12px',
              color: '#031018',
              ...typography.uiStrong,
              cursor: props.busy ? 'default' : 'pointer',
              opacity: props.busy ? '0.7' : '1',
            }}
          >
            {props.busy ? 'Sending…' : 'Allow'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoteTaskTakeoverDialog(props: RemoteTaskTakeoverDialogProps): JSX.Element {
  return (
    <Show when={props.requests.length > 0}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Allow mobile takeover requests"
        class="remote-takeover-overlay"
      >
        <div class="remote-takeover-stack">
          <Show when={props.requests.length > 1}>
            <div
              style={{
                padding: '0 6px',
                ...typography.meta,
                color: 'var(--text-muted)',
                'text-align': 'center',
              }}
            >
              {props.requests.length} takeover requests pending
            </div>
          </Show>
          <For each={props.requests}>
            {(request) => (
              <RemoteTakeoverRequestCard
                busy={props.busyRequestIds.has(request.requestId)}
                onApprove={props.onApprove}
                onDeny={props.onDeny}
                onExpire={props.onExpire}
                request={request}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
