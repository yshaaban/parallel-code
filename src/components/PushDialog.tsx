import { Show, createSignal } from 'solid-js';
import { pushTask } from '../store/store';
import { ConfirmDialog } from './ConfirmDialog';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';

interface PushDialogProps {
  open: boolean;
  task: Task;
  onStart: () => void;
  onDone: (success: boolean) => void;
}

export function PushDialog(props: PushDialogProps) {
  const [pushError, setPushError] = createSignal('');
  const [pushing, setPushing] = createSignal(false);

  return (
    <ConfirmDialog
      open={props.open}
      title="Push to Remote"
      message={
        <div>
          <p style={{ margin: '0 0 8px' }}>
            Push branch <strong>{props.task.branchName}</strong> to remote?
          </p>
          <Show when={pushError()}>
            <div
              style={{
                'margin-top': '12px',
                'font-size': '12px',
                color: theme.error,
                background: `color-mix(in srgb, ${theme.error} 8%, transparent)`,
                padding: '8px 12px',
                'border-radius': '8px',
                border: `1px solid color-mix(in srgb, ${theme.error} 20%, transparent)`,
              }}
            >
              {pushError()}
            </div>
          </Show>
        </div>
      }
      confirmLabel={pushing() ? 'Pushing...' : 'Push'}
      onConfirm={() => {
        const taskId = props.task.id;
        const onStart = props.onStart;
        const onDone = props.onDone;
        setPushError('');
        setPushing(true);
        onStart();
        void pushTask(taskId)
          .then(() => {
            onDone(true);
          })
          .catch((err) => {
            setPushError(String(err));
            onDone(false);
          })
          .finally(() => {
            setPushing(false);
          });
      }}
      onCancel={() => {
        props.onDone(false);
        setPushError('');
      }}
    />
  );
}
