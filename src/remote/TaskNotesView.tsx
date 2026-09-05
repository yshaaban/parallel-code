import {
  Show,
  Suspense,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from 'solid-js';
import { getWellFormedUtf8ByteLength, TASK_NOTES_MAX_BYTES } from '../domain/task-notes';
import type {
  TaskNotesController,
  TaskNotesControllerSnapshot,
} from '../components/task-notes/task-notes-controller';
import { lazyNamed } from '../lib/lazy-named';
import {
  applyRemoteTaskNotesCatalogLifecycle,
  confirmRemoteTaskNotesLeave as confirmRemoteTaskNotesLeaveNow,
  mountRemoteTaskNotes,
  registerRemoteTaskNotesNavigation,
  type RemoteTaskNotesCatalogLifecycle,
} from './task-notes-runtime';

type MountTaskNotes = (taskId: string) => {
  controller: TaskNotesController;
  release: () => void;
};

export async function confirmRemoteTaskNotesLeave(
  taskId: string,
  message: string,
  confirm: (message: string) => boolean,
): Promise<boolean> {
  return confirmRemoteTaskNotesLeaveNow(taskId, message, confirm);
}

const TaskNotesRecoveryView = lazyNamed(
  () => import('./TaskNotesRecoveryView'),
  'TaskNotesRecoveryView',
);

interface TaskNotesViewProps {
  canWrite?: boolean;
  confirm?: (message: string) => boolean;
  mount?: MountTaskNotes;
  lifecycle?: RemoteTaskNotesCatalogLifecycle | null;
  onChooseAnotherTask: () => void;
  taskId: string;
  taskName: string;
}

function getBasicStatus(snapshot: TaskNotesControllerSnapshot): string | null {
  const { state } = snapshot;
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'clean':
      return '';
    case 'dirty':
      return state.external ? null : 'Unsaved changes';
    default:
      return null;
  }
}

export function TaskNotesView(props: TaskNotesViewProps): JSX.Element {
  const [controller, setController] = createSignal<TaskNotesController>();
  const [snapshot, setSnapshot] = createSignal<TaskNotesControllerSnapshot>();
  const [draftByteLength, setDraftByteLength] = createSignal<number | null>(0);
  const editorId = createUniqueId();
  const statusId = createUniqueId();
  const byteCountId = createUniqueId();
  let textarea: HTMLTextAreaElement | undefined;
  let focusAfterReload = false;

  createEffect(() => {
    const taskId = props.taskId;
    const injectedMount = props.mount;
    const onChooseAnotherTask = props.onChooseAnotherTask;
    const mounted = (injectedMount ?? mountRemoteTaskNotes)(taskId);
    setController(mounted.controller);
    const unsubscribe = mounted.controller.subscribe(setSnapshot);
    const unregister = injectedMount
      ? undefined
      : registerRemoteTaskNotesNavigation(taskId, onChooseAnotherTask);
    onCleanup(() => {
      unregister?.();
      unsubscribe();
      mounted.release();
      setController(undefined);
      setSnapshot(undefined);
    });
  });

  createEffect(() => {
    const kind = snapshot()?.state.kind;
    if (!focusAfterReload || !kind || kind === 'loading') return;
    focusAfterReload = false;
    queueMicrotask(() => textarea?.focus());
  });

  createEffect(() => {
    const lifecycle = props.lifecycle;
    const activeController = controller();
    if (!lifecycle || props.mount || activeController?.taskId !== props.taskId) return;
    const taskId = props.taskId;
    applyRemoteTaskNotesCatalogLifecycle(taskId, lifecycle);
  });

  const basicStatus = () => {
    const value = snapshot();
    const status = value ? getBasicStatus(value) : null;
    if (value && props.canWrite === false && value.state.kind !== 'loading' && status !== null) {
      return 'Notes are read-only in this session. You can select and copy them.';
    }
    return status;
  };
  const draft = () => snapshot()?.state.draft ?? '';
  createEffect(() => {
    const value = draft();
    const frame = requestAnimationFrame(() =>
      setDraftByteLength(getWellFormedUtf8ByteLength(value)),
    );
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const remainingBytes = () => {
    const length = draftByteLength();
    return length === null ? null : TASK_NOTES_MAX_BYTES - length;
  };
  const recoverySnapshot = () => {
    const currentSnapshot = snapshot();
    return currentSnapshot && getBasicStatus(currentSnapshot) === null
      ? currentSnapshot
      : undefined;
  };
  const isLoading = () => !snapshot() || snapshot()?.state.kind === 'loading';
  const isRecoveryReadOnly = () => {
    const kind = snapshot()?.state.kind;
    return kind === 'closing' || kind === 'orphaned';
  };
  const isReadOnly = () => props.canWrite === false || isRecoveryReadOnly();
  const invalidDraft = () => remainingBytes() === null || (remainingBytes() ?? 0) < 0;
  const editorDescription = () => {
    const ids: string[] = [];
    if (basicStatus() !== null || recoverySnapshot()) ids.push(statusId);
    if ((remainingBytes() ?? -1) <= 10 * 1024) ids.push(byteCountId);
    return ids.length > 0 ? ids.join(' ') : undefined;
  };

  return (
    <section aria-label={`Notes for ${props.taskName}`} class="task-notes">
      <label class="task-notes__label" for={editorId}>
        Task notes
      </label>
      <textarea
        aria-describedby={editorDescription()}
        aria-invalid={invalidDraft()}
        aria-readonly={isReadOnly()}
        id={editorId}
        ref={textarea}
        value={draft()}
        disabled={isLoading()}
        readOnly={isReadOnly()}
        onInput={(event) => controller()?.edit(event.currentTarget.value)}
        placeholder="Add context, reminders, or a handoff…"
        class="task-notes__editor"
      />

      <Show when={basicStatus() !== null}>
        <div
          aria-live="polite"
          class="task-notes__status"
          data-tone={snapshot()?.state.kind === 'loading' ? 'progress' : 'muted'}
          id={statusId}
          role="status"
        >
          {basicStatus()}
        </div>
      </Show>

      <Show when={(remainingBytes() ?? -1) <= 10 * 1024}>
        <div class="task-notes__byte-count" data-invalid={invalidDraft()} id={byteCountId}>
          {remainingBytes() === null
            ? 'Draft contains invalid Unicode.'
            : `${draftByteLength()?.toLocaleString()} / 102,400 bytes`}
        </div>
      </Show>

      <div class="task-notes__actions">
        <button
          type="button"
          class="task-notes__button"
          disabled={
            snapshot()?.state.kind !== 'dirty' ||
            props.canWrite === false ||
            (remainingBytes() ?? -1) < 0
          }
          onClick={() => controller()?.save()}
        >
          Save
        </button>
      </div>

      <Show when={recoverySnapshot()}>
        {(current) => (
          <Show when={controller()}>
            {(activeController) => (
              <Suspense
                fallback={
                  <div class="task-notes__status" id={statusId}>
                    Loading recovery actions…
                  </div>
                }
              >
                <TaskNotesRecoveryView
                  confirm={props.confirm}
                  controller={activeController()}
                  draft={draft()}
                  editor={textarea}
                  onChooseAnotherTask={props.onChooseAnotherTask}
                  onReloadCurrentTask={() => {
                    focusAfterReload = true;
                    activeController().discard();
                  }}
                  snapshot={current()}
                  statusId={statusId}
                />
              </Suspense>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
}
