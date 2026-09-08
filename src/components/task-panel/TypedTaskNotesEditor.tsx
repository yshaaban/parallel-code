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
  let focusAfterReload: typeof controller;

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
    focusAfterReload = undefined;
    setSnapshot(undefined);
    let active = true;
    let previousDraft: string | undefined;
    let previousKind: TaskNotesControllerSnapshot['state']['kind'] | undefined;
    props.onDraftChange('');
    // Controller snapshots are the external reactive source for this adapter.
    // eslint-disable-next-line solid/reactivity
    const unsubscribe = mounted.controller.subscribe((next) => {
      if (!active || next.state.taskId !== taskId) return;
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
      active = false;
      clearAutosave();
      unsubscribe();
      mounted.release();
      if (controller === mounted.controller) controller = undefined;
    });
  });

  createEffect(() => {
    const kind = snapshot()?.state.kind;
    if (!focusAfterReload || !kind || kind === 'loading') return;
    const expectedController = focusAfterReload;
    focusAfterReload = undefined;
    queueMicrotask(() => {
      if (controller === expectedController && textarea?.isConnected) textarea.focus();
    });
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
    const copiedController = controller;
    try {
      await navigator.clipboard.writeText(draft);
    } catch {
      if (
        copiedController === controller &&
        snapshot()?.state.draft === draft &&
        textarea?.isConnected
      )
        selectDraft();
    }
  }

  function discardReplacedDraft(): void {
    if (!window.confirm('Discard the recovered draft and load notes for the current task?')) return;
    focusAfterReload = controller;
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
        onInput={(event) => {
          if (!isReadOnly()) controller?.edit(event.currentTarget.value);
        }}
        placeholder="Notes..."
        style={{
          width: '100%',
          flex: '1',
          background: theme.taskPanelBg,
          border: 'none',
          padding: '6px 34px 30px 8px',
          'min-height': '0',
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
                padding: status().message || isReadOnly() ? '0 38px 6px 8px' : '0',
                display: 'flex',
                'align-items': 'center',
                'flex-wrap': 'wrap',
                gap: '4px',
                'max-height': '64px',
                'flex-shrink': '0',
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
                {status().message || (!props.capability.write ? 'Read-only in this session' : '')}
              </span>
              <Show when={status().canRetry && props.capability.write}>
                <button type="button" class="compact-action" onClick={() => controller?.retry()}>
                  Retry
                </button>
              </Show>
              <Show when={current().state.kind === 'conflict'}>
                <button
                  type="button"
                  class="compact-action"
                  onClick={() => controller?.useLatest()}
                >
                  Use latest
                </button>
                <button
                  type="button"
                  class="compact-action"
                  disabled={isReadOnly()}
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
              <Show when={isReadOnly() && current().state.draft.length > 0}>
                <button
                  type="button"
                  class="compact-action"
                  aria-label="Copy draft"
                  onClick={() => void copyDraft()}
                >
                  Copy
                </button>
                <button type="button" class="compact-action" onClick={selectDraft}>
                  Select all
                </button>
              </Show>
              <Show when={isRecoveryReadOnly() || (!props.capability.write && status().canRetry)}>
                <button
                  type="button"
                  class="compact-action"
                  onClick={() => controller?.checkStatus()}
                >
                  Check status
                </button>
              </Show>
              <Show when={isReplacement()}>
                <button type="button" class="compact-action" onClick={discardReplacedDraft}>
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
