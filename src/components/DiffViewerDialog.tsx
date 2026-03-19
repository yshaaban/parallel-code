import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';

import { createTaskReviewDiffRequest, fetchTaskAllDiffs } from '../app/review-diffs';
import { createTaskReviewSession } from '../app/task-review-session';
import { startAskAboutCodeSession } from '../app/task-ai-workflows';
import type { ChangedFile } from '../ipc/types';
import { sf } from '../lib/fontScale';
import {
  copyReviewCommentsPrompt,
  COPY_REVIEW_COMMENTS_LABEL,
  PROMPT_WITH_REVIEW_COMMENTS_LABEL,
  resetReviewCommentCopyLabel,
} from '../lib/review-comment-actions';
import { compileDiffReviewPrompt } from '../lib/review-prompts';
import { evictStaleAnnotations, evictStaleQuestions } from '../lib/review-eviction';
import { theme } from '../lib/theme';
import { parseMultiFileUnifiedDiff, type ParsedFileDiff } from '../lib/unified-diff-parser';
import { Dialog } from './Dialog';
import { ReviewCommentsToggle, ReviewSidebar } from './ReviewSidebar';
import { ScrollingDiffView } from './ScrollingDiffView';

interface DiffViewerDialogProps {
  file: ChangedFile | null;
  worktreePath: string;
  onClose: () => void;
  projectRoot?: string;
  branchName?: string | null;
  taskId?: string;
  agentId?: string;
}

function countMatches(files: ReadonlyArray<ParsedFileDiff>, query: string): number {
  if (!query) {
    return 0;
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  let count = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        let searchStart = 0;
        const lowerText = line.content.toLowerCase();
        while (searchStart < lowerText.length) {
          const index = lowerText.indexOf(normalizedQuery, searchStart);
          if (index === -1) {
            break;
          }
          count += 1;
          searchStart = index + normalizedQuery.length;
        }
      }
    }
  }

  return count;
}

export function DiffViewerDialog(props: DiffViewerDialogProps): JSX.Element {
  const [parsedFiles, setParsedFiles] = createSignal<ParsedFileDiff[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [copyActionLabel, setCopyActionLabel] = createSignal(COPY_REVIEW_COMMENTS_LABEL);
  const reviewSession = createTaskReviewSession({
    compilePrompt: compileDiffReviewPrompt,
    getAgentId: () => props.agentId,
    getTaskId: () => props.taskId,
    onSubmitted: () => props.onClose(),
  });
  let fetchGeneration = 0;
  let searchInputRef: HTMLInputElement | undefined;

  function closeDialog(): void {
    reviewSession.reset();
    resetReviewCommentCopyLabel(setCopyActionLabel);
    props.onClose();
  }

  createEffect(() => {
    if (reviewSession.annotations().length === 0) {
      resetReviewCommentCopyLabel(setCopyActionLabel);
    }
  });

  function handleCopyComments(): void {
    const prompt = compileDiffReviewPrompt(reviewSession.annotations());
    copyReviewCommentsPrompt(prompt, setCopyActionLabel);
  }

  createEffect(() => {
    const file = props.file;
    if (!file) {
      reviewSession.reset();
      return;
    }

    const request = createTaskReviewDiffRequest({
      branchName: props.branchName,
      projectRoot: props.projectRoot,
      worktreePath: props.worktreePath,
    });
    const generation = ++fetchGeneration;

    setSearchQuery('');
    setLoading(true);
    setError('');
    setParsedFiles([]);

    fetchTaskAllDiffs(request)
      .then((rawDiff) => {
        if (generation !== fetchGeneration) {
          return;
        }

        const files = parseMultiFileUnifiedDiff(rawDiff);
        setParsedFiles(files);
        reviewSession.replaceAnnotations((annotations) =>
          evictStaleAnnotations(annotations, files),
        );
        reviewSession.replaceQuestions((questions) => evictStaleQuestions(questions, files));
      })
      .catch((nextError) => {
        if (generation !== fetchGeneration) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (generation === fetchGeneration) {
          setLoading(false);
        }
      });
  });

  createEffect(() => {
    const activeFile = props.file;
    if (!activeFile) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
        event.preventDefault();
        searchInputRef?.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      document.removeEventListener('keydown', handleKeyDown);
    });
  });

  function getTotalAdded(): number {
    return parsedFiles().reduce(
      (sum, file) =>
        sum +
        file.hunks.reduce(
          (innerSum, hunk) => innerSum + hunk.lines.filter((line) => line.type === 'add').length,
          0,
        ),
      0,
    );
  }

  function getTotalRemoved(): number {
    return parsedFiles().reduce(
      (sum, file) =>
        sum +
        file.hunks.reduce(
          (innerSum, hunk) => innerSum + hunk.lines.filter((line) => line.type === 'remove').length,
          0,
        ),
      0,
    );
  }

  return (
    <Dialog
      open={props.file !== null}
      onClose={closeDialog}
      width="90vw"
      panelStyle={{
        height: '85vh',
        'max-width': '1400px',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <Show when={props.file}>
        {(file) => (
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
                }}
              >
                {parsedFiles().length} files changed
              </span>
              <span
                style={{
                  'font-size': sf(12),
                  color: theme.success,
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                +{getTotalAdded()}
              </span>
              <span
                style={{
                  'font-size': sf(12),
                  color: theme.error,
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                -{getTotalRemoved()}
              </span>

              <ReviewCommentsToggle
                count={reviewSession.annotations().length}
                onToggle={() => reviewSession.setSidebarOpen(!reviewSession.sidebarOpen())}
                open={reviewSession.sidebarOpen()}
              />

              <span style={{ flex: '1' }} />

              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search..."
                value={searchQuery()}
                onInput={(event) => setSearchQuery(event.currentTarget.value)}
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: `1px solid ${theme.borderSubtle}`,
                  'border-radius': '4px',
                  color: theme.fg,
                  'font-size': sf(12),
                  'font-family': "'JetBrains Mono', monospace",
                  padding: '3px 8px',
                  width: '200px',
                  outline: 'none',
                }}
              />
              <Show when={searchQuery().trim().length > 0}>
                <span
                  style={{
                    'font-size': sf(11),
                    color: theme.fgSubtle,
                    'white-space': 'nowrap',
                  }}
                >
                  {countMatches(parsedFiles(), searchQuery())} matches
                </span>
              </Show>

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

            <div style={{ flex: '1', overflow: 'hidden' }}>
              <Show when={loading()}>
                <div
                  style={{
                    padding: '40px',
                    'text-align': 'center',
                    color: theme.fgMuted,
                    'font-size': sf(13),
                  }}
                >
                  Loading diffs...
                </div>
              </Show>

              <Show when={error()}>
                <div
                  style={{
                    padding: '40px',
                    'text-align': 'center',
                    color: theme.error,
                    'font-size': sf(13),
                  }}
                >
                  {error()}
                </div>
              </Show>

              <Show when={!loading() && !error()}>
                <div style={{ display: 'flex', height: '100%' }}>
                  <div style={{ flex: '1', overflow: 'hidden' }}>
                    <ScrollingDiffView
                      files={parsedFiles()}
                      request={createTaskReviewDiffRequest({
                        branchName: props.branchName,
                        projectRoot: props.projectRoot,
                        worktreePath: props.worktreePath,
                      })}
                      reviewSession={reviewSession}
                      scrollToPath={file().path}
                      searchQuery={searchQuery()}
                      startAskSession={startAskAboutCodeSession}
                    />
                  </div>
                  <Show
                    when={reviewSession.sidebarOpen() && reviewSession.annotations().length > 0}
                  >
                    <ReviewSidebar
                      annotations={reviewSession.annotations()}
                      canSubmit={reviewSession.canSubmit()}
                      copyActionLabel={copyActionLabel()}
                      onCopy={handleCopyComments}
                      onDismiss={reviewSession.dismissAnnotation}
                      onScrollTo={reviewSession.setScrollTarget}
                      onSubmit={() => {
                        void reviewSession.submitReview();
                      }}
                      submitActionLabel={PROMPT_WITH_REVIEW_COMMENTS_LABEL}
                      submitError={reviewSession.submitError()}
                    />
                  </Show>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </Dialog>
  );
}
