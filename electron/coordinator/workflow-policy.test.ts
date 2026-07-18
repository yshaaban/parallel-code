import { describe, expect, it } from 'vitest';

import { COORDINATOR_LIMITS } from '../../src/domain/coordinator.js';
import {
  DEFAULT_WORKFLOW_CONCURRENCY,
  resolveCoordinatorWorkflowAppendPolicy,
  resolveCoordinatorWorkflowPolicy,
  withCoordinatorWorkflowLaneConcurrency,
} from './workflow-policy.js';

describe('coordinator workflow policy', () => {
  it('resolves workflow defaults in one canonical policy owner', () => {
    expect(resolveCoordinatorWorkflowPolicy(undefined)).toEqual({
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
    });
  });

  it('preserves explicit false and zero-valued workflow overrides', () => {
    expect(
      resolveCoordinatorWorkflowPolicy({
        continueOnFailure: false,
        maxConcurrentLanes: 0,
        requireDecisionApproval: false,
        resultRequired: false,
        retryBackoffMs: 0,
        retryCount: 0,
        timeoutMs: 0,
      }),
    ).toMatchObject({
      continueOnFailure: false,
      maxConcurrentLanes: 0,
      requireDecisionApproval: false,
      resultRequired: false,
      retryBackoffMs: 0,
      retryCount: 0,
      timeoutMs: 0,
    });
    expect(
      resolveCoordinatorWorkflowPolicy({
        maxConcurrentLanes: undefined,
      } as unknown as Parameters<typeof resolveCoordinatorWorkflowPolicy>[0]),
    ).toMatchObject({
      maxConcurrentLanes: COORDINATOR_LIMITS.maxActiveSubtasksPerRun,
    });
  });

  it('resolves append defaults and explicit limits', () => {
    expect(resolveCoordinatorWorkflowAppendPolicy(undefined)).toEqual({
      maxActionsPerDecision: COORDINATOR_LIMITS.maxWorkflowDecisionActionsPerResult,
      maxStepAppends: COORDINATOR_LIMITS.maxWorkflowStepAppends,
    });
    expect(
      resolveCoordinatorWorkflowAppendPolicy({
        maxActionsPerDecision: 0,
        maxStepAppends: 2,
      }),
    ).toEqual({
      maxActionsPerDecision: 0,
      maxStepAppends: 2,
    });
  });

  it('canonicalizes policy objects to known fields', () => {
    const policy = resolveCoordinatorWorkflowPolicy({
      continueOnFailure: false,
      unknownPolicy: 'drop-me',
    } as unknown as Parameters<typeof resolveCoordinatorWorkflowPolicy>[0]);
    const appendPolicy = resolveCoordinatorWorkflowAppendPolicy({
      maxStepAppends: 2,
      unknownAppendPolicy: 'drop-me',
    } as unknown as Parameters<typeof resolveCoordinatorWorkflowAppendPolicy>[0]);

    expect(policy).toMatchObject({ continueOnFailure: false });
    expect(policy).not.toHaveProperty('unknownPolicy');
    expect(appendPolicy).toEqual({
      maxActionsPerDecision: COORDINATOR_LIMITS.maxWorkflowDecisionActionsPerResult,
      maxStepAppends: 2,
    });
  });

  it('derives lane concurrency once while preserving a caller override for admission checks', () => {
    expect(withCoordinatorWorkflowLaneConcurrency(undefined, 7)).toEqual({
      maxConcurrentLanes: 7,
    });
    expect(
      withCoordinatorWorkflowLaneConcurrency(
        {
          maxConcurrentLanes: 2,
          retryCount: 1,
        },
        DEFAULT_WORKFLOW_CONCURRENCY + 2,
      ),
    ).toEqual({
      maxConcurrentLanes: 2,
      retryCount: 1,
    });
  });
});
