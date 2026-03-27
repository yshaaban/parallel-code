import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
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
      data-app-connection-banner="true"
      data-app-connection-banner-state={props.state}
      style={{
        padding: '8px 12px',
        'border-bottom': `1px solid ${theme.border}`,
        background: CONNECTION_BANNER_BACKGROUND[props.state],
        color: CONNECTION_BANNER_ACCENT[props.state],
        ...typography.meta,
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
