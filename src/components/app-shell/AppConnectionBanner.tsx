import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';
import type { ConnectionBannerState } from '../../runtime/browser-session';

interface AppConnectionBannerProps {
  message: string;
  state: ConnectionBannerState;
}

const CONNECTION_BANNER_BACKGROUND: Record<ConnectionBannerState, string> = {
  'auth-expired': theme.error,
  connecting: `${theme.warning}20`,
  disconnected: `${theme.error}20`,
  reconnecting: `${theme.warning}20`,
  restoring: `${theme.warning}20`,
};

const CONNECTION_BANNER_ACCENT: Record<ConnectionBannerState, string> = {
  'auth-expired': theme.error,
  connecting: theme.warning,
  disconnected: theme.error,
  reconnecting: theme.warning,
  restoring: theme.warning,
};

export function AppConnectionBanner(props: AppConnectionBannerProps): JSX.Element {
  return (
    <div
      style={{
        padding: '8px 12px',
        'border-bottom': `1px solid ${theme.border}`,
        background: CONNECTION_BANNER_BACKGROUND[props.state],
        color: CONNECTION_BANNER_ACCENT[props.state],
        'font-size': '12px',
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          'border-radius': '50%',
          background: CONNECTION_BANNER_ACCENT[props.state],
        }}
      />
      <span>{props.message}</span>
    </div>
  );
}
