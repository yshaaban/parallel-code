import { describe, expect, it, vi } from 'vitest';

import type { AgentSupervisionSnapshot } from '../../src/domain/server-state.js';
import {
  createOrdinaryTaskPromptInputHandler,
  readTaskPromptInputAdmissionCurrentState,
  type OrdinaryTaskPromptInputHandlerDependencies,
  type TaskPromptAgentMetadata,
} from './task-prompt-input-handler.js';
import { createTaskPromptInputAdmissionService } from './task-prompt-input-admission.js';

function createSupervision(
  overrides: Partial<AgentSupervisionSnapshot> = {},
): AgentSupervisionSnapshot {
  return {
    agentId: 'agent-1',
    attentionReason: null,
    generation: 4,
    isShell: false,
    lastOutputAt: 1,
    preview: '',
    state: 'idle-at-prompt',
    supervisionVersion: 12,
    taskId: 'task-1',
    updatedAt: 1,
    ...overrides,
  };
}

function createHarness() {
  let supervision: AgentSupervisionSnapshot | null = createSupervision();
  let generation: number | null = 4;
  let metadata: TaskPromptAgentMetadata | null = {
    generation: 4,
    isShell: false,
    taskId: 'task-1',
  };
  let closing = false;
  let leaseHeld = true;
  const sleep = vi.fn(() => Promise.resolve());
  const writeFrame = vi.fn();
  let onWrite: (() => void) | null = null;
  let supervisionReader = () => supervision;
  const currentStateDependencies = {
    getAgentGeneration: () => generation,
    getAgentMetadata: () => metadata,
    getSupervisionSnapshot: () => supervisionReader(),
  };
  const admission = createTaskPromptInputAdmissionService({
    getCurrentState: (expectation) =>
      readTaskPromptInputAdmissionCurrentState(currentStateDependencies, expectation),
    isLeaseHeld: () => leaseHeld,
    sleep,
    writeFrame: (...args) => {
      writeFrame(...args);
      onWrite?.();
    },
  });
  admission.bindTaskClosingResolver(() => closing);
  const dependencies: OrdinaryTaskPromptInputHandlerDependencies = {
    admission,
    ...currentStateDependencies,
    getLeaseIdentity: () => ({
      clientId: 'client-1',
      leaseGeneration: 8,
      ownerId: 'owner-1',
    }),
  };

  return {
    dependencies,
    setGeneration: (value: number | null) => {
      generation = value;
    },
    setMetadata: (value: typeof metadata) => {
      metadata = value;
    },
    setOnWrite: (next: (() => void) | null) => {
      onWrite = next;
    },
    setClosing: (value: boolean) => {
      closing = value;
    },
    setLeaseHeld: (value: boolean) => {
      leaseHeld = value;
    },
    setSupervision: (value: AgentSupervisionSnapshot | null) => {
      supervision = value;
    },
    setSupervisionReader: (reader: () => AgentSupervisionSnapshot | null) => {
      supervisionReader = reader;
    },
    sleep,
    writeFrame,
  };
}

const request = {
  agentId: 'agent-1',
  controllerId: 'client-1',
  taskId: 'task-1',
  text: 'continue',
};

describe('ordinary task prompt input handler', () => {
  it('captures backend authority and writes a single materialized frame', async () => {
    const harness = createHarness();
    const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);

    await expect(handle(request)).resolves.toEqual({
      admission: {
        admittedSupervisionVersion: 12,
        kind: 'accepted',
        lowLevelCallCount: 1,
      },
    });
    expect(harness.writeFrame).toHaveBeenCalledWith('agent-1', 'continue\r');
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('preserves ordinary-send eligibility for an exited generation without an active session', async () => {
    const harness = createHarness();
    harness.setMetadata(null);
    harness.setSupervision(createSupervision({ state: 'exited-clean' }));
    const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);

    await expect(handle(request)).resolves.toMatchObject({
      admission: { kind: 'accepted' },
    });
    expect(harness.writeFrame).toHaveBeenCalledWith('agent-1', 'continue\r');
  });

  it('rejects initial delivery when live metadata disappears after readiness capture', async () => {
    const harness = createHarness();
    const expectation = {
      agentGeneration: 4,
      agentId: 'agent-1',
      controllerId: 'backend:initial-prompt-delivery:v1',
      leaseGeneration: 8,
      leaseOwnerId: 'backend:initial-prompt-delivery-owner:v1',
      purpose: 'initial-delivery' as const,
      supervisionVersion: 12,
      taskId: 'task-1',
    };
    expect(
      readTaskPromptInputAdmissionCurrentState(harness.dependencies, expectation),
    ).not.toBeNull();

    harness.setMetadata(null);

    await expect(
      harness.dependencies.admission.admit(expectation, { firstFrame: 'must not write' }),
    ).resolves.toEqual({
      kind: 'rejected-before-bytes',
      reason: 'agent-generation-changed',
    });
    expect(harness.writeFrame).not.toHaveBeenCalled();
  });

  it('rejects stale supervision after a replacement session allocates a new generation', async () => {
    const harness = createHarness();
    harness.setGeneration(5);
    harness.setMetadata({ generation: 5, isShell: false, taskId: 'task-1' });
    const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);

    await expect(handle(request)).resolves.toEqual({
      admission: {
        currentGeneration: 5,
        kind: 'rejected-before-bytes',
        reason: 'agent-generation-changed',
      },
    });
    expect(harness.writeFrame).not.toHaveBeenCalled();
  });

  it('owns multiline materialization and rechecks before the submit frame', async () => {
    const harness = createHarness();
    const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);

    await expect(handle({ ...request, text: 'line one\nline two' })).resolves.toMatchObject({
      admission: { kind: 'accepted', lowLevelCallCount: 2 },
    });
    expect(harness.writeFrame.mock.calls).toEqual([
      ['agent-1', '\x1b[200~line one\nline two\x1b[201~'],
      ['agent-1', '\r'],
    ]);
    expect(harness.sleep).toHaveBeenCalledWith(33);
  });

  it('rejects question, closing, and lost-lease transitions before bytes', async () => {
    const cases = [
      {
        arrange: (harness: ReturnType<typeof createHarness>) =>
          harness.setSupervision(createSupervision({ state: 'awaiting-input' })),
        reason: 'question-active',
      },
      {
        arrange: (harness: ReturnType<typeof createHarness>) => harness.setClosing(true),
        reason: 'task-closing',
      },
      {
        arrange: (harness: ReturnType<typeof createHarness>) => harness.setLeaseHeld(false),
        reason: 'control-or-lease-lost',
      },
    ] as const;

    for (const testCase of cases) {
      const harness = createHarness();
      testCase.arrange(harness);
      const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);
      await expect(handle(request)).resolves.toMatchObject({
        admission: { kind: 'rejected-before-bytes', reason: testCase.reason },
      });
      expect(harness.writeFrame).not.toHaveBeenCalled();
    }
  });

  it('rejects a supervision version change between capture and admission', async () => {
    const harness = createHarness();
    let reads = 0;
    harness.setSupervisionReader(() =>
      createSupervision({ supervisionVersion: ++reads === 1 ? 12 : 13 }),
    );
    const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);

    await expect(handle(request)).resolves.toMatchObject({
      admission: { kind: 'rejected-before-bytes', reason: 'supervision-version-changed' },
    });
    expect(harness.writeFrame).not.toHaveBeenCalled();
  });

  it('fixes ordinary purpose in the backend even when extra request fields try to spoof it', async () => {
    const harness = createHarness();
    harness.setSupervision(createSupervision({ state: 'active' }));
    const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);

    await expect(
      handle({ ...request, purpose: 'initial-delivery' } as typeof request),
    ).resolves.toMatchObject({ admission: { kind: 'accepted' } });
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });

  it('reports ambiguity when state changes after a multiline first frame', async () => {
    const harness = createHarness();
    harness.setOnWrite(() => {
      harness.setSupervision(
        createSupervision({ state: 'awaiting-input', supervisionVersion: 13 }),
      );
    });
    const handle = createOrdinaryTaskPromptInputHandler(harness.dependencies);

    await expect(handle({ ...request, text: 'one\ntwo' })).resolves.toMatchObject({
      admission: { bytesMayHaveBeenAccepted: true, kind: 'outcome-ambiguous' },
    });
    expect(harness.writeFrame).toHaveBeenCalledTimes(1);
  });
});
