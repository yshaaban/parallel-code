import { Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from 'solid-js';

import { createTaskReviewDiffRequest, fetchTaskFileDiff } from '../app/review-diffs';
import { startAskAboutCodeSession } from '../app/task-ai-workflows';
import type { ChangedFile } from '../ipc/types';
import { createCtrlWheelZoomHandler } from '../lib/wheelZoom';
import { compileDiffReviewPrompt } from '../lib/review-prompts';
import { evictStaleAnnotations, evictStaleQuestions } from '../lib/review-eviction';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { parseMultiFileUnifiedDiff, type ParsedFileDiff } from '../lib/unified-diff-parser';
import { Dialog } from './Dialog';
import { ReviewCommentsToggle, ReviewSidebar } from './ReviewSidebar';
import { createReviewSurfaceSession } from './review-surface-session';
import { ChangedFilesList } from './ChangedFilesList';
import { ScrollingDiffView } from './ScrollingDiffView';

interface DiffViewerDialogProps {
  baseBranch?: string;
  file: ChangedFile | null;
  worktreePath: string;
  onClose: () => void;
  projectRoot?: string;
  branchName?: string | null;
  taskId?: string;
  agentId?: string;
}

const MIN_DIALOG_ZOOM = 0.5;
const MAX_DIALOG_ZOOM = 2.0;
const DIALOG_ZOOM_STEP = 0.1;

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
  const titleId = createUniqueId();
  const [parsedFiles, setParsedFiles] = createSignal<ParsedFileDiff[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [dialogZoom, setDialogZoom] = createSignal(1);
  const [activeFile, setActiveFile] = createSignal<ChangedFile | null>(null);
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

  function adjustDialogZoom(delta: 1 | -1): void {
    setDialogZoom(
      (current) =>
        Math.round(
          Math.min(MAX_DIALOG_ZOOM, Math.max(MIN_DIALOG_ZOOM, current + delta * DIALOG_ZOOM_STEP)) *
            10,
        ) / 10,
    );
  }

  createEffect(() => {
    const file = props.file;
    setActiveFile(file);
    if (file) {
      setDialogZoom(1);
    }
  });

  const handleDialogWheel = createCtrlWheelZoomHandler(adjustDialogZoom, {
    stopPropagation: true,
  });

  createEffect(() => {
    const file = activeFile();
    if (!file) {
      reviewSession.reset();
      return;
    }

    const request = createTaskReviewDiffRequest({
      baseBranch: props.baseBranch,
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

  function renderChangedFilesSidebar(): JSX.Element {
    if (props.taskId) {
      return (
        <ChangedFilesList
          activeFilePath={activeFile()?.path}
          filterHydraArtifacts={false}
          isActive={activeFile() !== null}
          kind="task"
          onFileClick={(file: ChangedFile) => setActiveFile(file)}
          taskId={props.taskId}
          worktreePath={props.worktreePath}
        />
      );
    }

    return (
      <ChangedFilesList
        activeFilePath={activeFile()?.path}
        baseBranch={props.baseBranch}
        branchName={props.branchName}
        filterHydraArtifacts={false}
        isActive={activeFile() !== null}
        kind="worktree"
        onFileClick={(file: ChangedFile) => setActiveFile(file)}
        projectRoot={props.projectRoot}
        worktreePath={props.worktreePath}
      />
    );
  }

  return (
    <Dialog
      open={props.file !== null}
      onClose={closeDialog}
      width="90vw"
      labelledBy={titleId}
      panelStyle={{
        height: '85vh',
        'max-width': '1400px',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <h2 id={titleId} class="dialog-sr-only">
        Diff viewer: {props.file?.path ?? 'all changes'}
      </h2>
      <Show when={activeFile()}>
        {(file) => (
          <div
            data-diff-viewer-zoom-root
            onWheel={handleDialogWheel}
            style={{
              display: 'flex',
              'flex-direction': 'column',
              height: '100%',
              'min-height': '0',
              zoom: String(dialogZoom()),
            }}
          >
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
                type="button"
                onClick={closeDialog}
                aria-label="Close diff viewer"
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

            <div style={{ flex: '1', overflow: 'hidden', display: 'flex', 'min-height': '0' }}>
              <aside
                aria-label="Changed files"
                style={{
                  width: '280px',
                  'min-width': '220px',
                  'max-width': '32vw',
                  display: 'flex',
                  'flex-direction': 'column',
                  background: theme.taskPanelBg,
                  'border-right': `1px solid ${theme.border}`,
                  'flex-shrink': '0',
                  'min-height': '0',
                }}
              >
                <div
                  style={{
                    padding: '8px 10px',
                    color: theme.fgMuted,
                    'border-bottom': `1px solid ${theme.border}`,
                    'flex-shrink': '0',
                    ...typography.label,
                  }}
                >
                  Changed Files
                </div>
                <div style={{ flex: '1', overflow: 'hidden' }}>{renderChangedFilesSidebar()}</div>
              </aside>

              <div style={{ flex: '1', overflow: 'hidden', 'min-width': '0' }}>
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
                          baseBranch: props.baseBranch,
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
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
