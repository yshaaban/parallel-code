import { describe, expect, it, vi } from 'vitest';

import type {
  PromptInputAdmissionCurrentState,
  PromptInputAdmissionExpectation,
} from '../../src/domain/task-prompt-input-admission.js';
import {
  createTaskPromptInputAdmissionService,
  evaluateTaskPromptInputAdmission,
} from './task-prompt-input-admission.js';

function createExpectation(
  overrides: Partial<PromptInputAdmissionExpectation> = {},
): PromptInputAdmissionExpectation {
  return {
    agentGeneration: 4,
    agentId: 'agent-1',
    controllerId: 'client-1',
    leaseGeneration: 8,
    leaseOwnerId: 'owner-1',
    purpose: 'ordinary-post-start',
    supervisionVersion: 12,
    taskId: 'task-1',
    ...overrides,
  };
}

function createCurrent(
  overrides: Partial<PromptInputAdmissionCurrentState> = {},
): PromptInputAdmissionCurrentState {
  return {
    agentGeneration: 4,
    state: 'idle-at-prompt',
    supervisionVersion: 12,
    taskId: 'task-1',
    ...overrides,
  };
}

describe('task prompt input admission', () => {
  it('preserves ordinary sends in every non-question supervision state', () => {
    for (const state of [
      'active',
      'idle-at-prompt',
      'quiet',
      'paused',
      'flow-controlled',
      'restoring',
      'exited-clean',
      'exited-error',
    ] as const) {
      expect(
        evaluateTaskPromptInputAdmission(
          createExpectation(),
          createCurrent({ state }),
          true,
          false,
        ),
      ).toBeNull();
    }
  });

  it('requires ready state only for initial delivery', () => {
    expect(
      evaluateTaskPromptInputAdmission(
        createExpectation({ purpose: 'initial-delivery' }),
        createCurrent({ state: 'active' }),
        true,
        false,
      ),
    ).toEqual({ kind: 'rejected-before-bytes', reason: 'agent-not-ready' });
    expect(
      evaluateTaskPromptInputAdmission(
        createExpectation({ purpose: 'initial-delivery' }),
        createCurrent({ state: 'idle-at-prompt' }),
        true,
        false,
      ),
    ).toBeNull();
  });

  it.each([
    [createCurrent({ state: 'awaiting-input' }), true, false, 'question-active'],
    [createCurrent({ agentGeneration: 5 }), true, false, 'agent-generation-changed'],
    [createCurrent({ supervisionVersion: 13 }), true, false, 'supervision-version-changed'],
    [createCurrent(), false, false, 'control-or-lease-lost'],
    [createCurrent(), true, true, 'task-closing'],
  ] as const)('rejects %s before bytes with %s', (current, leaseHeld, closing, reason) => {
    expect(
      evaluateTaskPromptInputAdmission(createExpectation(), current, leaseHeld, closing),
    ).toMatchObject({
      kind: 'rejected-before-bytes',
      reason,
    });
  });

  it('writes one or two frames only after the exact expectation passes', async () => {
    const writeFrame = vi.fn();
    const service = createTaskPromptInputAdmissionService({
      getCurrentState: () => createCurrent(),
      isLeaseHeld: () => true,
      sleep: () => Promise.resolve(),
      writeFrame,
    });
    service.bindTaskClosingResolver(() => false);

    await expect(
      service.admit(createExpectation(), { firstFrame: 'single frame' }),
    ).resolves.toEqual({
      admittedSupervisionVersion: 12,
      kind: 'accepted',
      lowLevelCallCount: 1,
    });
    await expect(
      service.admit(createExpectation(), {
        firstFrame: 'paste frame',
        submitDelayMs: 10,
        submitFrame: '\r',
      }),
    ).resolves.toEqual({
      admittedSupervisionVersion: 12,
      kind: 'accepted',
      lowLevelCallCount: 2,
    });
    expect(writeFrame.mock.calls).toEqual([
      ['agent-1', 'single frame'],
      ['agent-1', 'paste frame'],
      ['agent-1', '\r'],
    ]);
  });

  it('fails closed outside one server-lifecycle closing binding', async () => {
    const writeFrame = vi.fn();
    const service = createTaskPromptInputAdmissionService({
      getCurrentState: () => createCurrent(),
      isLeaseHeld: () => true,
      writeFrame,
    });

    await expect(
      service.admit(createExpectation(), { firstFrame: 'before binding' }),
    ).resolves.toEqual({
      kind: 'rejected-before-bytes',
      reason: 'task-closing',
    });

    const release = service.bindTaskClosingResolver(() => false);
    expect(() => service.bindTaskClosingResolver(() => false)).toThrow(
      'Task-prompt closing resolver is already bound',
    );
    await expect(
      service.admit(createExpectation(), { firstFrame: 'while bound' }),
    ).resolves.toMatchObject({
      kind: 'accepted',
    });

    release();
    await expect(
      service.admit(createExpectation(), { firstFrame: 'after release' }),
    ).resolves.toMatchObject({
      kind: 'rejected-before-bytes',
      reason: 'task-closing',
    });
    expect(writeFrame).toHaveBeenCalledOnce();
  });

  it('classifies a post-first-frame state transition as ambiguous', async () => {
    let current = createCurrent();
    const writeFrame = vi.fn(() => {
      current = createCurrent({ state: 'awaiting-input', supervisionVersion: 13 });
    });
    const service = createTaskPromptInputAdmissionService({
      getCurrentState: () => current,
      isLeaseHeld: () => true,
      sleep: () => Promise.resolve(),
      writeFrame,
    });
    service.bindTaskClosingResolver(() => false);

    await expect(
      service.admit(createExpectation(), {
        firstFrame: 'paste frame',
        submitDelayMs: 10,
        submitFrame: '\r',
      }),
    ).resolves.toEqual({
      admittedSupervisionVersion: 12,
      bytesMayHaveBeenAccepted: true,
      kind: 'outcome-ambiguous',
    });
    expect(writeFrame).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['delay failure', 'sleep'],
    ['authority recheck failure', 'recheck'],
  ] as const)('classifies a post-first-frame %s as ambiguous', async (_label, failurePoint) => {
    let writeCount = 0;
    const service = createTaskPromptInputAdmissionService({
      getCurrentState: () => {
        if (failurePoint === 'recheck' && writeCount > 0) {
          throw new Error('canonical state unavailable');
        }
        return createCurrent();
      },
      isLeaseHeld: () => true,
      sleep: () =>
        failurePoint === 'sleep'
          ? Promise.reject(new Error('timer unavailable'))
          : Promise.resolve(),
      writeFrame: () => {
        writeCount += 1;
      },
    });
    service.bindTaskClosingResolver(() => false);

    await expect(
      service.admit(createExpectation(), {
        firstFrame: 'paste frame',
        submitDelayMs: 10,
        submitFrame: '\r',
      }),
    ).resolves.toEqual({
      admittedSupervisionVersion: 12,
      bytesMayHaveBeenAccepted: true,
      kind: 'outcome-ambiguous',
    });
    expect(writeCount).toBe(1);
  });

  it('serializes concurrent admissions for the same agent', async () => {
    let releaseSleep!: () => void;
    const sleep = vi.fn(() => new Promise<void>((resolve) => (releaseSleep = resolve)));
    const writeFrame = vi.fn();
    const service = createTaskPromptInputAdmissionService({
      getCurrentState: () => createCurrent(),
      isLeaseHeld: () => true,
      sleep,
      writeFrame,
    });
    service.bindTaskClosingResolver(() => false);

    const first = service.admit(createExpectation(), {
      firstFrame: 'first paste',
      submitDelayMs: 10,
      submitFrame: '\r',
    });
    const second = service.admit(createExpectation(), { firstFrame: 'second prompt' });
    await vi.waitFor(() => expect(writeFrame).toHaveBeenCalledTimes(1));
    expect(writeFrame).toHaveBeenLastCalledWith('agent-1', 'first paste');

    releaseSleep();
    await first;
    await second;
    expect(writeFrame.mock.calls).toEqual([
      ['agent-1', 'first paste'],
      ['agent-1', '\r'],
      ['agent-1', 'second prompt'],
    ]);
  });

  it('never rewrites a low-level throw as a proven zero-byte rejection', async () => {
    const service = createTaskPromptInputAdmissionService({
      getCurrentState: () => createCurrent(),
      isLeaseHeld: () => true,
      writeFrame: () => {
        throw new Error('write boundary failed');
      },
    });
    service.bindTaskClosingResolver(() => false);

    await expect(service.admit(createExpectation(), { firstFrame: 'prompt' })).resolves.toEqual({
      admittedSupervisionVersion: 12,
      bytesMayHaveBeenAccepted: true,
      kind: 'outcome-ambiguous',
    });
  });
});
