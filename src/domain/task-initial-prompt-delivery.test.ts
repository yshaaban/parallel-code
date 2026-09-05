import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createManualInitialPromptRateBucket,
  consumeManualInitialPromptRateToken,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  getManualInitialPromptSendRecovery,
  isResolveManualInitialPromptSendAmbiguityResult,
  isReviseTaskInitialPromptDraftRequest,
  isSendTaskInitialPromptManuallyRequest,
  isSendTaskInitialPromptManuallyResult,
  isTaskInitialPromptDeliveryProjection,
  isManualInitialPromptSendTerminalPhase,
  isTaskInitialPromptDraftWithinLimit,
  reduceTaskInitialPromptDelivery,
  sha256Hex,
  TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES,
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  type TaskInitialPromptDeliverySnapshot,
} from './task-initial-prompt-delivery.js';

function snapshot(
  overrides: Partial<TaskInitialPromptDeliverySnapshot> = {},
): TaskInitialPromptDeliverySnapshot {
  return {
    agentId: 'agent-1',
    attempts: 0,
    createdAt: '2026-08-04T00:00:00.000Z',
    deliveryId: 'delivery-1',
    status: 'waiting-agent-session',
    taskId: 'task-1',
    updatedAt: '2026-08-04T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('initial prompt delivery domain contract', () => {
  it('matches the platform SHA-256 and exact manual operation derivation', () => {
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    const fingerprint = 'ab'.repeat(32);
    const expected = createHash('sha256')
      .update(['initial-prompt-manual-v1', 'delivery-1', '7', fingerprint].join('\0'))
      .digest('base64url');
    expect(
      deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: fingerprint,
        acknowledgedEditRevision: 7,
        deliveryId: 'delivery-1',
      }),
    ).toBe(`manual:v1:${expected}`);
  });

  it('fingerprints the exact task, agent, policy, and Unicode draft', () => {
    const first = deriveTaskInitialPromptDraftFingerprint({
      agentId: 'agent-1',
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
      text: 'ship 🚀',
    });
    const second = deriveTaskInitialPromptDraftFingerprint({
      agentId: 'agent-2',
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
      text: 'ship 🚀',
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });

  it('enforces one UTF-8 draft limit', () => {
    expect(
      isTaskInitialPromptDraftWithinLimit('a'.repeat(TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES)),
    ).toBe(true);
    expect(
      isTaskInitialPromptDraftWithinLimit(
        '🚀'.repeat(TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES / 4 + 1),
      ),
    ).toBe(false);
  });

  it('guards exact renderer draft, send, and projection contracts', () => {
    const fingerprint = 'ab'.repeat(32);
    const manualSendOperationId = deriveManualInitialPromptSendOperationId({
      acknowledgedDraftFingerprint: fingerprint,
      acknowledgedEditRevision: 3,
      deliveryId: 'delivery-1',
    });
    const sendRequest = {
      action: { kind: 'send' },
      agentId: 'agent-1',
      confirmPossiblePriorAutomaticWrite: false,
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 4,
      expectedDraftFingerprint: fingerprint,
      expectedEditRevision: 3,
      manualSendOperationId,
      taskId: 'task-1',
    };
    expect(isSendTaskInitialPromptManuallyRequest(sendRequest)).toBe(true);
    expect(
      isSendTaskInitialPromptManuallyRequest({
        ...sendRequest,
        manualSendOperationId: 'manual:v1:forged',
      }),
    ).toBe(false);
    expect(
      isReviseTaskInitialPromptDraftRequest({
        editOperationId: 'edit-1',
        expectedDraftFingerprint: fingerprint,
        expectedEditRevision: 3,
        revisedText: 'updated\ntext',
        sourceDeliveryId: 'delivery-1',
        taskId: 'task-1',
      }),
    ).toBe(true);
    expect(
      isReviseTaskInitialPromptDraftRequest({
        editOperationId: 'edit-1',
        expectedDraftFingerprint: fingerprint,
        expectedEditRevision: 3,
        revisedText: '\ud800',
        sourceDeliveryId: 'delivery-1',
        taskId: 'task-1',
      }),
    ).toBe(false);

    const projectionFingerprint = deriveTaskInitialPromptDraftFingerprint({
      agentId: 'agent-1',
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: 'task-1',
      text: 'updated text',
    });
    const projection = {
      current: {
        catalogVersion: 3,
        serverInstanceId: 'server-1',
        taskClosing: false,
        taskState: 'present',
      },
      currentDraft: {
        editRevision: 3,
        fingerprint: projectionFingerprint,
        mode: 'manual-only',
        text: 'updated text',
        workspaceRevision: 9,
      },
      delivery: snapshot({ status: 'manual-required', version: 4 }),
    };
    expect(isTaskInitialPromptDeliveryProjection(projection)).toBe(true);
    expect(
      isTaskInitialPromptDeliveryProjection({ ...projection, deletionOperationId: 'private' }),
    ).toBe(false);

    const operation = {
      acknowledgedDraftFingerprint: projectionFingerprint,
      acknowledgedEditRevision: 3,
      agentId: 'agent-1',
      attempt: 1,
      createdAt: '2026-08-04T00:00:00.000Z',
      deliveryId: 'delivery-1',
      expectedAgentGeneration: 4,
      manualSendOperationId: deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: projectionFingerprint,
        acknowledgedEditRevision: 3,
        deliveryId: 'delivery-1',
      }),
      phase: 'confirmation-required',
      possiblePriorAutomaticWrite: true,
      taskId: 'task-1',
      updatedAt: '2026-08-04T00:00:01.000Z',
      version: 1,
    } as const;
    const operationResult = {
      current: projection.current,
      currentDraft: projection.currentDraft,
      delivery: projection.delivery,
      kind: 'operation',
      operation,
      recovery: {
        kind: 'confirm-possible-prior-automatic-write',
        manualSendOperationId: operation.manualSendOperationId,
      },
      replayed: false,
    };
    expect(isSendTaskInitialPromptManuallyResult(operationResult)).toBe(true);
    expect(
      isSendTaskInitialPromptManuallyResult({
        ...operationResult,
        operation: { ...operation, taskId: 'other-task' },
      }),
    ).toBe(false);

    expect(
      isResolveManualInitialPromptSendAmbiguityResult({
        kind: 'resolved',
        projection,
        replayed: false,
      }),
    ).toBe(false);
    expect(
      isResolveManualInitialPromptSendAmbiguityResult({
        kind: 'resolved',
        projection: {
          ...projection,
          manualSendOperation: { ...operation, phase: 'reconciled' },
        },
        replayed: false,
      }),
    ).toBe(true);
  });

  it('allows two automatic dispatches only after positive absence evidence', () => {
    let state = snapshot({ status: 'waiting-ready', targetGeneration: 3 });
    for (const event of [
      { kind: 'ready-stable' },
      { kind: 'lease-acquired' },
      { kind: 'write-accepted' },
    ] as const) {
      state = reduceTaskInitialPromptDelivery(state, event, '2026-08-04T00:00:01.000Z').snapshot;
    }
    expect(state).toMatchObject({ attempts: 1, status: 'verifying' });
    state = reduceTaskInitialPromptDelivery(
      state,
      { kind: 'evidence-absence-proven' },
      '2026-08-04T00:00:02.000Z',
    ).snapshot;
    expect(state.status).toBe('retry-wait');
    state = reduceTaskInitialPromptDelivery(
      state,
      { kind: 'write-started' },
      '2026-08-04T00:00:03.000Z',
    ).snapshot;
    state = reduceTaskInitialPromptDelivery(
      state,
      { kind: 'write-accepted' },
      '2026-08-04T00:00:04.000Z',
    ).snapshot;
    expect(state).toMatchObject({ attempts: 2, status: 'verifying' });
    expect(
      reduceTaskInitialPromptDelivery(
        state,
        { kind: 'evidence-absence-proven' },
        '2026-08-04T00:00:05.000Z',
      ).snapshot,
    ).toMatchObject({ attempts: 2, reason: 'retry-not-safe', status: 'manual-required' });
  });

  it.each([
    ['waiting-ready', 0],
    ['waiting-lease', 0],
    ['verifying', 1],
  ] as const)(
    'never treats an inconclusive %s deadline as delivery or safe absence',
    (status, attempts) => {
      expect(
        reduceTaskInitialPromptDelivery(
          snapshot({ attempts, status }),
          { kind: 'verification-inconclusive' },
          '2026-08-04T00:00:05.000Z',
        ).snapshot,
      ).toMatchObject({ reason: 'verification-inconclusive', status: 'manual-required' });
    },
  );

  it('fails a durable write intent closed when its outcome is ambiguous', () => {
    expect(
      reduceTaskInitialPromptDelivery(
        snapshot({ status: 'writing' }),
        { kind: 'write-outcome-ambiguous' },
        '2026-08-04T00:00:05.000Z',
      ).snapshot,
    ).toMatchObject({
      attempts: 0,
      reason: 'backend-recovered-ambiguous-write',
      status: 'manual-required',
    });
  });

  it('fails a deferred retry closed when its readiness guard is no longer safe', () => {
    expect(
      reduceTaskInitialPromptDelivery(
        snapshot({ attempts: 1, status: 'retry-wait' }),
        { kind: 'retry-not-safe' },
        '2026-08-04T00:00:05.000Z',
      ).snapshot,
    ).toMatchObject({ attempts: 1, reason: 'retry-not-safe', status: 'manual-required' });
  });

  it('cancels pre-write edits/closing and makes post-write changes manual-required', () => {
    expect(
      reduceTaskInitialPromptDelivery(
        snapshot({ status: 'waiting-ready' }),
        { kind: 'edit-accepted' },
        '2026-08-04T00:00:01.000Z',
      ).snapshot,
    ).toMatchObject({ reason: 'cancelled-before-write', status: 'cancelled' });
    expect(
      reduceTaskInitialPromptDelivery(
        snapshot({ attempts: 1, status: 'verifying' }),
        { kind: 'task-closing' },
        '2026-08-04T00:00:01.000Z',
      ).snapshot,
    ).toMatchObject({ reason: 'task-closing', status: 'manual-required' });
  });

  it('maps every safe retry category to an explicit same-operation recovery', () => {
    expect(
      getManualInitialPromptSendRecovery({
        failedAttempt: 2,
        issue: { code: 'agent-not-ready' },
        manualSendOperationId: 'manual-1',
      }),
    ).toEqual({
      failedAttempt: 2,
      kind: 'retry-proven-not-sent',
      manualSendOperationId: 'manual-1',
    });
    expect(
      getManualInitialPromptSendRecovery({
        failedAttempt: 2,
        issue: { code: 'write-outcome-ambiguous' },
        manualSendOperationId: 'manual-1',
      }),
    ).toEqual({
      automaticRetryAllowed: false,
      kind: 'inspect-terminal-and-copy-exact-draft',
    });
    expect(isManualInitialPromptSendTerminalPhase('manual-reconciliation-required')).toBe(true);
  });

  it('rate limits only admissions and refills without timers', () => {
    let bucket = createManualInitialPromptRateBucket(1_000);
    for (let count = 0; count < 3; count += 1) {
      const result = consumeManualInitialPromptRateToken(bucket, 1_000);
      expect(result.kind).toBe('admitted');
      bucket = result.bucket;
    }
    const limited = consumeManualInitialPromptRateToken(bucket, 1_000);
    expect(limited).toMatchObject({ kind: 'rate-limited', retryAfterMs: 5_000 });
    expect(consumeManualInitialPromptRateToken(limited.bucket, 6_000).kind).toBe('admitted');
  });
});
