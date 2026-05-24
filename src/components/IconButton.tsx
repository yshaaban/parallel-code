import { type JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

interface IconButtonProps {
  disabled?: boolean;
  icon: string | JSX.Element;
  onClick: (e: MouseEvent) => void;
  title?: string;
  size?: 'sm' | 'md';
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const isSm = () => props.size === 'sm';

  return (
    <button
      class="icon-btn"
      aria-label={props.title}
      disabled={props.disabled}
      title={props.title}
      onClick={(e) => {
        e.stopPropagation();
        if (props.disabled) {
          return;
        }
        props.onClick(e);
      }}
      style={{
        background: 'transparent',
        border: `1px solid ${theme.border}`,
        color: theme.fgMuted,
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.45 : 1,
        'border-radius': '6px',
        padding: isSm() ? '2px' : '4px',
        ...(isSm() ? typography.metaStrong : typography.uiStrong),
        'line-height': '1',
        'flex-shrink': '0',
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
      }}
    >
      {props.icon}
    </button>
  );
}
