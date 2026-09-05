import { Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from 'solid-js';

import type { TaskNotesCapability } from '../../app/task-notes-capability';
import { mountDesktopTaskNotes } from '../../app/task-notes-runtime';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import type { TaskNotesControllerSnapshot } from '../task-notes/task-notes-controller';
import { getTaskNotesPresentation } from '../task-notes/task-notes-presentation';

interface TypedTaskNotesEditorProps {
  capability: TaskNotesCapability;
  mountTaskNotes?: typeof mountDesktopTaskNotes;
  onDraftChange: (draft: string) => void;
  setNotesRef: (element: HTMLTextAreaElement | undefined) => void;
  taskId: string;
  taskName?: string;
}

export function TypedTaskNotesEditor(props: TypedTaskNotesEditorProps): JSX.Element {
  const [snapshot, setSnapshot] = createSignal<TaskNotesControllerSnapshot>();
  const statusId = createUniqueId();
  let controller: ReturnType<typeof mountDesktopTaskNotes>['controller'] | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let textarea: HTMLTextAreaElement | undefined;
  let focusAfterReload = false;

  function clearAutosave(): void {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  function scheduleAutosave(canWrite: boolean): void {
    clearAutosave();
    if (!canWrite || !controller) return;
    const scheduledController = controller;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (scheduledController === controller && snapshot()?.state.kind === 'dirty') {
        scheduledController.save();
      }
    }, 1_000);
  }

  createEffect(() => {
    const taskId = props.taskId;
    const mount = props.mountTaskNotes ?? mountDesktopTaskNotes;
    const canWrite = props.capability.write;
    const mounted = mount(taskId, props.taskName);
    controller = mounted.controller;
    let previousDraft: string | undefined;
    let previousKind: TaskNotesControllerSnapshot['state']['kind'] | undefined;
    props.onDraftChange('');
    // Controller snapshots are the external reactive source for this adapter.
    // eslint-disable-next-line solid/reactivity
    const unsubscribe = mounted.controller.subscribe((next) => {
      setSnapshot(next);
      props.onDraftChange(next.state.draft);
      if (
        next.state.kind === 'dirty' &&
        (previousKind !== 'dirty' || previousDraft !== next.state.draft)
      ) {
        scheduleAutosave(canWrite);
      } else if (next.state.kind !== 'dirty') {
        clearAutosave();
      }
      previousKind = next.state.kind;
      previousDraft = next.state.draft;
    });

    onCleanup(() => {
      clearAutosave();
      unsubscribe();
      mounted.release();
      if (controller === mounted.controller) controller = undefined;
    });
  });

  createEffect(() => {
    const kind = snapshot()?.state.kind;
    if (!focusAfterReload || !kind || kind === 'loading') return;
    focusAfterReload = false;
    queueMicrotask(() => textarea?.focus());
  });

  onCleanup(() => props.setNotesRef(undefined));

  const isLoading = () => !snapshot() || snapshot()?.state.kind === 'loading';
  const isRecoveryReadOnly = () => {
    const kind = snapshot()?.state.kind;
    return kind === 'closing' || kind === 'orphaned';
  };
  const isReadOnly = () => !props.capability.write || isRecoveryReadOnly();

  function selectDraft(): void {
    textarea?.focus();
    textarea?.select();
  }

  async function copyDraft(): Promise<void> {
    const draft = snapshot()?.state.draft ?? '';
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      selectDraft();
    }
  }

  function discardReplacedDraft(): void {
    if (!window.confirm('Discard the recovered draft and load notes for the current task?')) return;
    focusAfterReload = true;
    controller?.discard();
  }

  return (
    <>
      <textarea
        aria-label="Task notes"
        aria-describedby={snapshot() ? statusId : undefined}
        aria-readonly={isReadOnly()}
        ref={(element) => {
          textarea = element;
          props.setNotesRef(element);
        }}
        value={snapshot()?.state.draft ?? ''}
        disabled={isLoading()}
        readOnly={isReadOnly()}
        onInput={(event) => controller?.edit(event.currentTarget.value)}
        placeholder="Notes..."
        style={{
          width: '100%',
          flex: '1',
          background: theme.taskPanelBg,
          border: 'none',
          padding: '6px 34px 64px 8px',
          color: theme.fg,
          resize: 'none',
          ...typography.monoUi,
        }}
      />
      <Show when={snapshot()}>
        {(current) => {
          const status = () => getTaskNotesPresentation(current());
          const isReplacement = () => {
            const state = current().state;
            return state.kind === 'orphaned' && state.reason === 'task-replaced';
          };
          return (
            <div
              aria-live="polite"
              id={statusId}
              role="status"
              style={{
                position: 'absolute',
                left: '8px',
                right: '38px',
                bottom: '6px',
                display: 'flex',
                'align-items': 'center',
                'flex-wrap': 'wrap',
                gap: '4px',
                'max-height': '52px',
                overflow: 'auto',
                color:
                  status().tone === 'error'
                    ? theme.error
                    : status().tone === 'warning'
                      ? theme.warning
                      : theme.fgMuted,
                ...typography.monoMeta,
              }}
            >
              <span>
                {props.capability.write || !status().editable
                  ? status().message
                  : 'Notes are read-only in this session. You can select and copy them.'}
              </span>
              <Show when={status().canRetry}>
                <button type="button" onClick={() => controller?.retry()}>
                  Retry
                </button>
              </Show>
              <Show when={current().state.kind === 'conflict'}>
                <button type="button" onClick={() => controller?.useLatest()}>
                  Use latest
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm('Overwrite the latest notes with this draft?') &&
                      window.confirm('This cannot be undone. Continue?')
                    ) {
                      controller?.overwrite();
                    }
                  }}
                >
                  Overwrite
                </button>
              </Show>
              <Show when={isReadOnly()}>
                <button type="button" onClick={() => void copyDraft()}>
                  Copy draft
                </button>
                <button type="button" onClick={selectDraft}>
                  Select all
                </button>
                <Show when={isRecoveryReadOnly()}>
                  <button type="button" onClick={() => controller?.checkStatus()}>
                    Check status
                  </button>
                </Show>
              </Show>
              <Show when={isReplacement()}>
                <button type="button" onClick={discardReplacedDraft}>
                  Discard draft and reload
                </button>
              </Show>
            </div>
          );
        }}
      </Show>
    </>
  );
}
