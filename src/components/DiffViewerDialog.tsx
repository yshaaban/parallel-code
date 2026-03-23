import { Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';

import { createTaskReviewDiffRequest, fetchTaskFileDiff } from '../app/review-diffs';
import { startAskAboutCodeSession } from '../app/task-ai-workflows';
import type { ChangedFile } from '../ipc/types';
import { compileDiffReviewPrompt } from '../lib/review-prompts';
import { evictStaleAnnotations, evictStaleQuestions } from '../lib/review-eviction';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { parseMultiFileUnifiedDiff, type ParsedFileDiff } from '../lib/unified-diff-parser';
import { Dialog } from './Dialog';
import { ReviewCommentsToggle, ReviewSidebar } from './ReviewSidebar';
import { createReviewSurfaceSession } from './review-surface-session';
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
  const { reviewCommentCopyController, reviewSession, reviewSidebarProps } =
    createReviewSurfaceSession({
      compilePrompt: compileDiffReviewPrompt,
      getAgentId: () => props.agentId,
      getTaskId: () => props.taskId,
      onSubmitted: () => props.onClose(),
    });
  let fetchGeneration = 0;
  let searchInputRef: HTMLInputElement | undefined;

  function closeDialog(): void {
    reviewSession.reset();
    reviewCommentCopyController.resetCopyActionLabel();
    props.onClose();
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

    fetchTaskFileDiff(request, file)
      .then((result) => {
        if (generation !== fetchGeneration) {
          return;
        }

        const files = parseMultiFileUnifiedDiff(result.diff);
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
                gap: '8px',
                padding: '10px 16px',
                'border-bottom': `1px solid ${theme.border}`,
                'flex-shrink': '0',
              }}
            >
              <span
                style={{
                  color: theme.fg,
                  ...typography.uiStrong,
                }}
              >
                {parsedFiles().length} {parsedFiles().length === 1 ? 'file' : 'files'} changed
              </span>
              <span
                style={{
                  color: theme.success,
                  ...typography.monoMeta,
                }}
              >
                +{getTotalAdded()}
              </span>
              <span
                style={{
                  color: theme.error,
                  ...typography.monoMeta,
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
                  padding: '2px 6px',
                  width: '180px',
                  outline: 'none',
                  ...typography.monoUi,
                }}
              />
              <Show when={searchQuery().trim().length > 0}>
                <span
                  style={{
                    color: theme.fgSubtle,
                    'white-space': 'nowrap',
                    ...typography.meta,
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
                    padding: '28px',
                    'text-align': 'center',
                    color: theme.fgMuted,
                    ...typography.ui,
                  }}
                >
                  Loading diff...
                </div>
              </Show>

              <Show when={error()}>
                <div
                  style={{
                    padding: '28px',
                    'text-align': 'center',
                    color: theme.error,
                    ...typography.ui,
                  }}
                >
                  {error()}
                </div>
              </Show>

              <Show when={!loading() && !error()}>
                <div style={{ display: 'flex', height: '100%' }}>
                  <div style={{ flex: '1', overflow: 'hidden' }}>
                    <ScrollingDiffView
                      file={file()}
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
                    <ReviewSidebar {...reviewSidebarProps()} />
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
