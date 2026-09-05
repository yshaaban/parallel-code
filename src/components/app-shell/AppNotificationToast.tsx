import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { theme } from '../../lib/theme';
import type { AppNotification } from '../../store/types';

interface AppNotificationToastProps {
  notification: AppNotification;
  onDismiss: () => void;
}

export function AppNotificationToast(props: AppNotificationToastProps): JSX.Element {
  const isError = (): boolean => props.notification.kind === 'error';
  const isWarning = (): boolean => props.notification.kind === 'warning';
  const isPersistent = (): boolean => isError() || props.notification.persistent === true;

  return (
    <div
      role={isError() ? 'alert' : 'status'}
      data-app-notification-kind={props.notification.kind}
      onClick={() => props.onDismiss()}
      style={{
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        'align-items': 'center',
        gap: '10px',
        background: theme.islandBg,
        border: isError()
          ? `1px solid color-mix(in srgb, ${theme.error} 45%, ${theme.border})`
          : isWarning()
            ? `1px solid color-mix(in srgb, ${theme.warning} 45%, ${theme.border})`
            : `1px solid ${theme.border}`,
        'border-radius': '8px',
        padding: '10px 20px',
        color: theme.fg,
        'font-size': '13px',
        'z-index': '2000',
        'box-shadow': '0 4px 24px rgba(0,0,0,0.4)',
        cursor: 'pointer',
        'max-width': 'min(560px, calc(100vw - 48px))',
      }}
    >
      <span style={{ 'word-break': 'break-word' }}>{props.notification.message}</span>
      <Show when={isPersistent()}>
        <button
          aria-label="Dismiss notification"
          onClick={(event) => {
            event.stopPropagation();
            props.onDismiss();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '13px',
            'line-height': '1',
            padding: '2px',
            'flex-shrink': '0',
          }}
        >
          ✕
        </button>
      </Show>
    </div>
  );
}
