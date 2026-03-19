import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';

interface AppNotificationToastProps {
  message: string;
  onDismiss: () => void;
}

export function AppNotificationToast(props: AppNotificationToastProps): JSX.Element {
  return (
    <div
      onClick={() => props.onDismiss()}
      style={{
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: theme.islandBg,
        border: `1px solid ${theme.border}`,
        'border-radius': '8px',
        padding: '10px 20px',
        color: theme.fg,
        'font-size': '13px',
        'z-index': '2000',
        'box-shadow': '0 4px 24px rgba(0,0,0,0.4)',
        cursor: 'pointer',
      }}
    >
      {props.message}
    </div>
  );
}
