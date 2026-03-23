import type { JSX } from 'solid-js';

import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

interface TaskControlChipProps {
  busy?: boolean;
  label: string;
  onTakeOver: () => void;
  takeOverLabel?: string;
}

export function TaskControlChip(props: TaskControlChipProps): JSX.Element {
  return (
    <div
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '8px',
        padding: '6px 10px',
        background: 'color-mix(in srgb, var(--island-bg) 90%, rgba(186, 132, 27, 0.18))',
        border: `1px solid color-mix(in srgb, ${theme.warning ?? '#d4a017'} 55%, ${theme.border})`,
        'border-radius': '999px',
        'box-shadow': '0 8px 18px rgba(0, 0, 0, 0.18)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '8px',
          height: '8px',
          'border-radius': '999px',
          background: theme.warning ?? '#d4a017',
          'flex-shrink': '0',
        }}
      />
      <span
        style={{
          color: theme.fg,
          ...typography.metaStrong,
        }}
      >
        {props.label}
      </span>
      <button
        type="button"
        disabled={props.busy === true}
        onClick={() => props.onTakeOver()}
        style={{
          padding: '4px 10px',
          border: `1px solid ${theme.border}`,
          'border-radius': '999px',
          background: props.busy === true ? theme.bgHover : theme.bgElevated,
          color: theme.fg,
          cursor: props.busy === true ? 'wait' : 'pointer',
          ...typography.metaStrong,
        }}
      >
        {props.busy === true ? 'Taking over…' : (props.takeOverLabel ?? 'Take Over')}
      </button>
    </div>
  );
}
