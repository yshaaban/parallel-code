import { Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js';

import { createAsyncRequestGuard } from '../app/async-request-guard';
import { createTaskReviewDiffRequest } from '../app/review-diffs';
import { createTaskReviewFilesRequest, fetchTaskReviewFiles } from '../app/review-files';
import type { ReviewAnnotation } from '../app/review-session';
import { getTaskConvergenceSnapshot } from '../app/task-convergence';
import { getTaskReviewSnapshot } from '../app/task-review-state';
import { createTaskReviewSession } from '../app/task-review-session';
import { startAskAboutCodeSession } from '../app/task-ai-workflows';
import { getTaskReviewStateLabel } from '../domain/task-convergence';
import { isHydraCoordinationArtifact } from '../lib/hydra';
import { invoke } from '../lib/ipc';
import { compileDiffReviewPrompt } from '../lib/review-prompts';
import { theme } from '../lib/theme';
import { parseMultiFileUnifiedDiff } from '../lib/unified-diff-parser';
import { IPC } from '../../electron/ipc/channels';
import type { ChangedFile, FileDiffResult } from '../ipc/types';
import type { ReviewDiffMode } from '../store/types';
import {
  createReviewCommentCopyController,
  createReviewSidebarProps,
} from './review-sidebar-actions';
import { ReviewPanelConvergenceBanner } from './review-panel/ReviewPanelConvergenceBanner';
import { ReviewPanelDiffPane } from './review-panel/ReviewPanelDiffPane';
import { ReviewPanelFileList } from './review-panel/ReviewPanelFileList';
import { ReviewPanelToolbar } from './review-panel/ReviewPanelToolbar';
import { getTaskReviewPanelColor } from './task-review-presentation';

interface ReviewPanelProps {
  agentId?: string;
  branchName: string;
  filterHydraArtifacts?: boolean;
  isActive: boolean;
  fullscreen?: boolean;
  onOpenFullscreen?: () => void;
  projectRoot?: string;
  taskId?: string;
  worktreePath: string;
}

interface ReviewFilesRequest {
  branchName?: string | null;
  projectRoot?: string;
  worktreePath: string;
}

function getReviewStateColor(taskId?: string): string {
  if (!taskId) {
    return theme.fgMuted;
  }

  const state = getTaskConvergenceSnapshot(taskId)?.state;
  return state ? getTaskReviewPanelColor(state) : theme.fgMuted;
}

export function ReviewPanel(props: ReviewPanelProps): JSX.Element {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  const [showHydraArtifacts, setShowHydraArtifacts] = createSignal(false);
  const [mode, setMode] = createSignal<ReviewDiffMode>('all');
  const [sideBySide, setSideBySide] = createSignal(false);
  const [diff, setDiff] = createSignal<FileDiffResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const convergence = () => (props.taskId ? getTaskConvergenceSnapshot(props.taskId) : undefined);
  const reviewSession = createTaskReviewSession({
    compilePrompt: compileDiffReviewPrompt,
    getAgentId: () => props.agentId,
    getTaskId: () => props.taskId,
  });
  const reviewSnapshot = () => (props.taskId ? getTaskReviewSnapshot(props.taskId) : undefined);
  const isReviewUnavailable = createMemo(() => reviewSnapshot()?.source === 'unavailable');
  const currentRevisionId = createMemo(() => {
    const snapshot = reviewSnapshot();
    if (mode() === 'all' && snapshot) {
      return snapshot.revisionId;
    }

    return `${mode()}:${props.worktreePath}:${props.branchName}:${snapshot?.revisionId ?? 'none'}`;
  });
  const reviewFiles = createMemo(() => {
    const snapshot = reviewSnapshot();
    if (mode() === 'all' && snapshot) {
      return snapshot.files;
    }

    return files();
  });
  const hiddenHydraArtifactCount = createMemo(() => {
    if (!props.filterHydraArtifacts) {
      return 0;
    }

    return reviewFiles().filter((file) => isHydraCoordinationArtifact(file.path)).length;
  });
  const emptyStateMessage = createMemo(() => {
    if (isReviewUnavailable()) {
      return 'Review data unavailable';
    }

    if (hiddenHydraArtifactCount() > 0 && !showHydraArtifacts()) {
      return 'Only Hydra coordination files are hidden';
    }

    return 'No changes';
  });
  const emptyDiffMessage = createMemo(() => {
    if (loading()) {
      return 'Loading...';
    }

    if (isReviewUnavailable()) {
      return 'Review data unavailable';
    }

    return 'Select a file';
  });
  const visibleFiles = createMemo(() => {
    if (!props.filterHydraArtifacts || showHydraArtifacts()) {
      return reviewFiles();
    }

    return reviewFiles().filter((file) => !isHydraCoordinationArtifact(file.path));
  });
  const visibleTotalAdded = createMemo(() =>
    visibleFiles().reduce((sum, file) => sum + file.lines_added, 0),
  );
  const visibleTotalRemoved = createMemo(() =>
    visibleFiles().reduce((sum, file) => sum + file.lines_removed, 0),
  );
  const canSelectPreviousFile = createMemo(() => selectedIdx() > 0);
  const canSelectNextFile = createMemo(() => selectedIdx() < visibleFiles().length - 1);
  const reviewDiffRequest = createMemo(() =>
    createTaskReviewDiffRequest({
      branchName: props.branchName,
      projectRoot: props.projectRoot,
      worktreePath: props.worktreePath,
    }),
  );
  const monacoRevealLine = createMemo(() => {
    const target = reviewSession.scrollTarget();
    const file = selectedFile();
    if (!sideBySide() || !target || !file || target.source !== file.path) {
      return null;
    }

    return target.endLine;
  });
  const parsedDiffFiles = createMemo(() => {
    const currentDiff = diff();
    if (!currentDiff?.diff) {
      return [];
    }

    return parseMultiFileUnifiedDiff(currentDiff.diff);
  });
  const fileRequestGuard = createAsyncRequestGuard(() => currentRevisionId());
  const diffRequestGuard = createAsyncRequestGuard(() => currentRevisionId());

  async function fetchFiles(
    request: ReviewFilesRequest,
    currentMode: ReviewDiffMode,
  ): Promise<void> {
    const requestToken = fileRequestGuard.beginRequest();
    try {
      const result = await fetchTaskReviewFiles(request, currentMode);
      if (!fileRequestGuard.isCurrent(requestToken)) {
        return;
      }
      setFiles(result.files);
    } catch {
      /* ignore polling errors */
    }
  }

  async function fetchDiff(file: ChangedFile): Promise<void> {
    const requestToken = diffRequestGuard.beginRequest();
    setLoading(true);
    try {
      let result: FileDiffResult;
      if (file.committed) {
        const projectRoot = props.projectRoot;
        if (typeof projectRoot !== 'string') {
          throw new Error('Project root is required for branch diff requests');
        }

        result = await invoke(IPC.GetFileDiffFromBranch, {
          branchName: props.branchName,
          filePath: file.path,
          projectRoot,
        });
      } else {
        result = await invoke(IPC.GetFileDiff, {
          filePath: file.path,
          worktreePath: props.worktreePath,
        });
      }
      if (!diffRequestGuard.isCurrent(requestToken)) {
        return;
      }
      setDiff(result);
    } catch {
      if (!diffRequestGuard.isCurrent(requestToken)) {
        return;
      }
      setDiff(null);
    } finally {
      if (diffRequestGuard.isLatestRequest(requestToken)) {
        setLoading(false);
      }
    }
  }

  createEffect(() => {
    const request: ReviewFilesRequest = createTaskReviewFilesRequest({
      worktreePath: props.worktreePath,
      projectRoot: props.projectRoot,
      branchName: props.branchName,
    });
    const currentMode = mode();
    const reviewRevisionId = reviewSnapshot()?.revisionId;
    if (!props.isActive || (props.taskId && currentMode === 'all')) {
      return;
    }
    void reviewRevisionId;

    void fetchFiles(request, currentMode);
  });

  createEffect(() => {
    const currentFiles = visibleFiles();
    const index = selectedIdx();
    if (currentFiles.length > 0 && index >= 0 && index < currentFiles.length) {
      void fetchDiff(currentFiles[index]);
      return;
    }

    setDiff(null);
    setLoading(false);
  });

  createEffect(() => {
    const currentFiles = visibleFiles();
    if (selectedIdx() >= currentFiles.length) {
      setSelectedIdx(currentFiles.length > 0 ? currentFiles.length - 1 : 0);
    }
  });

  const reviewCommentCopyController = createReviewCommentCopyController({
    compilePrompt: compileDiffReviewPrompt,
    reviewSession,
  });

  function selectedFile(): ChangedFile | undefined {
    return visibleFiles()[selectedIdx()];
  }

  function handleScrollToAnnotation(annotation: ReviewAnnotation): void {
    const nextIndex = visibleFiles().findIndex((file) => file.path === annotation.source);
    if (nextIndex !== -1) {
      setSelectedIdx(nextIndex);
    }
    reviewSession.setSidebarOpen(true);
    reviewSession.setScrollTarget(annotation);
  }

  const reviewSidebarProps = createReviewSidebarProps({
    copyActionLabel: reviewCommentCopyController.copyActionLabel,
    onCopy: reviewCommentCopyController.copyComments,
    onScrollTo: handleScrollToAnnotation,
    reviewSession,
  });

  function navPrev(): void {
    setSelectedIdx((index) => Math.max(0, index - 1));
  }

  function navNext(): void {
    setSelectedIdx((index) => Math.min(visibleFiles().length - 1, index + 1));
  }

  function handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowUp':
      case 'k':
        event.preventDefault();
        navPrev();
        return;
      case 'ArrowDown':
      case 'j':
        event.preventDefault();
        navNext();
        return;
      case 'n':
        navNext();
        return;
      case 'p':
        navPrev();
        return;
      default:
        return;
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: theme.taskPanelBg,
        color: theme.fg,
      }}
      onKeyDown={(event) => handleKeyDown(event)}
      tabIndex={0}
    >
      <ReviewPanelToolbar
        canSelectNextFile={canSelectNextFile()}
        canSelectPreviousFile={canSelectPreviousFile()}
        commentCount={reviewSession.annotations().length}
        fileCount={visibleFiles().length}
        mode={mode()}
        onNext={navNext}
        onOpenFullscreen={props.onOpenFullscreen}
        onPrevious={navPrev}
        onSetMode={(nextMode) => {
          setMode(nextMode);
          setSelectedIdx(0);
        }}
        onToggleComments={() => reviewSession.setSidebarOpen(!reviewSession.sidebarOpen())}
        onToggleSideBySide={() => setSideBySide((current) => !current)}
        sideBySide={sideBySide()}
        sidebarOpen={reviewSession.sidebarOpen()}
        showOpenFullscreen={Boolean(props.onOpenFullscreen && !props.fullscreen)}
        totalAdded={visibleTotalAdded()}
        totalRemoved={visibleTotalRemoved()}
      />

      <Show when={props.filterHydraArtifacts && hiddenHydraArtifactCount() > 0}>
        <div
          style={{
            padding: '6px 8px 2px',
            'font-size': '10px',
            color: theme.fgMuted,
            'border-bottom': `1px solid ${theme.border}`,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          <button
            type="button"
            onClick={() => setShowHydraArtifacts((value) => !value)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '0',
              color: theme.accent,
              cursor: 'pointer',
              'font-size': 'inherit',
              'font-family': "'JetBrains Mono', monospace",
            }}
          >
            {showHydraArtifacts()
              ? 'Hide Hydra coordination files'
              : `Show ${hiddenHydraArtifactCount()} Hydra coordination files`}
          </button>
        </div>
      </Show>

      <Show when={convergence()}>
        {(snapshot) => (
          <ReviewPanelConvergenceBanner
            snapshot={snapshot()}
            stateColor={getReviewStateColor(props.taskId)}
            stateLabel={getTaskReviewStateLabel(snapshot().state)}
          />
        )}
      </Show>

      <div style={{ display: 'flex', flex: '1', overflow: 'hidden' }}>
        <ReviewPanelFileList
          emptyMessage={emptyStateMessage()}
          files={visibleFiles()}
          onSelect={setSelectedIdx}
          selectedIndex={selectedIdx()}
        />
        <ReviewPanelDiffPane
          diff={diff()}
          emptyMessage={emptyDiffMessage()}
          loading={loading()}
          monacoRevealLine={monacoRevealLine()}
          parsedDiffFiles={parsedDiffFiles()}
          reviewDiffRequest={reviewDiffRequest()}
          reviewSession={reviewSession}
          reviewSidebarProps={reviewSidebarProps()}
          selectedFile={selectedFile()}
          showSidebar={reviewSession.sidebarOpen() && reviewSession.annotations().length > 0}
          sideBySide={sideBySide()}
          startAskSession={startAskAboutCodeSession}
        />
      </div>
    </div>
  );
}
