import { Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from 'solid-js';
import { pushTask } from '../app/task-workflows';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { InlineNotice } from './InlineNotice';
import { createAnimationFrameTask } from '../lib/animation-frame-task';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { Task } from '../store/types';

export interface PushDialogRun {
  branchName: string;
  taskId: string;
}

interface ActivePushDialogRun extends PushDialogRun {
  generation: number;
}

interface PushDialogProps {
  open: boolean;
  task: Task;
  onStart: (run: PushDialogRun) => void;
  onClose: () => void;
  onDone: (success: boolean, run?: PushDialogRun) => void;
}

export function PushDialog(props: PushDialogProps): JSX.Element {
  const titleId = createUniqueId();
  const [pushError, setPushError] = createSignal('');
  const [pushing, setPushing] = createSignal(false);
  const [output, setOutput] = createSignal('');
  let outputRef: HTMLPreElement | undefined;
  let pushGeneration = 0;
  const outputScrollFrame = createAnimationFrameTask();

  onCleanup(outputScrollFrame.cancel);

  createEffect(() => {
    if (!props.open) {
      outputScrollFrame.cancel();
      return;
    }

    if (!pushing()) {
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

  function finishPushRun(run: ActivePushDialogRun, success: boolean): void {
    if (run.generation !== pushGeneration) {
      return;
    }

    setPushing(false);
    props.onDone(success, {
      branchName: run.branchName,
      taskId: run.taskId,
    });
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
    outputScrollFrame.schedule(() => {
      if (outputRef?.isConnected) {
        outputRef.scrollTop = outputRef.scrollHeight;
      }
    });
  }

  function startPush(): void {
    const run = {
      branchName: props.task.branchName,
      generation: pushGeneration + 1,
      taskId: props.task.id,
    };
    pushGeneration = run.generation;

    resetDialogState();
    setPushing(true);
    props.onStart(run);

    void runPush(run);
  }

  async function runPush(run: ActivePushDialogRun): Promise<void> {
    try {
      await pushTask(run.taskId, appendOutput);
      finishPushRun(run, true);
    } catch (error) {
      setPushError(String(error));
      finishPushRun(run, false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={handleDialogClose}
      width="480px"
      labelledBy={titleId}
      panelStyle={{ padding: '20px', gap: '12px' }}
    >
      <DialogHeader title="Push to Remote" titleId={titleId} />
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
              'overflow-wrap': 'anywhere',
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
