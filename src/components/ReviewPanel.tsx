import { Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js';

import { createTaskReviewFilesRequest } from '../app/review-files';
import type { ReviewAnnotation } from '../app/review-session';
import { getTaskConvergenceSnapshot } from '../app/task-convergence';
import { getTaskReviewSnapshot } from '../app/task-review-state';
import { startAskAboutCodeSession } from '../app/task-ai-workflows';
import { getTaskReviewStateLabel } from '../domain/task-convergence';
import { isHydraCoordinationArtifact } from '../lib/hydra';
import { compileDiffReviewPrompt } from '../lib/review-prompts';
import { theme } from '../lib/theme';
import { parseMultiFileUnifiedDiff } from '../lib/unified-diff-parser';
import type { ChangedFile } from '../ipc/types';
import { ReviewPanelConvergenceBanner } from './review-panel/ReviewPanelConvergenceBanner';
import { createReviewPanelController } from './review-panel/review-panel-controller';
import { ReviewPanelDiffPane } from './review-panel/ReviewPanelDiffPane';
import { ReviewPanelFileList } from './review-panel/ReviewPanelFileList';
import { ReviewPanelToolbar } from './review-panel/ReviewPanelToolbar';
import { createReviewSurfaceSession } from './review-surface-session';
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

function getReviewStateColor(taskId?: string): string {
  if (!taskId) {
    return theme.fgMuted;
  }

  const state = getTaskConvergenceSnapshot(taskId)?.state;
  return state ? getTaskReviewPanelColor(state) : theme.fgMuted;
}

export function ReviewPanel(props: ReviewPanelProps): JSX.Element {
  const [showHydraArtifacts, setShowHydraArtifacts] = createSignal(false);
  const reviewSnapshot = () => (props.taskId ? getTaskReviewSnapshot(props.taskId) : undefined);
  const controller = createReviewPanelController({
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
    if (controller.loading()) {
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
    const request = createTaskReviewFilesRequest({
      branchName: props.branchName,
      projectRoot: props.projectRoot,
      worktreePath: props.worktreePath,
    });
    const currentMode = controller.mode();
    if (!props.isActive || (props.taskId && currentMode === 'all')) {
      return;
    }

    void controller.fetchFiles(request, currentMode);
  });

  createEffect(() => {
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
        fileCount={visibleFiles().length}
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
          onSelect={selectVisibleFile}
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
