import { For, Show, createSignal, type JSX } from 'solid-js';

import type { ReviewAnnotation } from '../app/review-session';
import { COPY_REVIEW_COMMENTS_LABEL } from '../lib/review-comment-actions';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { ReviewCommentEditor } from './ReviewCommentCard';

export interface ReviewSidebarProps {
  annotations: ReadonlyArray<ReviewAnnotation>;
  canSubmit: boolean;
  copyActionLabel?: string;
  onDismiss: (id: string) => void;
  onCopy?: () => void;
  onScrollTo: (annotation: ReviewAnnotation) => void;
  onUpdate: (id: string, comment: string) => void;
  onSubmit: () => void;
  submitActionLabel?: string;
  submitError?: string;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function ReviewSidebarAnnotationSummary(props: {
  annotation: ReviewAnnotation;
  compactPadding?: boolean;
}): JSX.Element {
  return (
    <>
      <div
        style={{
          color: theme.fgSubtle,
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
          'white-space': 'nowrap',
          'padding-right': props.compactPadding ? '16px' : '44px',
          ...typography.monoMeta,
        }}
      >
        {props.annotation.source}:{props.annotation.startLine}-{props.annotation.endLine}
      </div>

      <div
        style={{
          color: theme.fgMuted,
          'max-height': '2.4em',
          overflow: 'hidden',
          'margin-top': '2px',
          ...typography.monoMeta,
        }}
      >
        {truncate(props.annotation.selectedText, 120)}
      </div>
    </>
  );
}

interface ReviewCommentsToggleProps {
  count: number;
  onToggle: () => void;
  open: boolean;
}

export function ReviewCommentsToggle(props: ReviewCommentsToggleProps): JSX.Element {
  return (
    <Show when={props.count > 0}>
      <button
        onClick={() => props.onToggle()}
        style={{
          background: props.open ? theme.warning : 'transparent',
          color: props.open ? theme.accentText : theme.warning,
          border: `1px solid ${theme.warning}`,
          padding: '2px 10px',
          'border-radius': '4px',
          cursor: 'pointer',
          ...typography.metaStrong,
        }}
      >
        Comments ({props.count})
      </button>
    </Show>
  );
}

export function ReviewSidebar(props: ReviewSidebarProps): JSX.Element {
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [draftComment, setDraftComment] = createSignal('');

  function getSubmitActionLabel(): string {
    return props.submitActionLabel ?? 'Send to Agent';
  }

  function getTrimmedDraftComment(): string {
    return draftComment().trim();
  }

  function startEdit(annotation: ReviewAnnotation): void {
    setDraftComment(annotation.comment);
    setEditingId(annotation.id);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setDraftComment('');
  }

  function saveEdit(annotation: ReviewAnnotation): void {
    const nextComment = getTrimmedDraftComment();
    if (!nextComment) {
      return;
    }

    props.onUpdate(annotation.id, nextComment);
    cancelEdit();
  }

  return (
    <div
      style={{
        width: '300px',
        'min-width': '300px',
        'border-left': `1px solid ${theme.border}`,
        display: 'flex',
        'flex-direction': 'column',
        background: theme.bgElevated,
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          'border-bottom': `1px solid ${theme.border}`,
          color: theme.fg,
          ...typography.uiStrong,
        }}
      >
        Review Comments ({props.annotations.length})
      </div>

      <Show when={props.submitError}>
        <div
          style={{
            padding: '6px 12px',
            color: theme.error,
            'border-bottom': `1px solid ${theme.border}`,
            background: 'rgba(255, 95, 115, 0.08)',
            ...typography.meta,
          }}
        >
          {props.submitError}
        </div>
      </Show>

      <div
        style={{
          flex: '1',
          'overflow-y': 'auto',
          padding: '8px',
        }}
      >
        <For each={props.annotations}>
          {(annotation) => (
            <div
              onClick={() => props.onScrollTo(annotation)}
              style={{
                padding: '8px 10px',
                'margin-bottom': '6px',
                'border-left': `3px solid ${theme.warning}`,
                'border-radius': '0 4px 4px 0',
                background: 'rgba(255,255,255,0.03)',
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              <Show
                when={editingId() === annotation.id}
                fallback={
                  <>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        startEdit(annotation);
                      }}
                      style={{
                        position: 'absolute',
                        top: '4px',
                        right: '22px',
                        background: 'transparent',
                        border: 'none',
                        color: theme.fgSubtle,
                        cursor: 'pointer',
                        padding: '2px 4px',
                        'border-radius': '2px',
                        ...typography.metaStrong,
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onDismiss(annotation.id);
                      }}
                      style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        background: 'transparent',
                        border: 'none',
                        color: theme.fgSubtle,
                        cursor: 'pointer',
                        padding: '2px 4px',
                        'border-radius': '2px',
                        ...typography.metaStrong,
                      }}
                    >
                      &times;
                    </button>
                    <ReviewSidebarAnnotationSummary annotation={annotation} />
                    <div
                      style={{
                        color: theme.fg,
                        'white-space': 'pre-wrap',
                        'margin-top': '4px',
                        ...typography.meta,
                      }}
                    >
                      {annotation.comment}
                    </div>
                  </>
                }
              >
                <div onClick={(event) => event.stopPropagation()}>
                  <ReviewSidebarAnnotationSummary annotation={annotation} compactPadding />
                  <ReviewCommentEditor
                    comment={draftComment()}
                    onCancel={cancelEdit}
                    onChange={setDraftComment}
                    onSave={() => saveEdit(annotation)}
                    saveDisabled={getTrimmedDraftComment().length === 0}
                  />
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>

      <div
        style={{
          padding: '8px',
          'border-top': `1px solid ${theme.border}`,
          display: 'flex',
          gap: '8px',
        }}
      >
        <Show when={props.onCopy}>
          <button
            onClick={() => props.onCopy?.()}
            style={{
              background: 'transparent',
              color: theme.fg,
              border: `1px solid ${theme.border}`,
              padding: '8px 12px',
              'border-radius': '4px',
              cursor: 'pointer',
              'white-space': 'nowrap',
              ...typography.uiStrong,
            }}
          >
            {props.copyActionLabel ?? COPY_REVIEW_COMMENTS_LABEL}
          </button>
        </Show>
        <button
          onClick={() => props.onSubmit()}
          disabled={!props.canSubmit}
          style={{
            width: '100%',
            background: props.canSubmit ? theme.accent : theme.bgHover,
            color: props.canSubmit ? theme.accentText : theme.fgMuted,
            border: 'none',
            padding: '8px 16px',
            'border-radius': '4px',
            cursor: props.canSubmit ? 'pointer' : 'default',
            ...typography.uiStrong,
          }}
          title={props.canSubmit ? undefined : 'No agent available to receive review'}
        >
          {getSubmitActionLabel()} ({props.annotations.length})
        </button>
      </div>
    </div>
  );
}
