import { Show, createEffect, createMemo, createSignal, createUniqueId, type JSX } from 'solid-js';

import type {
  TaskNotesController,
  TaskNotesControllerSnapshot,
} from '../components/task-notes/task-notes-controller';
import { getTaskNotesPresentation } from '../components/task-notes/task-notes-presentation';

interface TaskNotesRecoveryViewProps {
  confirm?: (message: string) => boolean;
  controller: TaskNotesController;
  draft: string;
  editor: HTMLTextAreaElement | undefined;
  onChooseAnotherTask: () => void;
  onReloadCurrentTask: () => void;
  snapshot: TaskNotesControllerSnapshot;
  statusId: string;
}

export function TaskNotesRecoveryView(props: TaskNotesRecoveryViewProps): JSX.Element {
  const [reviewingLatest, setReviewingLatest] = createSignal(false);
  const latestContentId = createUniqueId();
  const latestHeadingId = createUniqueId();
  let latestHeading: HTMLHeadingElement | undefined;
  let latestFocused = false;
  const presentation = createMemo(() => getTaskNotesPresentation(props.snapshot));
  const latest = createMemo(() => {
    const state = props.snapshot.state;
    const conflict = state.kind === 'conflict' ? state.current : undefined;
    const external = 'external' in state ? state.external : undefined;
    if (!conflict) return external?.notes;
    if (!external) return conflict.notes;
    return external.workspaceRevision > conflict.workspaceRevision
      ? external.notes
      : conflict.notes;
  });
  const confirmAction = (message: string) =>
    props.confirm ? props.confirm(message) : window.confirm(message);

  createEffect(() => {
    if (latest() === undefined) {
      latestFocused = false;
      return;
    }
    if (latestFocused) return;
    latestFocused = true;
    queueMicrotask(() => latestHeading?.focus());
  });

  function selectDraft(): void {
    props.editor?.focus();
    props.editor?.select();
  }

  async function copyDraft(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.draft);
    } catch {
      selectDraft();
    }
  }

  function useLatest(): void {
    const current = latest();
    if (
      current === undefined ||
      (props.draft !== current &&
        !confirmAction('Discard your draft and use the latest saved notes?'))
    ) {
      return;
    }
    props.controller.useLatest();
    setReviewingLatest(false);
    const editor = props.editor;
    queueMicrotask(() => editor?.focus());
  }

  function overwrite(): void {
    if (
      !confirmAction('Overwrite the latest saved notes with your draft?') ||
      !confirmAction('This cannot be undone. Save your draft over the latest notes?')
    ) {
      return;
    }
    props.controller.overwrite();
    setReviewingLatest(false);
  }

  function discardReplacedDraft(): void {
    if (!confirmAction('Discard the recovered draft and load notes for the current task?')) return;
    props.onReloadCurrentTask();
  }

  return (
    <>
      <div
        aria-live={presentation().tone === 'error' ? 'assertive' : 'polite'}
        class="task-notes__status"
        data-tone={presentation().tone}
        id={props.statusId}
        role={presentation().tone === 'error' ? 'alert' : 'status'}
      >
        {presentation().message}
      </div>

      <Show when={presentation().canRetry}>
        <button class="task-notes__button" type="button" onClick={() => props.controller.retry()}>
          Retry
        </button>
      </Show>

      <Show
        when={props.snapshot.state.kind === 'closing' || props.snapshot.state.kind === 'orphaned'}
      >
        <div class="task-notes__actions">
          <button class="task-notes__button" type="button" onClick={() => void copyDraft()}>
            Copy draft
          </button>
          <button class="task-notes__button" type="button" onClick={selectDraft}>
            Select all
          </button>
          <button
            class="task-notes__button"
            type="button"
            onClick={() => props.controller.checkStatus()}
          >
            Check status
          </button>
          <button
            class="task-notes__button"
            type="button"
            onClick={() => props.onChooseAnotherTask()}
          >
            Choose another task
          </button>
          <Show
            when={
              props.snapshot.state.kind === 'orphaned' &&
              props.snapshot.state.reason === 'task-replaced'
            }
          >
            <button class="task-notes__button" type="button" onClick={discardReplacedDraft}>
              Discard draft and reload
            </button>
          </Show>
        </div>
      </Show>

      <Show when={latest() !== undefined}>
        <aside aria-labelledby={latestHeadingId} class="task-notes__latest">
          <h3 id={latestHeadingId} ref={latestHeading} tabindex="-1">
            Notes changed elsewhere
          </h3>
          <button
            aria-controls={latestContentId}
            aria-expanded={reviewingLatest()}
            class="task-notes__button"
            type="button"
            onClick={() => setReviewingLatest((value) => !value)}
          >
            {reviewingLatest() ? 'Hide latest' : 'Review latest'}
          </button>
          <Show when={reviewingLatest()}>
            <pre
              aria-label="Latest saved task notes"
              class="task-notes__latest-content"
              id={latestContentId}
              tabindex="0"
            >
              {latest()}
            </pre>
            <div class="task-notes__actions">
              <button class="task-notes__button" type="button" onClick={useLatest}>
                Use latest
              </button>
              <Show when={props.snapshot.state.kind === 'conflict'}>
                <button class="task-notes__button" type="button" onClick={overwrite}>
                  Overwrite with draft
                </button>
              </Show>
            </div>
          </Show>
        </aside>
      </Show>
    </>
  );
}
