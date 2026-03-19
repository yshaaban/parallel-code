import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';
import type { ConnectionBannerState } from '../../runtime/browser-session';

interface AppConnectionBannerProps {
  message: string;
  state: ConnectionBannerState;
}

function getConnectionBannerBackground(state: ConnectionBannerState): string {
  switch (state) {
    case 'auth-expired':
      return theme.error;
    case 'disconnected':
      return `${theme.error}20`;
    default:
      return `${theme.warning}20`;
  }
}

function getConnectionBannerAccent(state: ConnectionBannerState): string {
  switch (state) {
    case 'auth-expired':
    case 'disconnected':
      return theme.error;
    default:
      return theme.warning;
  }
}

export function AppConnectionBanner(props: AppConnectionBannerProps): JSX.Element {
  return (
    <div
      style={{
        padding: '8px 12px',
        'border-bottom': `1px solid ${theme.border}`,
        background: getConnectionBannerBackground(props.state),
        color: getConnectionBannerAccent(props.state),
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
          background: getConnectionBannerAccent(props.state),
        }}
      />
      <span>{props.message}</span>
    </div>
  );
}
