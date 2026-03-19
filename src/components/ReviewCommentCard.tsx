import { Show, createSignal, type JSX } from 'solid-js';

import type { ReviewAnnotation } from '../app/review-session';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';

interface ReviewCommentCardProps {
  annotation: ReviewAnnotation;
  onDismiss: () => void;
  onUpdate: (id: string, comment: string) => void;
  overlay?: boolean;
}

interface ReviewCommentEditorProps {
  comment: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
  saveDisabled?: boolean;
}

function getLocationLabel(annotation: ReviewAnnotation): string {
  const sectionIndex = annotation.source.indexOf('\u00A7');
  if (sectionIndex !== -1) {
    return annotation.source.slice(sectionIndex + 1).trim();
  }

  if (annotation.startLine === annotation.endLine) {
    return `line ${annotation.startLine}`;
  }

  return `lines ${annotation.startLine}-${annotation.endLine}`;
}

export function ReviewCommentEditor(props: ReviewCommentEditorProps): JSX.Element {
  return (
    <div style={{ 'margin-top': '6px' }}>
      <textarea
        ref={(element) => requestAnimationFrame(() => element.focus())}
        value={props.comment}
        onInput={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onCancel();
            return;
          }

          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            props.onSave();
          }
        }}
        rows={3}
        style={{
          width: '100%',
          background: theme.bgInput,
          color: theme.fg,
          border: `1px solid ${theme.borderFocus}`,
          'border-radius': '4px',
          padding: '6px 8px',
          'font-family': "'JetBrains Mono', monospace",
          'font-size': sf(12),
          outline: 'none',
          resize: 'vertical',
          'min-height': '72px',
        }}
      />
      <div
        style={{
          display: 'flex',
          'justify-content': 'flex-end',
          gap: '6px',
          'margin-top': '6px',
        }}
      >
        <button
          onClick={() => props.onCancel()}
          style={{
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '4px 10px',
            'border-radius': '4px',
            'font-size': sf(11),
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => props.onSave()}
          disabled={props.saveDisabled}
          style={{
            background: theme.accent,
            border: 'none',
            color: props.saveDisabled ? theme.fgMuted : theme.accentText,
            cursor: props.saveDisabled ? 'default' : 'pointer',
            padding: '4px 10px',
            'border-radius': '4px',
            'font-size': sf(11),
            opacity: props.saveDisabled ? '0.5' : '1',
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function ReviewCommentCard(props: ReviewCommentCardProps): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [draftComment, setDraftComment] = createSignal('');

  function startEdit(): void {
    setDraftComment(props.annotation.comment);
    setEditing(true);
  }

  function cancelEdit(): void {
    setEditing(false);
    setDraftComment(props.annotation.comment);
  }

  function saveEdit(): void {
    const nextComment = draftComment().trim();
    if (!nextComment) {
      return;
    }

    props.onUpdate(props.annotation.id, nextComment);
    setEditing(false);
  }

  return (
    <div
      style={{
        margin: '4px 40px 4px 80px',
        'max-width': '560px',
        'border-left': `3px solid ${theme.warning}`,
        'border-radius': '0 4px 4px 0',
        background: props.overlay
          ? `color-mix(in srgb, ${theme.bgElevated} 88%, ${theme.warning} 12%)`
          : theme.bgElevated,
        'backdrop-filter': props.overlay ? 'blur(8px)' : undefined,
        padding: '8px 12px',
        'font-family': "'JetBrains Mono', monospace",
      }}
    >
      <Show
        when={!editing()}
        fallback={
          <ReviewCommentEditor
            comment={draftComment()}
            onCancel={cancelEdit}
            onChange={setDraftComment}
            onSave={saveEdit}
            saveDisabled={draftComment().trim().length === 0}
          />
        }
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            gap: '8px',
          }}
        >
          <span
            style={{
              'font-size': sf(11),
              color: props.overlay ? theme.fg : theme.warning,
            }}
          >
            Review · {getLocationLabel(props.annotation)}
          </span>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
            <button
              onClick={startEdit}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                padding: '2px 4px',
                'border-radius': '3px',
                'font-size': sf(11),
                'line-height': '1',
              }}
              title="Edit"
            >
              Edit
            </button>
            <button
              onClick={() => props.onDismiss()}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                padding: '2px 4px',
                'border-radius': '3px',
                'font-size': sf(14),
                'line-height': '1',
              }}
              title="Dismiss"
            >
              &times;
            </button>
          </div>
        </div>

        <div
          style={{
            color: theme.fg,
            'white-space': 'pre-wrap',
            'font-size': sf(12),
            'margin-top': '4px',
          }}
        >
          {props.annotation.comment}
        </div>
      </Show>
    </div>
  );
}
