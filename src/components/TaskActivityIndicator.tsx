import { Show, createMemo, type JSX } from 'solid-js';
import { assertNever } from '../lib/assert-never';
import { theme } from '../lib/theme';
import { getTaskActivityStatusLabel, type TaskActivityStatus } from '../store/taskStatus';

const INDICATOR_SIZE_PX = {
  md: 14,
  sm: 12,
} as const;

const ICON_SIZE_PX = {
  md: 10,
  sm: 8,
} as const;

const TASK_ACTIVITY_COLORS: Record<TaskActivityStatus, string> = {
  failed: theme.error,
  starting: theme.accent,
  sending: theme.warning,
  restoring: theme.accent,
  'flow-controlled': theme.accent,
  paused: theme.warning,
  'waiting-input': '#e5a800',
  live: theme.success,
  idle: theme.fgSubtle,
};

interface TaskActivityIndicatorProps {
  'aria-hidden'?: boolean;
  size?: 'sm' | 'md';
  status: TaskActivityStatus;
}

interface TaskActivityBadgeProps {
  showIcon?: boolean;
  status: TaskActivityStatus;
}

function getTaskActivityColor(status: TaskActivityStatus): string {
  return TASK_ACTIVITY_COLORS[status];
}

function createIcon(status: TaskActivityStatus, iconSizePx: number, color: string): JSX.Element {
  switch (status) {
    case 'starting':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 1.75v1.6M6 8.65v1.6M1.75 6h1.6M8.65 6h1.6M2.85 2.85l1.15 1.15M8 8l1.15 1.15M9.15 2.85 8 4M4 8 2.85 9.15"
            stroke={color}
            stroke-width="1.2"
            stroke-linecap="round"
          />
          <circle cx="6" cy="6" r="1.5" fill={color} />
        </svg>
      );
    case 'sending':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.1 6h5.6M5.9 3.4 8.7 6l-2.8 2.6"
            stroke={color}
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      );
    case 'live':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="3.25" fill={color} />
        </svg>
      );
    case 'idle':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="3.75" stroke={color} stroke-width="1.5" />
        </svg>
      );
    case 'waiting-input':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1.25" y="2" width="9.5" height="7" rx="1.5" stroke={color} stroke-width="1.2" />
          <path
            d="M3 6.75h2.25M6 6.75h1.5M8.5 6.75H9"
            stroke={color}
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>
      );
    case 'paused':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <rect x="2.25" y="2.1" width="2.1" height="7.8" rx="0.9" fill={color} />
          <rect x="7.65" y="2.1" width="2.1" height="7.8" rx="0.9" fill={color} />
        </svg>
      );
    case 'flow-controlled':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 3.75 6 6.5l3-2.75M3 6.75 6 9.5l3-2.75"
            stroke={color}
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      );
    case 'restoring':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M9.6 5.25A3.75 3.75 0 1 0 6.75 9.6"
            stroke={color}
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <path
            d="M7.1 2.1h2.8v2.8"
            stroke={color}
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      );
    case 'failed':
      return (
        <svg
          width={iconSizePx}
          height={iconSizePx}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3.1 3.1 8.9 8.9M8.9 3.1 3.1 8.9"
            stroke={color}
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      );
    default:
      return assertNever(status, 'Unhandled task activity status');
  }
}

export function TaskActivityIndicator(props: TaskActivityIndicatorProps): JSX.Element {
  const size = createMemo(() => props.size ?? 'sm');
  const indicatorSizePx = createMemo(() => INDICATOR_SIZE_PX[size()]);
  const iconSizePx = createMemo(() => ICON_SIZE_PX[size()]);
  const color = createMemo(() => getTaskActivityColor(props.status));
  const label = createMemo(() => getTaskActivityStatusLabel(props.status));
  const pulseClass = createMemo(() =>
    props.status === 'live' ||
    props.status === 'restoring' ||
    props.status === 'starting' ||
    props.status === 'sending'
      ? 'status-dot-pulse'
      : undefined,
  );

  return (
    <span
      class={pulseClass()}
      role={props['aria-hidden'] === true ? undefined : 'img'}
      aria-hidden={props['aria-hidden'] === true ? true : undefined}
      aria-label={props['aria-hidden'] === true ? undefined : label()}
      title={props['aria-hidden'] === true ? undefined : label()}
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        width: `${indicatorSizePx()}px`,
        height: `${indicatorSizePx()}px`,
        'border-radius': '999px',
        'flex-shrink': '0',
        color: color(),
        background: `color-mix(in srgb, ${color()} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color()} 28%, transparent)`,
      }}
    >
      {createIcon(props.status, iconSizePx(), color())}
    </span>
  );
}

export function TaskActivityBadge(props: TaskActivityBadgeProps): JSX.Element {
  const color = createMemo(() => getTaskActivityColor(props.status));
  const label = createMemo(() => getTaskActivityStatusLabel(props.status));

  return (
    <span
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '6px',
        padding: '2px 8px',
        'border-radius': '999px',
        background: `color-mix(in srgb, ${color()} 14%, transparent)`,
        color: color(),
        border: `1px solid color-mix(in srgb, ${color()} 20%, transparent)`,
        'flex-shrink': '0',
        'white-space': 'nowrap',
        'font-size': '11px',
        'font-weight': '600',
      }}
      aria-label={label()}
      title={label()}
    >
      <Show when={props.showIcon !== false}>
        <TaskActivityIndicator status={props.status} size="sm" aria-hidden />
      </Show>
      <span>{label()}</span>
    </span>
  );
}
