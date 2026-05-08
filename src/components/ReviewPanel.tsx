import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type JSX,
} from 'solid-js';

import { fetchBranchCommitHistory } from '../app/review-commit-history';
import { createTaskReviewFilesRequest } from '../app/review-files';
import type { ReviewAnnotation } from '../app/review-session';
import { getTaskConvergenceSnapshot } from '../app/task-convergence';
import { getTaskReviewSnapshot } from '../app/task-review-state';
import { getTaskReviewSignalsSnapshot } from '../app/task-review-signals';
import { startAskAboutCodeSession } from '../app/task-ai-workflows';
import { getTaskReviewStateLabel } from '../domain/task-convergence';
import type { ReviewCommitSummary } from '../domain/review-commit-history';
import type { TaskReviewSnapshot } from '../domain/task-review';
import { isDiffableChangedFilePath } from '../lib/changed-file-display';
import {
  getChangedFilesVisibilityModel,
  getChangedFilesVisibleFileStats,
} from '../lib/changed-file-projection';
import { compileDiffReviewPrompt } from '../lib/review-prompts';
import { theme } from '../lib/theme';
import { parseMultiFileUnifiedDiff } from '../lib/unified-diff-parser';
import type { ChangedFile } from '../ipc/types';
import { getHydraArtifactToggleLabel, getHydraArtifactToggleTitle } from './hydra-artifact-labels';
import { ReviewPanelConvergenceBanner } from './review-panel/ReviewPanelConvergenceBanner';
import { createReviewPanelController } from './review-panel/review-panel-controller';
import { ReviewPanelDiffPane } from './review-panel/ReviewPanelDiffPane';
import { ReviewPanelFileList } from './review-panel/ReviewPanelFileList';
import { ReviewPanelSignalsBanner } from './review-panel/ReviewPanelSignalsBanner';
import { ReviewPanelToolbar } from './review-panel/ReviewPanelToolbar';
import { createReviewSurfaceSession } from './review-surface-session';
import { getTaskReviewPanelColor } from './task-review-presentation';

interface ReviewPanelProps {
  agentId?: string;
  baseBranch?: string;
  branchName: string;
  filterHydraArtifacts?: boolean;
  isActive: boolean;
  fullscreen?: boolean;
  onOpenFullscreen?: () => void;
  projectRoot?: string;
  taskId?: string;
  worktreePath: string;
}

function getReviewStateColor(taskId?: string): string {
  if (!taskId) {
    return theme.fgMuted;
  }

  const state = getTaskConvergenceSnapshot(taskId)?.state;
  return state ? getTaskReviewPanelColor(state) : theme.fgMuted;
}

function getCommitScopedReviewFiles(
  files: ReadonlyArray<ChangedFile>,
  commit: ReviewCommitSummary | null,
): ChangedFile[] {
  if (!commit) {
    return [...files];
  }

  return commit.files.map((file) => ({ ...file }));
}

function getCommitHistoryRefreshKey(snapshot: TaskReviewSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  const fileIdentities: string[] = [];
  for (const file of snapshot.files) {
    if (!file.committed) {
      continue;
    }

    totalAdded += file.lines_added;
    totalRemoved += file.lines_removed;
    fileIdentities.push(`${file.path}:${file.status}:${file.lines_added}:${file.lines_removed}`);
  }

  return `${snapshot.branchName}:${totalAdded}:${totalRemoved}:${fileIdentities.join('|')}`;
}

function getCommitHistoryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Commit history unavailable.';
}

export function ReviewPanel(props: ReviewPanelProps): JSX.Element {
  const [showHydraArtifacts, setShowHydraArtifacts] = createSignal(false);
  const [commitHistory, setCommitHistory] = createSignal<Awaited<
    ReturnType<typeof fetchBranchCommitHistory>
  > | null>(null);
  const [commitHistoryError, setCommitHistoryError] = createSignal<string | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = createSignal<string | null>(null);
  const reviewSnapshot = () => (props.taskId ? getTaskReviewSnapshot(props.taskId) : undefined);
  const commitHistoryRefreshKey = createMemo(() => getCommitHistoryRefreshKey(reviewSnapshot()));
  const reviewSignalsSnapshot = () =>
    props.taskId ? getTaskReviewSignalsSnapshot(props.taskId) : undefined;
  const reviewSignalsStale = createMemo(() => {
    const currentReview = reviewSnapshot();
    const currentSignals = reviewSignalsSnapshot();
    return Boolean(
      currentReview && currentSignals && currentSignals.updatedAt < currentReview.updatedAt,
    );
  });
  const controller = createReviewPanelController({
    baseBranch: () => props.baseBranch,
    branchName: () => props.branchName,
    getReviewSnapshot: reviewSnapshot,
    projectRoot: () => props.projectRoot,
    worktreePath: () => props.worktreePath,
  });
  const convergence = () => (props.taskId ? getTaskConvergenceSnapshot(props.taskId) : undefined);
  const { reviewSession, reviewSidebarProps } = createReviewSurfaceSession({
    compilePrompt: compileDiffReviewPrompt,
    getAgentId: () => props.agentId,
    getTaskId: () => props.taskId,
    onScrollTo: handleScrollToAnnotation,
  });
  const isReviewUnavailable = createMemo(() => reviewSnapshot()?.source === 'unavailable');
  const reviewFiles = createMemo(() => {
    const snapshot = reviewSnapshot();
    if (controller.mode() === 'all' && snapshot) {
      return snapshot.files;
    }

    return controller.files();
  });
  const commitSelectionEnabled = createMemo(() => {
    const mode = controller.mode();
    return mode === 'all' || mode === 'branch';
  });
  const activeCommitHistory = createMemo(() => {
    return commitSelectionEnabled() ? commitHistory() : null;
  });
  const activeCommitHistoryError = createMemo(() => {
    return commitSelectionEnabled() ? commitHistoryError() : null;
  });
  const selectedCommit = createMemo(() => {
    const hash = selectedCommitHash();
    if (!hash) {
      return null;
    }

    return activeCommitHistory()?.commits.find((commit) => commit.hash === hash) ?? null;
  });
  const scopedReviewFiles = createMemo(() => {
    return getCommitScopedReviewFiles(reviewFiles(), selectedCommit());
  });
  const visibilityModel = createMemo(() =>
    getChangedFilesVisibilityModel(scopedReviewFiles(), {
      filterHydraArtifacts: Boolean(props.filterHydraArtifacts),
      includeFile: (file) => isDiffableChangedFilePath(file.path),
      showHydraArtifacts: showHydraArtifacts(),
    }),
  );
  const hiddenHydraArtifactCount = createMemo(() => visibilityModel().hiddenHydraArtifactCount);
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
    if (controller.loading()) {
      return 'Loading...';
    }

    if (isReviewUnavailable()) {
      return 'Review data unavailable';
    }

    return 'Select a file';
  });
  const visibleFiles = createMemo(() => visibilityModel().visibleFiles);
  const visibleFileStats = createMemo(() => getChangedFilesVisibleFileStats(visibleFiles(), 'all'));
  const hydraToggleLabel = createMemo(() =>
    getHydraArtifactToggleLabel({
      count: hiddenHydraArtifactCount(),
      expanded: showHydraArtifacts(),
    }),
  );
  const hydraToggleTitle = createMemo(() =>
    getHydraArtifactToggleTitle({
      count: hiddenHydraArtifactCount(),
      expanded: showHydraArtifacts(),
    }),
  );
  const selectedIndex = createMemo(() => {
    const selectedPath = controller.selectedFilePath();
    if (!selectedPath) {
      return visibleFiles().length > 0 ? 0 : -1;
    }

    const index = visibleFiles().findIndex((file) => file.path === selectedPath);
    return index === -1 ? 0 : index;
  });
  const selectedFile = createMemo<ChangedFile | undefined>(() => visibleFiles()[selectedIndex()]);
  const canSelectPreviousFile = createMemo(() => selectedIndex() > 0);
  const canSelectNextFile = createMemo(() => selectedIndex() < visibleFiles().length - 1);
  const monacoRevealLine = createMemo(() => {
    const target = reviewSession.scrollTarget();
    const file = selectedFile();
    if (!controller.sideBySide() || !target || !file || target.source !== file.path) {
      return null;
    }

    return target.endLine;
  });
  const parsedDiffFiles = createMemo(() => {
    const currentDiff = controller.diff();
    if (!currentDiff?.diff) {
      return [];
    }

    return parseMultiFileUnifiedDiff(currentDiff.diff);
  });
  const reviewDiffRequest = controller.reviewDiffRequest;

  createEffect(() => {
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const baseBranch = props.baseBranch;
    const historyRefreshKey = commitHistoryRefreshKey();
    if (!props.isActive || !projectRoot || !branchName) {
      setCommitHistory(null);
      setCommitHistoryError(null);
      setSelectedCommitHash(null);
      return;
    }

    let cancelled = false;
    setCommitHistoryError(null);
    void fetchBranchCommitHistory({
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      branchName,
      projectRoot,
    })
      .then((history) => {
        if (cancelled) {
          return;
        }

        setCommitHistory(history);
        setCommitHistoryError(null);
        const currentSelectedCommitHash = untrack(selectedCommitHash);
        if (
          currentSelectedCommitHash &&
          !history.commits.some((commit) => commit.hash === currentSelectedCommitHash)
        ) {
          setSelectedCommitHash(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCommitHistory(null);
          setCommitHistoryError(getCommitHistoryErrorMessage(error));
          setSelectedCommitHash(null);
        }
      });

    void historyRefreshKey;
    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    controller.currentRevisionId();
    const request = createTaskReviewFilesRequest({
      baseBranch: props.baseBranch,
      branchName: props.branchName,
      projectRoot: props.projectRoot,
      worktreePath: props.worktreePath,
    });
    const currentMode = controller.mode();
    if (!props.isActive || (props.taskId && currentMode === 'all')) {
      controller.cancelFileRequests();
      return;
    }

    void controller.fetchFiles(request, currentMode);
  });

  createEffect(() => {
    if (!props.isActive) {
      controller.clearDiff();
      return;
    }

    const currentFiles = visibleFiles();
    controller.syncSelectedFilePath(currentFiles);

    const index = selectedIndex();
    if (currentFiles.length > 0 && index >= 0 && index < currentFiles.length) {
      void controller.fetchDiff(currentFiles[index]);
      return;
    }

    controller.clearDiff();
  });

  function handleScrollToAnnotation(annotation: ReviewAnnotation): void {
    const currentVisibleFiles = visibleFiles();
    const nextIndex = currentVisibleFiles.findIndex((file) => file.path === annotation.source);
    if (nextIndex !== -1) {
      selectVisibleFile(nextIndex);
    }

    reviewSession.setSidebarOpen(true);
    reviewSession.setScrollTarget(annotation);
  }

  function selectVisibleFile(index: number): void {
    controller.setSelectedFilePath(visibleFiles()[index]?.path ?? null);
  }

  function navPrev(): void {
    controller.selectPreviousFile(visibleFiles());
  }

  function navNext(): void {
    controller.selectNextFile(visibleFiles());
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
        fileCount={visibleFileStats().fileCount}
        mode={controller.mode()}
        onNext={navNext}
        onOpenFullscreen={props.onOpenFullscreen}
        onPrevious={navPrev}
        onSetMode={(nextMode) => {
          controller.setMode(nextMode);
        }}
        onToggleComments={() => reviewSession.setSidebarOpen(!reviewSession.sidebarOpen())}
        onToggleSideBySide={controller.toggleSideBySide}
        sideBySide={controller.sideBySide()}
        sidebarOpen={reviewSession.sidebarOpen()}
        showOpenFullscreen={Boolean(props.onOpenFullscreen && !props.fullscreen)}
        totalAdded={visibleFileStats().totalAdded}
        totalRemoved={visibleFileStats().totalRemoved}
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
            aria-label={hydraToggleTitle()}
            title={hydraToggleTitle()}
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
            {hydraToggleLabel()}
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

      <Show when={reviewSignalsSnapshot()}>
        {(snapshot) => (
          <ReviewPanelSignalsBanner snapshot={snapshot()} stale={reviewSignalsStale()} />
        )}
      </Show>

      <div style={{ display: 'flex', flex: '1', overflow: 'hidden' }}>
        <ReviewPanelFileList
          commitHistoryError={activeCommitHistoryError()}
          commits={activeCommitHistory()?.commits}
          emptyMessage={emptyStateMessage()}
          files={visibleFiles()}
          onSelect={selectVisibleFile}
          onSelectCommit={setSelectedCommitHash}
          selectedCommitHash={selectedCommitHash()}
          selectedIndex={selectedIndex()}
        />
        <ReviewPanelDiffPane
          diff={controller.diff()}
          emptyMessage={emptyDiffMessage()}
          loading={controller.loading()}
          monacoRevealLine={monacoRevealLine()}
          parsedDiffFiles={parsedDiffFiles()}
          reviewDiffRequest={reviewDiffRequest()}
          reviewSession={reviewSession}
          reviewSidebarProps={reviewSidebarProps()}
          selectedFile={selectedFile()}
          showSidebar={reviewSession.sidebarOpen() && reviewSession.annotations().length > 0}
          sideBySide={controller.sideBySide()}
          startAskSession={startAskAboutCodeSession}
        />
      </div>
    </div>
  );
}
