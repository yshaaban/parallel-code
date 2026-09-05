export type PromptDispatchBlock = 'peer-controlled' | 'agent-question' | 'send-in-flight' | 'empty';

export type PromptCanonicalAgentState =
  | 'starting'
  | 'working'
  | 'ready'
  | 'awaiting-input'
  | 'exited';

export interface PromptInputFacts {
  canonicalAgentState: PromptCanonicalAgentState;
  canonicalGeneration: number;
  composing: boolean;
  control: 'local' | 'peer';
  hasText: boolean;
  localQuestionGeneration?: number;
  sendInFlight: boolean;
}

export interface PromptInputPolicy {
  dispatchAllowed: boolean;
  dispatchBlock?: PromptDispatchBlock;
  editable: boolean;
  enterAction: 'send' | 'newline' | 'ignore';
  explanation?: 'peer-controlled' | 'answer-in-terminal' | 'sending';
  focusAction: 'preserve';
  readOnlyReason?: 'peer-controlled';
}

export function getPromptCanonicalAgentState(
  supervisionState:
    | 'active'
    | 'awaiting-input'
    | 'idle-at-prompt'
    | 'quiet'
    | 'paused'
    | 'flow-controlled'
    | 'restoring'
    | 'exited-clean'
    | 'exited-error'
    | undefined,
  agentStatus: 'running' | 'paused' | 'flow-controlled' | 'restoring' | 'exited' | undefined,
  identity?: {
    canonicalGeneration: number;
    supervisionGeneration?: number;
  },
): PromptCanonicalAgentState {
  const currentSupervisionState =
    identity?.supervisionGeneration !== undefined &&
    identity.supervisionGeneration !== identity.canonicalGeneration
      ? undefined
      : supervisionState;

  if (currentSupervisionState === 'awaiting-input') {
    return 'awaiting-input';
  }
  if (currentSupervisionState === 'idle-at-prompt') {
    return 'ready';
  }
  if (
    currentSupervisionState === 'exited-clean' ||
    currentSupervisionState === 'exited-error' ||
    agentStatus === 'exited'
  ) {
    return 'exited';
  }
  return currentSupervisionState === undefined ? 'starting' : 'working';
}

function isQuestionBlocking(facts: PromptInputFacts): boolean {
  return (
    facts.canonicalAgentState === 'awaiting-input' ||
    facts.localQuestionGeneration === facts.canonicalGeneration
  );
}

/**
 * One side-effect-free decision point for every prompt-editor affordance.
 * Authorization is still enforced by the backend prompt-input admission gate.
 */
export function getPromptInputPolicy(facts: PromptInputFacts): PromptInputPolicy {
  if (facts.control === 'peer') {
    return {
      dispatchAllowed: false,
      dispatchBlock: 'peer-controlled',
      editable: false,
      enterAction: 'ignore',
      explanation: 'peer-controlled',
      focusAction: 'preserve',
      readOnlyReason: 'peer-controlled',
    };
  }

  if (facts.composing) {
    return {
      dispatchAllowed: false,
      editable: true,
      enterAction: 'ignore',
      focusAction: 'preserve',
    };
  }

  if (isQuestionBlocking(facts)) {
    return {
      dispatchAllowed: false,
      dispatchBlock: 'agent-question',
      editable: true,
      enterAction: 'newline',
      explanation: 'answer-in-terminal',
      focusAction: 'preserve',
    };
  }

  if (facts.sendInFlight) {
    return {
      dispatchAllowed: false,
      dispatchBlock: 'send-in-flight',
      editable: true,
      enterAction: 'newline',
      explanation: 'sending',
      focusAction: 'preserve',
    };
  }

  if (!facts.hasText) {
    return {
      dispatchAllowed: false,
      dispatchBlock: 'empty',
      editable: true,
      enterAction: 'ignore',
      focusAction: 'preserve',
    };
  }

  return {
    dispatchAllowed: true,
    editable: true,
    enterAction: 'send',
    focusAction: 'preserve',
  };
}
