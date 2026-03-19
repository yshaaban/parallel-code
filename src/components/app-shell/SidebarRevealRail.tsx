import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';

interface SidebarRevealRailProps {
  onClick: () => void;
  shortcutLabel: string;
}

export function SidebarRevealRail(props: SidebarRevealRailProps): JSX.Element {
  return (
    <button
      class="icon-btn"
      onClick={() => props.onClick()}
      title={`Show sidebar (${props.shortcutLabel})`}
      style={{
        width: '24px',
        'min-width': '24px',
        height: 'calc(100% - 12px)',
        margin: '6px 4px 6px 0',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        cursor: 'pointer',
        color: theme.fgSubtle,
        background: 'transparent',
        'border-top': `2px dashed ${theme.border}`,
        'border-right': `2px dashed ${theme.border}`,
        'border-bottom': `2px dashed ${theme.border}`,
        'border-left': 'none',
        'border-radius': '0 12px 12px 0',
        'user-select': 'none',
        'flex-shrink': '0',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
      </svg>
    </button>
  );
}
