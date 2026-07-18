import {
  countCoordinatorWorkflowPendingApprovals,
  type CoordinatorRunSnapshot,
} from '../domain/coordinator';

export interface CoordinatorTaskAttentionSummary {
  budgetExhaustedWorkflowCount: number;
  pendingApprovalCount: number;
  staleAfterRestore: boolean;
}

// Compact projection for the default task-presentation path. Keep this policy
// independent from the full coordinator inspector model so ordinary task
// panels do not load workflow rendering and action-model code.
export function getCoordinatorTaskAttentionSummary(
  run: CoordinatorRunSnapshot,
): CoordinatorTaskAttentionSummary {
  const workflows = run.workflows ?? [];
  return {
    budgetExhaustedWorkflowCount: workflows.filter(
      (workflow) => workflow.execution?.budget?.exhausted !== undefined,
    ).length,
    pendingApprovalCount: workflows.reduce(
      (count, workflow) => count + countCoordinatorWorkflowPendingApprovals(workflow),
      0,
    ),
    staleAfterRestore: run.status === 'stale-after-restore',
  };
}
