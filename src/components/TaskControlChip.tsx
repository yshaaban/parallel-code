import type { JSX } from 'solid-js';

interface TaskControlChipProps {
  busy?: boolean;
  label: string;
  onTakeOver: () => void;
  takeOverLabel?: string;
}

export function TaskControlChip(props: TaskControlChipProps): JSX.Element {
  return (
    <div class="task-control-notice">
      <span class="task-control-notice__message" title={props.label} role="status">
        {props.label}
      </span>
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
