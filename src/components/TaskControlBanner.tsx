import type { JSX } from 'solid-js';

import { theme } from '../lib/theme';

interface TaskControlBannerProps {
  busy?: boolean;
  message: string;
  onDismiss?: () => void;
  onTakeOver: () => void;
  takeOverLabel?: string;
  style?: JSX.CSSProperties;
}

export function TaskControlBanner(props: TaskControlBannerProps): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        gap: '12px',
        padding: '10px 12px',
        background: 'color-mix(in srgb, var(--panel-bg, transparent) 70%, rgba(0,0,0,0.22))',
        border: `1px solid ${theme.border}`,
        'border-radius': '10px',
        color: theme.fg,
        'font-size': '12px',
        'line-height': '1.4',
        'box-shadow': '0 10px 24px rgba(0, 0, 0, 0.18)',
        ...props.style,
      }}
    >
      <div style={{ flex: '1', 'min-width': '0', color: theme.fgMuted }}>{props.message}</div>
      {props.onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss control notice"
          onClick={() => props.onDismiss?.()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '14px',
            'line-height': '1',
            padding: '0',
          }}
        >
          ×
        </button>
      ) : null}
      <button
        type="button"
        class="btn-primary"
        disabled={props.busy === true}
        onClick={() => props.onTakeOver()}
        style={{
          'flex-shrink': '0',
          padding: '6px 12px',
          background: theme.accent,
          color: theme.accentText,
          border: 'none',
          'border-radius': '999px',
          cursor: props.busy === true ? 'wait' : 'pointer',
          opacity: props.busy === true ? '0.7' : '1',
          'font-size': '12px',
          'font-weight': '600',
        }}
      >
        {props.busy === true ? 'Taking over…' : (props.takeOverLabel ?? 'Take Over')}
      </button>
    </div>
  );
}
