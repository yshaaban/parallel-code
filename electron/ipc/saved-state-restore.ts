import { scheduleBackgroundReconciliation } from './backend-work-queue.js';
import type { PersistedDerivedStateFile } from './derived-state-persistence.js';
import { syncConfiguredBaseBranchesFromSavedState } from './git-branch.js';
import { hydrateGitStatusSnapshots } from './git-status-state.js';
import {
  findRegisteredGitWatcherRequestForTask,
  getSavedTaskWatcherRequests,
  refreshGitStatusWorkflow,
  restoreSavedTaskGitStatusMonitoring,
  type GitStatusWorkflowContext,
} from './git-status-workflows.js';
import type { SavedStateDocument } from './saved-state-document.js';
import {
  hydrateTaskConvergenceSnapshots,
  restoreSavedTaskConvergence,
} from './task-convergence-state.js';
import { hydrateTaskReviewSnapshots, restoreSavedTaskReview } from './task-review-state.js';
import {
  hydrateTaskReviewSignalsSnapshots,
  restoreSavedTaskReviewSignals,
} from './task-review-signals.js';
import { hydrateTaskStepsSummarySnapshots, restoreSavedTaskSteps } from './task-steps.js';
import { syncTaskWorkflowWorktreesFromSavedState } from './task-workflows.js';

// Shared shell-agnostic boot restore. Both runtime shells (Electron main and
// the standalone browser server) compose this path: sync metadata registries,
// start watchers without scheduling blanket refreshes, hydrate persisted
// derived snapshots behind exact identity filters, and hand every restored
// task to the background reconciliation sweep. Recomputation stays
// demand-driven through the backend work queue.

export interface RestoreBackendDerivedStateOptions {
  context: GitStatusWorkflowContext;
  derivedState: PersistedDerivedStateFile | null;
  document: SavedStateDocument;
}

export function restoreBackendDerivedState(options: RestoreBackendDerivedStateOptions): void {
  const { context, derivedState, document } = options;

  syncConfiguredBaseBranchesFromSavedState(document);
  syncTaskWorkflowWorktreesFromSavedState(document);
  restoreSavedTaskConvergence(document);
  restoreSavedTaskReview(document);
  restoreSavedTaskReviewSignals(document);

  restoreSavedTaskGitStatusMonitoring(context, document);
  restoreSavedTaskSteps(document);

  const watcherRequests = getSavedTaskWatcherRequests(document);
  if (derivedState) {
    const watchedWorktreePaths = new Set(watcherRequests.map((request) => request.worktreePath));
    hydrateGitStatusSnapshots(
      derivedState.gitStatus.filter((snapshot) => watchedWorktreePaths.has(snapshot.worktreePath)),
    );
    hydrateTaskConvergenceSnapshots(derivedState.taskConvergence);
    hydrateTaskReviewSnapshots(derivedState.taskReview);
    hydrateTaskReviewSignalsSnapshots(derivedState.taskReviewSignals);
    hydrateTaskStepsSummarySnapshots(derivedState.taskSteps);
  }

  scheduleBackgroundReconciliation(
    watcherRequests.map((request) => request.taskId),
    async (taskId) => {
      const request = findRegisteredGitWatcherRequestForTask(taskId);
      if (!request) {
        return;
      }

      await refreshGitStatusWorkflow(
        context,
        request.worktreePath,
        request.baseBranch,
        'background',
      );
    },
  );
}
