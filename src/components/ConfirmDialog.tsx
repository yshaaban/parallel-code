import { Show, createEffect, createUniqueId, onCleanup, untrack, type JSX } from 'solid-js';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { createAnimationFrameTask } from '../lib/animation-frame-task';
import { typography } from '../lib/typography';
import { theme } from '../lib/theme';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmLoading?: boolean;
  danger?: boolean;
  confirmDisabled?: boolean;
  autoFocusCancel?: boolean;
  width?: string;
  labelledBy?: string;
  describedBy?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  let cancelRef: HTMLButtonElement | undefined;
  let confirmRef: HTMLButtonElement | undefined;
  const generatedTitleId = createUniqueId();
  const focusFrame = createAnimationFrameTask();

  function isConfirmUnavailable(): boolean {
    return Boolean(props.confirmDisabled || props.confirmLoading);
  }

  function shouldFocusCancelButton(): boolean {
    if (props.danger || isConfirmUnavailable()) {
      return true;
    }

    return props.autoFocusCancel ?? false;
  }

  createEffect(() => {
    if (!props.open) {
      focusFrame.cancel();
      return;
    }

    untrack(() => {
      const focusCancelButton = shouldFocusCancelButton();

      // Blur whatever is focused outside the dialog (e.g. the button that
      // triggered this dialog) so our programmatic focus call sticks.
      (document.activeElement as HTMLElement)?.blur?.();

      // Focus the chosen action after the Dialog panel renders.
      focusFrame.schedule(() => {
        const target = focusCancelButton ? cancelRef : confirmRef;
        if (!target?.isConnected) {
          return;
        }

        target.focus();
      });
    });
  });

  onCleanup(focusFrame.cancel);

  return (
    <Dialog
      open={props.open}
      onClose={props.onCancel}
      width={props.width}
      labelledBy={props.labelledBy ?? generatedTitleId}
      describedBy={props.describedBy}
      panelStyle={{ padding: '20px' }}
    >
      <DialogHeader title={props.title} titleId={props.labelledBy ? undefined : generatedTitleId} />

      <div style={{ ...typography.ui, color: theme.fgMuted }}>{props.message}</div>

      <div
        style={{
          display: 'flex',
          gap: '8px',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <button
          ref={cancelRef}
          type="button"
          class="btn-secondary"
          onClick={() => props.onCancel()}
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
          {props.cancelLabel ?? 'Cancel'}
        </button>
        <button
          ref={confirmRef}
          type="button"
          class={props.danger ? 'btn-danger' : 'btn-primary'}
          disabled={isConfirmUnavailable()}
          onClick={() => props.onConfirm()}
          style={{
            padding: '9px 20px',
            background: props.danger ? theme.error : theme.accent,
            border: 'none',
            'border-radius': '8px',
            color: props.danger ? theme.errorText : theme.accentText,
            cursor: isConfirmUnavailable() ? 'not-allowed' : 'pointer',
            ...typography.uiStrong,
            opacity: isConfirmUnavailable() ? '0.5' : '1',
            display: 'inline-flex',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <Show when={props.confirmLoading}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
          {props.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </Dialog>
  );
}
