import { Show, createEffect, createSignal } from 'solid-js';
import { pushTask } from '../app/task-workflows';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { InlineNotice } from './InlineNotice';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { Task } from '../store/types';

interface PushDialogProps {
  open: boolean;
  task: Task;
  onStart: () => void;
  onClose: () => void;
  onDone: (success: boolean) => void;
}

export function PushDialog(props: PushDialogProps) {
  const [pushError, setPushError] = createSignal('');
  const [pushing, setPushing] = createSignal(false);
  const [output, setOutput] = createSignal('');
  let outputRef: HTMLPreElement | undefined;

  createEffect(() => {
    if (props.open && !pushing()) {
      setPushError('');
      setOutput('');
    }
  });

  function resetDialogState(): void {
    setPushError('');
    setOutput('');
  }

  function cancelIdleDialog(): void {
    props.onDone(false);
    resetDialogState();
  }

  function finishPush(success: boolean): void {
    setPushing(false);
    props.onDone(success);
  }

  function closeWhileRunning(): void {
    props.onClose();
  }

  function handleDialogClose(): void {
    if (pushing()) {
      closeWhileRunning();
      return;
    }

    cancelIdleDialog();
  }

  function appendOutput(text: string): void {
    setOutput((current) => current + text);
    requestAnimationFrame(() => {
      if (outputRef) {
        outputRef.scrollTop = outputRef.scrollHeight;
      }
    });
  }

  function startPush(): void {
    resetDialogState();
    setPushing(true);
    props.onStart();

    void runPush(props.task.id);
  }

  async function runPush(taskId: string): Promise<void> {
    try {
      await pushTask(taskId, appendOutput);
      finishPush(true);
    } catch (error) {
      setPushError(String(error));
      finishPush(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={handleDialogClose} width="480px">
      <DialogHeader title="Push to Remote" />
      <div style={{ ...typography.ui, color: theme.fgMuted }}>
        <Show
          when={pushing() || output()}
          fallback={
            <p style={{ margin: '0 0 8px' }}>
              Push branch <strong>{props.task.branchName}</strong> to remote?
            </p>
          }
        >
          <pre
            ref={outputRef}
            style={{
              margin: '0',
              ...typography.monoMeta,
              'white-space': 'pre-wrap',
              'word-break': 'break-all',
              padding: '8px 12px',
              'max-height': '220px',
              'overflow-y': 'auto',
              background: theme.bgInput,
              'border-radius': '8px',
              border: `1px solid ${theme.border}`,
              color: theme.fgMuted,
            }}
          >
            {output() || 'Pushing...'}
          </pre>
        </Show>
        <Show when={pushError()}>
          <InlineNotice tone="error" style={{ 'margin-top': '12px' }}>
            {pushError()}
          </InlineNotice>
        </Show>
      </div>
      <div
        style={{
          display: 'flex',
          gap: '8px',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <button
          type="button"
          class="btn-secondary"
          onClick={handleDialogClose}
          style={{
            padding: '9px 18px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: 'pointer',
            ...typography.uiStrong,
          }}
        >
          {pushing() ? 'Close' : 'Cancel'}
        </button>
        <Show when={!pushing()}>
          <button
            type="button"
            class="btn-primary"
            onClick={startPush}
            style={{
              padding: '9px 20px',
              background: theme.accent,
              border: 'none',
              'border-radius': '8px',
              color: theme.accentText,
              cursor: 'pointer',
              ...typography.uiStrong,
            }}
          >
            Push
          </button>
        </Show>
      </div>
    </Dialog>
  );
}
