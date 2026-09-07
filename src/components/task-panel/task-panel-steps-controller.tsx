import {
  ErrorBoundary,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  type Accessor,
} from 'solid-js';
import type { ChangedFile } from '../../ipc/types';
import {
  fetchTaskStepsSnapshotForTask,
  jumpToTaskStepTarget,
  prefillTaskStepNextAction,
} from '../../app/task-steps';
import { getTaskStepsSnapshot, getTaskStepsSummary } from '../../store/task-steps';
import type { Task } from '../../store/types';
import type { TaskStepEntry } from '../../domain/task-steps';
import { isTerminalTask } from '../../domain/task-mode';
import type { PanelChild } from '../ResizablePanel';
import { lazyNamed } from '../../lib/lazy-named';

// The optional view is cold; fetching, focus intent and stable panel sizing stay in this owner.
const TaskStepsSection = lazyNamed(() => import('./TaskStepsSection'), 'TaskStepsSection');

interface TaskPanelStepsControllerOptions {
  focusedPanel: Accessor<string | null>;
  isActive: Accessor<boolean>;
  onDiffFileClick: (file: ChangedFile | null) => void;
  setTaskFocusedPanel: (taskId: string, panelId: string) => void;
  task: Accessor<Task>;
}

function createChangedFile(filePath: string): ChangedFile {
  return {
    committed: false,
    lines_added: 0,
    lines_removed: 0,
    path: filePath,
    status: 'modified',
  };
}

function getTaskStepsLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Failed to load task steps.';
}

export function createTaskPanelStepsController(options: TaskPanelStepsControllerOptions): {
  stepsSection: Accessor<PanelChild | null>;
} {
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [naturalHeight, setNaturalHeight] = createSignal(96);
  let attemptedRequestKey: string | undefined;
  let previouslyActive = false;

  const summary = createMemo(() => getTaskStepsSummary(options.task().id) ?? null);
  const snapshot = createMemo(() => getTaskStepsSnapshot(options.task().id) ?? null);

  async function loadTaskStepsSnapshot(): Promise<void> {
    if (loading()) {
      return;
    }

    setLoading(true);
    try {
      await fetchTaskStepsSnapshotForTask(options.task().id);
      setLoadError(null);
    } catch (error) {
      setLoadError(getTaskStepsLoadErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    const active = options.isActive();
    if (active && !previouslyActive) attemptedRequestKey = undefined;
    previouslyActive = active;
    if (options.task().stepsTracking !== true) {
      attemptedRequestKey = undefined;
      return;
    }

    const shouldLoad = active || options.focusedPanel() === 'steps';
    if (!shouldLoad) {
      attemptedRequestKey = undefined;
      return;
    }

    const currentSummary = summary();
    const currentSnapshot = snapshot();
    if (
      currentSummary !== null &&
      currentSnapshot !== null &&
      currentSummary.revisionId === currentSnapshot.revisionId
    ) {
      return;
    }

    // Completion may admit one newer revision observed in flight, never retry the same failure.
    if (loading()) return;
    const requestKey = JSON.stringify([options.task().id, currentSummary?.revisionId ?? null]);
    if (attemptedRequestKey === requestKey) return;
    attemptedRequestKey = requestKey;
    untrack(() => void loadTaskStepsSnapshot());
  });

  function handleFocusSteps(): void {
    options.setTaskFocusedPanel(options.task().id, 'steps');
  }

  function handleFileClick(filePath: string): void {
    options.onDiffFileClick(createChangedFile(filePath));
  }

  function handleNextClick(text: string): void {
    prefillTaskStepNextAction(options.task().id, text);
  }

  function handleJumpToStep(step: TaskStepEntry): void {
    jumpToTaskStepTarget(options.task().id, step);
  }

  const stepsSection = createMemo<PanelChild | null>(() => {
    if (options.task().stepsTracking !== true) {
      return null;
    }

    return {
      id: 'steps',
      initialSize: 96,
      minSize: 72,
      stable: true,
      requestSize: () => naturalHeight(),
      content: () => (
        <ErrorBoundary
          fallback={
            <div role="alert">Steps could not be loaded. Reload the page to try again.</div>
          }
        >
          <Suspense fallback={<div role="status">Loading Steps…</div>}>
            <TaskStepsSection
              loadError={loadError}
              loading={loading}
              onFileClick={handleFileClick}
              onFocusSteps={handleFocusSteps}
              onJumpToStep={handleJumpToStep}
              onNaturalHeight={setNaturalHeight}
              onNextClick={isTerminalTask(options.task()) ? undefined : handleNextClick}
              snapshot={snapshot}
              summary={summary}
              taskId={options.task().id}
            />
          </Suspense>
        </ErrorBoundary>
      ),
    };
  });

  return {
    stepsSection,
  };
}
