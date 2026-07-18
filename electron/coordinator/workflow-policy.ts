import {
  COORDINATOR_LIMITS,
  type CoordinatorWorkflowAppendPolicySnapshot,
  type CoordinatorWorkflowPolicyPayload,
  type CoordinatorWorkflowPolicySnapshot,
} from '../../src/domain/coordinator.js';

export const DEFAULT_WORKFLOW_CONCURRENCY = 3;

// This module owns backend defaults and initial concurrency derivation only. Untrusted payload
// validation stays at the gateway, and effective budget clamping stays with the domain helpers.
const DEFAULT_WORKFLOW_POLICY: CoordinatorWorkflowPolicySnapshot = {
  continueOnFailure: true,
  maxConcurrentLanes: COORDINATOR_LIMITS.maxActiveSubtasksPerRun,
  maxIterationsPerBranch: 3,
  maxOutputBytesPerLane: COORDINATOR_LIMITS.snapshotMaxBytes,
  maxTotalLanes: COORDINATOR_LIMITS.maxWorkflowLanes,
  maxTotalRetries: COORDINATOR_LIMITS.maxWorkflowTotalRetries,
  maxTotalSteps: COORDINATOR_LIMITS.maxWorkflowTotalSteps,
  maxWallClockMs: COORDINATOR_LIMITS.workflowDefaultWallClockMs,
  resultRequired: true,
  retryBackoffMs: 1_000,
  retryCount: 0,
  timeoutMs: COORDINATOR_LIMITS.workflowDefaultLaneTimeoutMs,
};

const DEFAULT_WORKFLOW_APPEND_POLICY: CoordinatorWorkflowAppendPolicySnapshot = {
  maxActionsPerDecision: COORDINATOR_LIMITS.maxWorkflowDecisionActionsPerResult,
  maxStepAppends: COORDINATOR_LIMITS.maxWorkflowStepAppends,
};

export function resolveCoordinatorWorkflowPolicy(
  policy: Partial<CoordinatorWorkflowPolicySnapshot> | undefined,
): CoordinatorWorkflowPolicySnapshot {
  return {
    ...DEFAULT_WORKFLOW_POLICY,
    ...(policy?.budgetHint !== undefined ? { budgetHint: policy.budgetHint } : {}),
    ...(policy?.continueOnFailure !== undefined
      ? { continueOnFailure: policy.continueOnFailure }
      : {}),
    ...(policy?.maxConcurrentLanes !== undefined
      ? { maxConcurrentLanes: policy.maxConcurrentLanes }
      : {}),
    ...(policy?.maxIterationsPerBranch !== undefined
      ? { maxIterationsPerBranch: policy.maxIterationsPerBranch }
      : {}),
    ...(policy?.maxOutputBytesPerLane !== undefined
      ? { maxOutputBytesPerLane: policy.maxOutputBytesPerLane }
      : {}),
    ...(policy?.maxTotalLanes !== undefined ? { maxTotalLanes: policy.maxTotalLanes } : {}),
    ...(policy?.maxTotalRetries !== undefined ? { maxTotalRetries: policy.maxTotalRetries } : {}),
    ...(policy?.maxTotalSteps !== undefined ? { maxTotalSteps: policy.maxTotalSteps } : {}),
    ...(policy?.maxWallClockMs !== undefined ? { maxWallClockMs: policy.maxWallClockMs } : {}),
    ...(policy?.requireDecisionApproval !== undefined
      ? { requireDecisionApproval: policy.requireDecisionApproval }
      : {}),
    ...(policy?.resultRequired !== undefined ? { resultRequired: policy.resultRequired } : {}),
    ...(policy?.retryBackoffMs !== undefined ? { retryBackoffMs: policy.retryBackoffMs } : {}),
    ...(policy?.retryCount !== undefined ? { retryCount: policy.retryCount } : {}),
    ...(policy?.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
  };
}

export function resolveCoordinatorWorkflowAppendPolicy(
  policy: Partial<CoordinatorWorkflowAppendPolicySnapshot> | undefined,
): CoordinatorWorkflowAppendPolicySnapshot {
  return {
    ...DEFAULT_WORKFLOW_APPEND_POLICY,
    ...(policy?.maxActionsPerDecision !== undefined
      ? { maxActionsPerDecision: policy.maxActionsPerDecision }
      : {}),
    ...(policy?.maxStepAppends !== undefined ? { maxStepAppends: policy.maxStepAppends } : {}),
  };
}

export function withCoordinatorWorkflowLaneConcurrency(
  policy: CoordinatorWorkflowPolicyPayload | undefined,
  laneCount: number,
): CoordinatorWorkflowPolicyPayload {
  return {
    maxConcurrentLanes: Math.max(DEFAULT_WORKFLOW_CONCURRENCY, laneCount),
    ...policy,
  };
}
