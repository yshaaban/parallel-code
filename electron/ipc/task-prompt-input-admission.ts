import type {
  PromptInputAdmissionCurrentState,
  PromptInputAdmissionExpectation,
  PromptInputAdmissionResult,
} from '../../src/domain/task-prompt-input-admission.js';

export interface MaterializedPromptInputDispatch {
  firstFrame: string;
  submitDelayMs?: number;
  submitFrame?: string;
}

export interface TaskPromptInputAdmissionDependencies {
  getCurrentState: (
    expectation: PromptInputAdmissionExpectation,
  ) => PromptInputAdmissionCurrentState | null;
  isLeaseHeld: (expectation: PromptInputAdmissionExpectation) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
  writeFrame: (agentId: string, frame: string) => void;
}

export interface TaskPromptInputAdmissionService {
  admit: (
    expectation: PromptInputAdmissionExpectation,
    dispatch: MaterializedPromptInputDispatch,
  ) => Promise<PromptInputAdmissionResult>;
  bindTaskClosingResolver: (resolver: (taskId: string) => boolean) => () => void;
}

export function evaluateTaskPromptInputAdmission(
  expectation: PromptInputAdmissionExpectation,
  current: PromptInputAdmissionCurrentState | null,
  isLeaseHeld: boolean,
  isTaskClosing: boolean,
): Extract<PromptInputAdmissionResult, { kind: 'rejected-before-bytes' }> | null {
  if (!current || current.agentGeneration !== expectation.agentGeneration) {
    return {
      ...(current ? { currentGeneration: current.agentGeneration } : {}),
      kind: 'rejected-before-bytes',
      reason: 'agent-generation-changed',
    };
  }

  if (current.taskId !== expectation.taskId || !isLeaseHeld) {
    return {
      kind: 'rejected-before-bytes',
      reason: 'control-or-lease-lost',
    };
  }

  if (current.supervisionVersion !== expectation.supervisionVersion) {
    return {
      currentSupervisionVersion: current.supervisionVersion,
      kind: 'rejected-before-bytes',
      reason: 'supervision-version-changed',
    };
  }

  if (isTaskClosing) {
    return {
      kind: 'rejected-before-bytes',
      reason: 'task-closing',
    };
  }

  if (current.state === 'awaiting-input') {
    return {
      kind: 'rejected-before-bytes',
      reason: 'question-active',
    };
  }

  if (expectation.purpose === 'initial-delivery' && current.state !== 'idle-at-prompt') {
    return {
      kind: 'rejected-before-bytes',
      reason: 'agent-not-ready',
    };
  }

  return null;
}

function validateDispatch(dispatch: MaterializedPromptInputDispatch): void {
  if (dispatch.firstFrame.length === 0) {
    throw new Error('Prompt input first frame must not be empty');
  }
  if ((dispatch.submitFrame === undefined) !== (dispatch.submitDelayMs === undefined)) {
    throw new Error('Prompt input submit frame and delay must be provided together');
  }
  if (dispatch.submitDelayMs !== undefined && dispatch.submitDelayMs < 0) {
    throw new Error('Prompt input submit delay must be non-negative');
  }
}

export function createTaskPromptInputAdmissionService(
  dependencies: TaskPromptInputAdmissionDependencies,
): TaskPromptInputAdmissionService {
  const sleep =
    dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const serializedTailByAgentId = new Map<string, Promise<void>>();
  let taskClosingBinding: { resolver: (taskId: string) => boolean; token: symbol } | null = null;

  function bindTaskClosingResolver(resolver: (taskId: string) => boolean): () => void {
    if (taskClosingBinding) {
      throw new Error('Task-prompt closing resolver is already bound');
    }
    const token = Symbol('task-prompt-closing-resolver');
    taskClosingBinding = { resolver, token };
    return () => {
      if (taskClosingBinding?.token === token) taskClosingBinding = null;
    };
  }

  async function runSerialized<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const previous = serializedTailByAgentId.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    serializedTailByAgentId.set(agentId, turn);

    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (serializedTailByAgentId.get(agentId) === turn) {
        serializedTailByAgentId.delete(agentId);
      }
    }
  }

  function evaluate(
    expectation: PromptInputAdmissionExpectation,
  ): Extract<PromptInputAdmissionResult, { kind: 'rejected-before-bytes' }> | null {
    return evaluateTaskPromptInputAdmission(
      expectation,
      dependencies.getCurrentState(expectation),
      dependencies.isLeaseHeld(expectation),
      taskClosingBinding?.resolver(expectation.taskId) ?? true,
    );
  }

  async function admit(
    expectation: PromptInputAdmissionExpectation,
    dispatch: MaterializedPromptInputDispatch,
  ): Promise<PromptInputAdmissionResult> {
    validateDispatch(dispatch);
    return runSerialized(expectation.agentId, async () => {
      const rejection = evaluate(expectation);
      if (rejection) {
        return rejection;
      }

      try {
        dependencies.writeFrame(expectation.agentId, dispatch.firstFrame);
      } catch {
        return {
          admittedSupervisionVersion: expectation.supervisionVersion,
          bytesMayHaveBeenAccepted: true,
          kind: 'outcome-ambiguous',
        };
      }

      if (dispatch.submitFrame === undefined || dispatch.submitDelayMs === undefined) {
        return {
          admittedSupervisionVersion: expectation.supervisionVersion,
          kind: 'accepted',
          lowLevelCallCount: 1,
        };
      }

      try {
        await sleep(dispatch.submitDelayMs);
        if (evaluate(expectation)) {
          return {
            admittedSupervisionVersion: expectation.supervisionVersion,
            bytesMayHaveBeenAccepted: true,
            kind: 'outcome-ambiguous',
          };
        }

        dependencies.writeFrame(expectation.agentId, dispatch.submitFrame);
      } catch {
        return {
          admittedSupervisionVersion: expectation.supervisionVersion,
          bytesMayHaveBeenAccepted: true,
          kind: 'outcome-ambiguous',
        };
      }

      return {
        admittedSupervisionVersion: expectation.supervisionVersion,
        kind: 'accepted',
        lowLevelCallCount: 2,
      };
    });
  }

  return { admit, bindTaskClosingResolver };
}
