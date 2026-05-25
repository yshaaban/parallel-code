import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import type { ConnectionBannerState } from '../../runtime/browser-session';

interface AppConnectionBannerProps {
  message: string;
  presentation?: 'bar' | 'overlay';
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
  function getPresentation(): 'bar' | 'overlay' {
    return props.presentation ?? 'bar';
  }

  function isOverlayPresentation(): boolean {
    return getPresentation() === 'overlay';
  }

  return (
    <div
      data-app-connection-banner="true"
      data-app-connection-banner-presentation={getPresentation()}
      data-app-connection-banner-state={props.state}
      style={{
        padding: isOverlayPresentation() ? '6px 10px' : '8px 12px',
        'border-bottom': isOverlayPresentation() ? 'none' : `1px solid ${theme.border}`,
        border: isOverlayPresentation() ? `1px solid ${theme.border}` : 'none',
        'border-radius': isOverlayPresentation() ? '6px' : '0',
        background: CONNECTION_BANNER_BACKGROUND[props.state],
        color: CONNECTION_BANNER_ACCENT[props.state],
        ...typography.meta,
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        ...(isOverlayPresentation()
          ? {
              position: 'absolute',
              right: '12px',
              top: '12px',
              'z-index': 30,
              'box-shadow': `0 8px 24px ${theme.bg}66`,
            }
          : {}),
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
