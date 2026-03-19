import { For, Show, createEffect, createSignal, type JSX } from 'solid-js';

import { startAskAboutCodeSession } from '../app/task-ai-workflows';
import { createDialogScroll } from '../lib/dialog-scroll';
import { sf } from '../lib/fontScale';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import { getPlanSelection } from '../lib/plan-selection';
import { compilePlanReviewPrompt } from '../lib/review-prompts';
import { theme } from '../lib/theme';
import { AskCodeCard } from './AskCodeCard';
import { Dialog } from './Dialog';
import { InlineInput } from './InlineInput';
import { ReviewCommentCard } from './ReviewCommentCard';
import { ReviewCommentsToggle, ReviewSidebar } from './ReviewSidebar';
import { createReviewSurfaceSession } from './review-surface-session';

interface PlanViewerDialogProps {
  open: boolean;
  onClose: () => void;
  planContent: string;
  planFileName?: string;
  taskId?: string;
  agentId?: string;
  worktreePath?: string;
}

interface HighlightRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

function getPlanSource(planFileName: string | undefined): string {
  return planFileName ?? 'Plan';
}

export function PlanViewerDialog(props: PlanViewerDialogProps): JSX.Element {
  const planHtml = createHighlightedMarkdown(() => props.planContent);
  const { reviewCommentCopyController, reviewSession, reviewSidebarProps } =
    createReviewSurfaceSession({
      compilePrompt: compilePlanReviewPrompt,
      getAgentId: () => props.agentId,
      getTaskId: () => props.taskId,
      onSubmitted: () => props.onClose(),
    });
  const [cardOffsets, setCardOffsets] = createSignal<Record<string, number>>({});
  const [highlightRects, setHighlightRects] = createSignal<HighlightRect[]>([]);
  const [selectionY, setSelectionY] = createSignal(0);
  let contentRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;

  function resetTransientState(): void {
    reviewSession.reset();
    reviewCommentCopyController.resetCopyActionLabel();
    setHighlightRects([]);
    setCardOffsets({});
    setSelectionY(0);
  }

  createDialogScroll({
    enabled: () => props.open,
    getElement: () => scrollRef,
  });

  createEffect(() => {
    if (props.open) {
      return;
    }

    resetTransientState();
  });

  createEffect(() => {
    if (reviewSession.pendingSelection()) {
      return;
    }

    setHighlightRects([]);
  });

  createEffect(() => {
    const target = reviewSession.scrollTarget();
    if (!target || !scrollRef) {
      return;
    }

    const offset = cardOffsets()[target.id];
    if (offset === undefined) {
      return;
    }

    scrollRef.scrollTo({
      top: Math.max(0, offset - 100),
      behavior: 'smooth',
    });
    reviewSession.setScrollTarget(null);
  });

  function closeDialog(): void {
    resetTransientState();
    props.onClose();
  }

  function captureSelectionGeometry(): { rects: HighlightRect[]; y: number } {
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0 || !contentRef) {
      return { rects: [], y: 0 };
    }

    const range = domSelection.getRangeAt(0);
    const containerRect = contentRef.getBoundingClientRect();
    const rangeRect = range.getBoundingClientRect();
    const rects: HighlightRect[] = [];

    for (const clientRect of Array.from(range.getClientRects())) {
      rects.push({
        top: clientRect.top - containerRect.top,
        left: clientRect.left - containerRect.left,
        width: clientRect.width,
        height: clientRect.height,
      });
    }

    return {
      y: rangeRect.bottom - containerRect.top,
      rects,
    };
  }

  function handleMouseUp(): void {
    if (!contentRef) {
      return;
    }

    const source = getPlanSource(props.planFileName);
    const selection = getPlanSelection(contentRef, source);
    if (!selection) {
      return;
    }

    const geometry = captureSelectionGeometry();
    const selectionSource = selection.nearestHeading
      ? `${source} § ${selection.nearestHeading}`
      : source;

    setSelectionY(geometry.y);
    setHighlightRects(geometry.rects);
    reviewSession.handleSelection({
      source: selectionSource,
      startLine: selection.startLine,
      endLine: selection.endLine,
      selectedText: selection.selectedText,
      afterLine: selection.endLine,
    });
    window.getSelection()?.removeAllRanges();
  }

  function dismissInlineInput(): void {
    reviewSession.clearPendingSelection();
    setHighlightRects([]);
  }

  function submitInlineInput(text: string, mode: 'review' | 'ask'): void {
    const shouldRestoreScroll = mode === 'review' && !reviewSession.sidebarOpen();
    const savedScrollTop = shouldRestoreScroll ? (scrollRef?.scrollTop ?? null) : null;
    const id = reviewSession.submitSelection(text, mode);
    if (id) {
      setCardOffsets((current) => ({
        ...current,
        [id]: selectionY(),
      }));
    }
    setHighlightRects([]);
    if (savedScrollTop === null) {
      return;
    }

    requestAnimationFrame(() => {
      if (scrollRef) {
        scrollRef.scrollTop = savedScrollTop;
      }
    });
  }

  return (
    <Dialog
      open={props.open}
      onClose={closeDialog}
      width="min(1000px, 86vw)"
      panelStyle={{
        height: '78vh',
        'max-width': '1200px',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <Show when={props.open}>
        <>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
              padding: '12px 20px',
              'border-bottom': `1px solid ${theme.border}`,
              'flex-shrink': '0',
            }}
          >
            <span
              style={{
                'font-size': sf(13),
                color: theme.fg,
                'font-weight': '600',
                'font-family': "'JetBrains Mono', monospace",
              }}
            >
              {props.planFileName ?? 'Plan'}
            </span>

            <ReviewCommentsToggle
              count={reviewSession.annotations().length}
              onToggle={() => reviewSession.setSidebarOpen(!reviewSession.sidebarOpen())}
              open={reviewSession.sidebarOpen()}
            />

            <span style={{ flex: '1' }} />

            <button
              onClick={closeDialog}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                'align-items': 'center',
                'border-radius': '4px',
              }}
              title="Close"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>

          <div style={{ flex: '1', overflow: 'hidden', display: 'flex' }}>
            <div
              ref={scrollRef}
              class="plan-markdown-dialog"
              tabIndex={0}
              style={{
                flex: '1',
                overflow: 'auto',
                padding: '28px 40px',
                color: theme.fg,
                'font-size': '17px',
                'font-family': "'JetBrains Mono', monospace",
                outline: 'none',
              }}
            >
              <div style={{ position: 'relative' }}>
                <div
                  ref={contentRef}
                  class="plan-markdown"
                  style={{
                    color: theme.fg,
                  }}
                  onMouseUp={handleMouseUp}
                  // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
                  innerHTML={planHtml()}
                />

                <For each={highlightRects()}>
                  {(rect) => (
                    <div
                      style={{
                        position: 'absolute',
                        top: `${rect.top}px`,
                        left: `${rect.left}px`,
                        width: `${rect.width}px`,
                        height: `${rect.height}px`,
                        background: 'rgba(100, 149, 237, 0.3)',
                        'pointer-events': 'none',
                        'border-radius': '2px',
                      }}
                    />
                  )}
                </For>

                <Show when={reviewSession.pendingSelection()}>
                  <div
                    style={{
                      position: 'absolute',
                      top: `${selectionY()}px`,
                      left: '0',
                      right: '0',
                      'z-index': '10',
                    }}
                  >
                    <InlineInput onDismiss={dismissInlineInput} onSubmit={submitInlineInput} />
                  </div>
                </Show>

                <For each={reviewSession.annotations()}>
                  {(annotation) => (
                    <div
                      style={{
                        position: 'absolute',
                        top: `${cardOffsets()[annotation.id] ?? 0}px`,
                        left: '0',
                        right: '0',
                        'z-index': '5',
                      }}
                    >
                      <ReviewCommentCard
                        annotation={annotation}
                        onDismiss={() => reviewSession.dismissAnnotation(annotation.id)}
                        onUpdate={reviewSession.updateAnnotation}
                        overlay
                      />
                    </div>
                  )}
                </For>

                <For each={reviewSession.activeQuestions()}>
                  {(question) => (
                    <div
                      style={{
                        position: 'absolute',
                        top: `${cardOffsets()[question.id] ?? 0}px`,
                        left: '0',
                        right: '0',
                        'z-index': '5',
                      }}
                    >
                      <AskCodeCard
                        endLine={question.endLine}
                        onDismiss={() => reviewSession.dismissQuestion(question.id)}
                        question={question.question}
                        requestId={question.id}
                        selectedText={question.selectedText}
                        source={question.source}
                        startLine={question.startLine}
                        startSession={startAskAboutCodeSession}
                        worktreePath={props.worktreePath ?? ''}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>

            <Show when={reviewSession.sidebarOpen() && reviewSession.annotations().length > 0}>
              <ReviewSidebar {...reviewSidebarProps()} />
            </Show>
          </div>
        </>
      </Show>
    </Dialog>
  );
}
