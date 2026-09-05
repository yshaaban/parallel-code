import type { TaskNotesControllerSnapshot } from './task-notes-controller';
import type { TaskNotesEditorState } from './task-notes-draft';

export type TaskNotesStatusTone = 'muted' | 'progress' | 'success' | 'warning' | 'error';

export interface TaskNotesPresentation {
  canRetry: boolean;
  canSave: boolean;
  editable: boolean;
  message: string;
  tone: TaskNotesStatusTone;
}

function getErrorMessage(state: Extract<TaskNotesEditorState, { kind: 'error' }>): string {
  switch (state.reason) {
    case 'operation-counter-exhausted':
      return 'Task notes operation counter is exhausted. Copy the draft and reopen the editor.';
    case 'editor-generation-exhausted':
      return 'Task notes editor generation is exhausted.';
    case 'notes-unavailable':
      return 'Task notes are temporarily unavailable.';
    case 'invalid-draft':
      return 'Task notes exceed the supported UTF-8 byte limit or contain invalid Unicode.';
    case 'task-unavailable':
      return 'Task state is temporarily unavailable.';
    case 'terminal-facts-conflict':
      return 'Conflicting terminal facts were received for the same notes operation.';
    case 'save-identity-expired':
      return 'The save identity expired. Review current notes before saving again.';
    case 'request-failed':
      return `Task notes request failed (${state.requestCode}).`;
    case 'transport-interrupted':
      return 'Task notes transport was interrupted.';
  }
}

export function getTaskNotesPresentation(
  snapshot: TaskNotesControllerSnapshot,
): TaskNotesPresentation {
  const { state } = snapshot;
  switch (state.kind) {
    case 'loading':
      return {
        canRetry: false,
        canSave: false,
        editable: false,
        message: 'Loading…',
        tone: 'progress',
      };
    case 'clean':
      return { canRetry: false, canSave: false, editable: true, message: '', tone: 'muted' };
    case 'dirty':
      return {
        canRetry: false,
        canSave: true,
        editable: true,
        message: state.external ? 'Changed elsewhere' : 'Unsaved changes',
        tone: state.external ? 'warning' : 'muted',
      };
    case 'issuing':
      return {
        canRetry: state.issueStatus.kind !== 'requesting',
        canSave: false,
        editable: true,
        message: snapshot.slowSaving
          ? 'Still saving…'
          : state.issueStatus.kind === 'requesting'
            ? 'Preparing save…'
            : 'Securing save identity…',
        tone:
          snapshot.slowSaving || state.issueStatus.kind !== 'requesting' ? 'warning' : 'progress',
      };
    case 'saving':
      return {
        canRetry: false,
        canSave: false,
        editable: true,
        message: snapshot.slowSaving ? 'Still saving…' : 'Saving…',
        tone: snapshot.slowSaving ? 'warning' : 'progress',
      };
    case 'securing':
      return {
        canRetry: true,
        canSave: false,
        editable: true,
        message: 'Securing save…',
        tone: 'warning',
      };
    case 'recovering': {
      const recovery = state.pending.recovery;
      const message =
        recovery.kind === 'recovery-busy'
          ? 'Waiting for recovery slot…'
          : recovery.kind === 'task-state-unavailable'
            ? 'Refreshing task state…'
            : recovery.kind === 'host-state-recovery'
              ? 'Host recovery required…'
              : recovery.kind === 'awaiting-coherent-current'
                ? 'Save completed—verifying current…'
                : 'Recovering save…';
      return { canRetry: true, canSave: false, editable: true, message, tone: 'warning' };
    }
    case 'saved':
      return {
        canRetry: false,
        canSave: false,
        editable: true,
        message: state.postCommitWarning
          ? 'Saved; task view may need repair'
          : snapshot.savedNoticeVisible
            ? 'Saved'
            : '',
        tone: state.postCommitWarning ? 'warning' : 'success',
      };
    case 'conflict':
      return {
        canRetry: false,
        canSave: false,
        editable: true,
        message: 'Notes changed on another device',
        tone: 'error',
      };
    case 'error':
      return {
        canRetry: state.recovery !== 'none',
        canSave: false,
        editable: true,
        message: getErrorMessage(state),
        tone: 'error',
      };
    case 'closing':
      return {
        canRetry: false,
        canSave: false,
        editable: false,
        message: 'Task is closing—copy your draft',
        tone: 'error',
      };
    case 'orphaned':
      return {
        canRetry: false,
        canSave: false,
        editable: false,
        message:
          state.reason === 'task-deleted'
            ? 'Task was deleted—copy your draft'
            : state.reason === 'task-replaced'
              ? 'Task was replaced—copy your draft'
              : 'Task is no longer visible—copy your draft',
        tone: 'error',
      };
  }
}
