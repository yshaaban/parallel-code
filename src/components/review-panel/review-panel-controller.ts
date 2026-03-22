import { createMemo, createSignal, type Accessor } from 'solid-js';

import { createAsyncRequestGuard } from '../../app/async-request-guard';
import {
  createTaskReviewDiffRequest,
  fetchTaskFileDiff,
  type TaskReviewDiffRequest,
} from '../../app/review-diffs';
import { fetchTaskReviewFiles, type TaskReviewFilesRequest } from '../../app/review-files';
import type { TaskReviewSnapshot } from '../../domain/task-review';
import type { ChangedFile, FileDiffResult } from '../../ipc/types';
import { assertNever } from '../../lib/assert-never';
import type { ReviewDiffMode } from '../../store/types';

interface ReviewPanelControllerOptions {
  branchName: Accessor<string>;
  getReviewSnapshot: Accessor<TaskReviewSnapshot | undefined>;
  projectRoot?: Accessor<string | undefined>;
  worktreePath: Accessor<string>;
}

function getFileIndexByPath(
  files: ReadonlyArray<ChangedFile>,
  selectedFilePath: string | null,
): number {
  if (!selectedFilePath) {
    return -1;
  }

  return files.findIndex((file) => file.path === selectedFilePath);
}

function getNextFilePath(
  files: ReadonlyArray<ChangedFile>,
  selectedFilePath: string | null,
  direction: 'next' | 'previous',
): string | null {
  if (files.length === 0) {
    return null;
  }

  const currentIndex = getFileIndexByPath(files, selectedFilePath);
  if (currentIndex === -1) {
    return files[0]?.path ?? null;
  }

  if (direction === 'next') {
    return files[Math.min(files.length - 1, currentIndex + 1)]?.path ?? null;
  }

  return files[Math.max(0, currentIndex - 1)]?.path ?? null;
}

function getCurrentRevisionId(
  currentMode: ReviewDiffMode,
  worktreePath: string,
  branchName: string,
  snapshot: TaskReviewSnapshot | undefined,
): string {
  switch (currentMode) {
    case 'all':
      return snapshot?.revisionId ?? `${currentMode}:${worktreePath}:${branchName}:none`;
    case 'branch':
    case 'staged':
    case 'unstaged':
      return `${currentMode}:${worktreePath}:${branchName}:${snapshot?.revisionId ?? 'none'}`;
  }

  return assertNever(currentMode, 'Unhandled review diff mode');
}

export function createReviewPanelController(options: ReviewPanelControllerOptions): {
  clearDiff: () => void;
  currentRevisionId: Accessor<string>;
  diff: Accessor<FileDiffResult | null>;
  fetchDiff: (file: ChangedFile) => Promise<void>;
  fetchFiles: (request: TaskReviewFilesRequest, currentMode: ReviewDiffMode) => Promise<void>;
  files: Accessor<ChangedFile[]>;
  loading: Accessor<boolean>;
  mode: Accessor<ReviewDiffMode>;
  reviewDiffRequest: Accessor<TaskReviewDiffRequest>;
  selectNextFile: (files: ReadonlyArray<ChangedFile>) => void;
  selectPreviousFile: (files: ReadonlyArray<ChangedFile>) => void;
  selectedFilePath: Accessor<string | null>;
  setMode: (mode: ReviewDiffMode) => void;
  setSelectedFilePath: (path: string | null) => void;
  sideBySide: Accessor<boolean>;
  toggleSideBySide: () => void;
  syncSelectedFilePath: (files: ReadonlyArray<ChangedFile>) => void;
} {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  const [selectedFilePath, setSelectedFilePath] = createSignal<string | null>(null);
  const [mode, setMode] = createSignal<ReviewDiffMode>('all');
  const [sideBySide, setSideBySide] = createSignal(false);
  const [diff, setDiff] = createSignal<FileDiffResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const reviewDiffRequest = createMemo(() =>
    createTaskReviewDiffRequest({
      branchName: options.branchName(),
      projectRoot: options.projectRoot?.(),
      worktreePath: options.worktreePath(),
    }),
  );
  const currentRevisionId = createMemo(() => {
    return getCurrentRevisionId(
      mode(),
      options.worktreePath(),
      options.branchName(),
      options.getReviewSnapshot(),
    );
  });
  const fileRequestGuard = createAsyncRequestGuard(() => currentRevisionId());
  const diffRequestGuard = createAsyncRequestGuard(() => currentRevisionId());

  function clearDiff(): void {
    setDiff(null);
    setLoading(false);
  }

  async function fetchFiles(
    request: TaskReviewFilesRequest,
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
      const result = await fetchTaskFileDiff(reviewDiffRequest(), file);
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

  function syncSelectedFilePath(currentFiles: ReadonlyArray<ChangedFile>): void {
    const currentSelectedFilePath = selectedFilePath();
    if (getFileIndexByPath(currentFiles, currentSelectedFilePath) !== -1) {
      return;
    }

    setSelectedFilePath(currentFiles[0]?.path ?? null);
  }

  function selectNextFile(currentFiles: ReadonlyArray<ChangedFile>): void {
    setSelectedFilePath(getNextFilePath(currentFiles, selectedFilePath(), 'next'));
  }

  function selectPreviousFile(currentFiles: ReadonlyArray<ChangedFile>): void {
    setSelectedFilePath(getNextFilePath(currentFiles, selectedFilePath(), 'previous'));
  }

  return {
    clearDiff,
    currentRevisionId,
    diff,
    fetchDiff,
    fetchFiles,
    files,
    loading,
    mode,
    reviewDiffRequest,
    selectNextFile,
    selectPreviousFile,
    selectedFilePath,
    setMode: (nextMode) => {
      setMode(nextMode);
      clearDiff();
      setSelectedFilePath(null);
    },
    setSelectedFilePath,
    sideBySide,
    syncSelectedFilePath,
    toggleSideBySide: () => setSideBySide((current) => !current),
  };
}
