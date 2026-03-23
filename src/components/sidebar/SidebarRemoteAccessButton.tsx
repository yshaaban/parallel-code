import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';

function getRemoteAccessLabel(connected: boolean, electronRuntime: boolean): string {
  if (connected) {
    return electronRuntime ? 'Phone Connected' : 'Peer Connected';
  }
  return electronRuntime ? 'Connect Phone' : 'Server Access';
}

interface SidebarRemoteAccessButtonProps {
  connected: boolean;
  electronRuntime: boolean;
  onClick: () => void;
}

export function SidebarRemoteAccessButton(props: SidebarRemoteAccessButtonProps) {
  const accent = () => (props.connected ? theme.success : theme.fgMuted);

  return (
    <button
      onClick={() => props.onClick()}
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: 'var(--space-2xs)',
        padding: 'var(--space-2xs) var(--space-xs)',
        background: 'transparent',
        border: `1px solid ${props.connected ? theme.success : theme.border}`,
        'border-radius': '8px',
        color: accent(),
        cursor: 'pointer',
        'flex-shrink': '0',
        width: '100%',
        'justify-content': 'center',
        ...typography.metaStrong,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke={accent()}
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </svg>
      {getRemoteAccessLabel(props.connected, props.electronRuntime)}
    </button>
  );
}
