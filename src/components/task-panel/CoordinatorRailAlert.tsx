import { Show, type JSX } from 'solid-js';
import { sf } from '../../lib/fontScale';
import { theme } from '../../lib/theme';

interface CoordinatorRailAlertProps {
  message: string;
  onDismiss: () => void;
  onRetry?: (() => void) | undefined;
}

// Full-width one-line alert strip overlaying the coordinator rail. Operator
// action rejections get a readable message (full text in the tooltip), an
// inline Retry for the failed action, and an explicit dismiss instead of
// competing with chips for rail pixels.
export function CoordinatorRailAlert(props: CoordinatorRailAlertProps): JSX.Element {
  return (
    <div
      role="alert"
      data-coordinator-rail-alert="true"
      title={props.message}
      style={{
        position: 'absolute',
        inset: '0',
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        padding: '0 8px',
        background: `color-mix(in srgb, ${theme.error} 10%, ${theme.taskPanelBg})`,
        'border-top': `1px solid color-mix(in srgb, ${theme.error} 40%, ${theme.border})`,
        'z-index': '5',
      }}
    >
      <span
        style={{
          color: theme.error,
          'font-size': sf(11),
          flex: '1 1 auto',
          'min-width': '0',
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
          'white-space': 'nowrap',
        }}
      >
        {props.message}
      </span>
      <Show when={props.onRetry}>
        {(retry) => (
          <button
            onClick={() => retry()()}
            style={{
              height: '22px',
              padding: '0 10px',
              border: `1px solid color-mix(in srgb, ${theme.error} 35%, ${theme.border})`,
              'border-radius': '8px',
              background: 'transparent',
              color: theme.fg,
              cursor: 'pointer',
              'font-size': sf(11),
              'flex-shrink': '0',
            }}
          >
            Retry
          </button>
        )}
      </Show>
      <button
        aria-label="Dismiss coordinator alert"
        onClick={() => props.onDismiss()}
        style={{
          height: '22px',
          width: '22px',
          border: 'none',
          background: 'transparent',
          color: theme.fgMuted,
          cursor: 'pointer',
          'font-size': sf(11),
          'flex-shrink': '0',
        }}
      >
        ✕
      </button>
    </div>
  );
}
