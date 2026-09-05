import { describe, expect, it } from 'vitest';

import {
  isResolveTaskShellSessionAmbiguityRequest,
  isResolveTaskShellSessionAmbiguityResult,
  isRetryTaskShellSessionOperationRequest,
  isRetryTaskShellSessionOperationResult,
  isTaskShellSessionOperationReplay,
  reduceTaskShellSessionOperationReplay,
  type TaskShellSessionOperationReplay,
} from './task-shell-session-operation';

const OPERATION_CAPABILITY = Buffer.alloc(32, 0x22).toString('base64url');

function replay(
  overrides: Partial<TaskShellSessionOperationReplay> = {},
): TaskShellSessionOperationReplay {
  return {
    current: {
      catalogVersion: 3,
      serverInstanceId: 'server-1',
      session: null,
      task: null,
      taskClosing: false,
      taskState: 'removed',
      workspaceRevision: 7,
    },
    disposition: { kind: 'attempted-no-replay', reason: 'running-at-ack' },
    identity: {
      committedWorkspaceRevision: 7,
      creationOperationId: 'creation-1',
      expectedGeneration: 0,
      operationId: 'shell-operation-1',
      sessionId: 'shell-1',
      taskId: 'task-1',
    },
    phase: 'running',
    recordVersion: 4,
    replayKind: 'full',
    ...overrides,
  } as TaskShellSessionOperationReplay;
}

describe('task shell session operation domain', () => {
  it('validates exact retry and ambiguity request shapes', () => {
    expect(
      isRetryTaskShellSessionOperationRequest({
        action: 'retry-same-tuple',
        expectedRecordVersion: 4,
        operationCapability: OPERATION_CAPABILITY,
        operationId: 'shell-operation-1',
      }),
    ).toBe(true);
    expect(
      isRetryTaskShellSessionOperationRequest({
        action: 'retry-same-tuple',
        expectedRecordVersion: 4,
        extra: true,
        operationCapability: OPERATION_CAPABILITY,
        operationId: 'shell-operation-1',
      }),
    ).toBe(false);
    expect(
      isResolveTaskShellSessionAmbiguityRequest({
        action: 'adopt-if-exact-running',
        expectedRecordVersion: 4,
        operationId: 'shell-operation-1',
      }),
    ).toBe(true);
    expect(
      isResolveTaskShellSessionAmbiguityRequest({
        action: 'adopt-running',
        expectedRecordVersion: 4,
        operationId: 'shell-operation-1',
      }),
    ).toBe(false);
  });

  it('validates tuple-correlated replays and result envelopes', () => {
    const value = replay();
    expect(isTaskShellSessionOperationReplay(value)).toBe(true);
    expect(
      isRetryTaskShellSessionOperationResult({ outcome: 'replayed', shellLaunch: value }),
    ).toBe(true);
    expect(
      isResolveTaskShellSessionAmbiguityResult({ outcome: 'adopted', shellLaunch: value }),
    ).toBe(true);
    expect(
      isTaskShellSessionOperationReplay({
        ...value,
        current: {
          ...value.current,
          session: { generation: 1, sessionId: 'shell-1', state: 'running' },
        },
      }),
    ).toBe(false);
  });

  it('selects monotonic record/catalog versions without allowing tuple drift', () => {
    const current = replay();
    const newer = replay({
      current: { ...current.current, catalogVersion: 5 },
      recordVersion: 5,
    });
    expect(reduceTaskShellSessionOperationReplay(current, newer)).toEqual(newer);
    expect(
      reduceTaskShellSessionOperationReplay(
        newer,
        replay({ current: { ...current.current, catalogVersion: 6 }, recordVersion: 4 }),
      ),
    ).toMatchObject({ current: { catalogVersion: 6 }, recordVersion: 5 });
    expect(() =>
      reduceTaskShellSessionOperationReplay(
        current,
        replay({
          identity: { ...current.identity, expectedGeneration: 1 },
        }),
      ),
    ).toThrow('identity changed');
  });
});
