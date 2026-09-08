import type { JSX } from 'solid-js';

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
    <div class="task-control-notice" style={props.style}>
      <span class="task-control-notice__message" title={props.message} role="status">
        {props.message}
      </span>
      {props.onDismiss ? (
        <button
          type="button"
          class="compact-action task-control-notice__dismiss"
          aria-label="Dismiss control notice"
          onClick={() => props.onDismiss?.()}
        >
          ×
        </button>
      ) : null}
      <button
        type="button"
        class="compact-action"
        disabled={props.busy === true}
        onClick={() => props.onTakeOver()}
      >
        {props.busy === true ? 'Taking over…' : (props.takeOverLabel ?? 'Take Over')}
      </button>
    </div>
  );
}
