import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { IncomingTaskTakeoverRequest } from '../store/types';

interface TaskTakeoverRequestDialogProps {
  busy?: boolean;
  index?: number;
  onApprove: (requestId: string, taskId: string) => void;
  onDeny: (requestId: string, taskId: string) => void;
  onExpire: (requestId: string, taskId: string) => void;
  request: IncomingTaskTakeoverRequest | null;
}

function getCardTop(index: number): string {
  return `${24 + index * 156}px`;
}

function getRequestElementId(requestId: string, suffix: string): string {
  return `task-takeover-${requestId.replace(/[^A-Za-z0-9_-]/g, '-')}-${suffix}`;
}

export function TaskTakeoverRequestDialog(props: TaskTakeoverRequestDialogProps): JSX.Element {
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

    const { requestId, taskId } = request;
    const onExpire = props.onExpire;
    const timeout = window.setTimeout(
      () => {
        onExpire(requestId, taskId);
      },
      Math.max(0, request.expiresAt - Date.now()),
    );

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

    return `${request.requesterDisplayName} wants to take control of this task to ${request.action}.`;
  });

  return (
    <Show when={props.request}>
      {(request) => (
        <div
          class="task-takeover-request-card"
          role="alertdialog"
          aria-busy={props.busy ? 'true' : 'false'}
          aria-labelledby={getRequestElementId(request().requestId, 'title')}
          aria-describedby={getRequestElementId(request().requestId, 'message')}
          style={{
            position: 'fixed',
            top: getCardTop(props.index ?? 0),
            right: '24px',
            width: 'min(380px, calc(100vw - 32px))',
            padding: '16px',
            display: 'grid',
            gap: '12px',
            background: `color-mix(in srgb, ${theme.islandBg} 94%, ${theme.bgElevated})`,
            border: `1px solid ${theme.border}`,
            'border-radius': '16px',
            'box-shadow': '0 20px 48px rgba(0, 0, 0, 0.34)',
            'backdrop-filter': 'blur(18px)',
            'z-index': `${2000 - (props.index ?? 0)}`,
          }}
        >
          <div style={{ display: 'grid', gap: '4px' }}>
            <div
              id={getRequestElementId(request().requestId, 'title')}
              style={{
                color: theme.fg,
                ...typography.uiStrong,
              }}
            >
              Allow takeover?
            </div>
            <div
              id={getRequestElementId(request().requestId, 'message')}
              style={{
                color: theme.fgMuted,
                ...typography.ui,
              }}
            >
              {message()}
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
              gap: '12px',
            }}
          >
            <span
              style={{
                color: theme.fgMuted,
                ...typography.monoMeta,
              }}
            >
              Times out in {secondsRemaining()}s
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                class="btn-secondary"
                disabled={props.busy}
                onClick={() => {
                  props.onDeny(request().requestId, request().taskId);
                }}
              >
                {props.busy ? 'Working…' : 'Keep Control'}
              </button>
              <button
                type="button"
                class="btn-primary"
                disabled={props.busy}
                onClick={() => {
                  props.onApprove(request().requestId, request().taskId);
                }}
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
