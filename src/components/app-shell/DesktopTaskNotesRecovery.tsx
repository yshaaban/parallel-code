import { For, createUniqueId, type JSX } from 'solid-js';

import {
  discardRecoveredDesktopTaskNotes,
  type DetachedDesktopTaskNotesDraft,
} from '../../app/task-notes-recovery-channel';
import { confirm } from '../../lib/dialog';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';

interface DesktopTaskNotesRecoveryProps {
  drafts: readonly DetachedDesktopTaskNotesDraft[];
}

export function DesktopTaskNotesRecovery(props: DesktopTaskNotesRecoveryProps): JSX.Element {
  const editors = new Map<string, HTMLTextAreaElement>();
  const descriptionId = createUniqueId();

  function selectDraft(taskId: string): void {
    const editor = editors.get(taskId);
    editor?.focus();
    editor?.select();
  }

  async function copyDraft(draft: DetachedDesktopTaskNotesDraft): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft.draft);
    } catch {
      selectDraft(draft.taskId);
    }
  }

  async function discardDraft(draft: DetachedDesktopTaskNotesDraft): Promise<void> {
    const approved = await confirm(
      `Discard the recovered notes draft for “${draft.taskName}”? This cannot be undone.`,
      {
        cancelLabel: 'Keep draft',
        kind: 'warning',
        okLabel: 'Discard draft',
        title: 'Discard recovered task notes?',
      },
    );
    if (!approved) return;
    discardRecoveredDesktopTaskNotes(draft.taskId);
  }

  return (
    <aside
      aria-label="Recovered task notes"
      style={{
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        width: 'min(420px, calc(100vw - 32px))',
        'max-height': 'min(70vh, 560px)',
        overflow: 'auto',
        display: 'grid',
        gap: '12px',
        padding: '14px',
        background: theme.bgElevated,
        border: `1px solid ${theme.warning}`,
        'border-radius': '10px',
        'box-shadow': '0 16px 42px rgba(0, 0, 0, 0.38)',
        'z-index': '10020',
      }}
    >
      <div id={descriptionId} role="alert" style={{ color: theme.warning, ...typography.uiStrong }}>
        A task was removed or replaced elsewhere. Its unsaved notes are preserved here for recovery.
      </div>
      <For each={props.drafts}>
        {(draft) => (
          <section aria-label={`Recovered notes for ${draft.taskName}`}>
            <label style={{ display: 'block', color: theme.fg, ...typography.uiStrong }}>
              {draft.taskName}
              <textarea
                aria-describedby={descriptionId}
                aria-label={`Recovered notes for ${draft.taskName}`}
                readOnly
                ref={(element) => editors.set(draft.taskId, element)}
                value={draft.draft}
                style={{
                  width: '100%',
                  'min-height': '110px',
                  'margin-top': '8px',
                  padding: '8px',
                  resize: 'vertical',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '6px',
                  color: theme.fg,
                  ...typography.monoUi,
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: '8px', 'margin-top': '8px', 'flex-wrap': 'wrap' }}>
              <button type="button" onClick={() => void copyDraft(draft)}>
                Copy draft
              </button>
              <button type="button" onClick={() => selectDraft(draft.taskId)}>
                Select all
              </button>
              <button type="button" onClick={() => void discardDraft(draft)}>
                Discard draft
              </button>
            </div>
          </section>
        )}
      </For>
    </aside>
  );
}
