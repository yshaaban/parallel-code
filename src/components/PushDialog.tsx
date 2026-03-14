import { Show, createEffect, createSignal } from 'solid-js';
import { pushTask } from '../store/store';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';
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
      <h2
        style={{
          margin: '0',
          'font-size': '16px',
          color: theme.fg,
          'font-weight': '600',
        }}
      >
        Push to Remote
      </h2>
      <div style={{ 'font-size': '13px', color: theme.fgMuted, 'line-height': '1.5' }}>
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
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '11px',
              'line-height': '1.5',
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
            'font-size': '13px',
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
              'font-size': '13px',
              'font-weight': '500',
            }}
          >
            Push
          </button>
        </Show>
      </div>
    </Dialog>
  );
}
