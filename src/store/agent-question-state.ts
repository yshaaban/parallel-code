import { createSignal } from 'solid-js';

const [questionAgents, setQuestionAgents] = createSignal<Set<string>>(new Set());

export function isAgentAskingQuestion(agentId: string): boolean {
  return questionAgents().has(agentId);
}

export function setAgentQuestionState(agentId: string, hasQuestion: boolean): void {
  setQuestionAgents((previousQuestionAgents) => {
    if (hasQuestion === previousQuestionAgents.has(agentId)) {
      return previousQuestionAgents;
    }

    const nextQuestionAgents = new Set(previousQuestionAgents);
    if (hasQuestion) {
      nextQuestionAgents.add(agentId);
    } else {
      nextQuestionAgents.delete(agentId);
    }
    return nextQuestionAgents;
  });
}

export function resetAgentQuestionRuntimeState(): void {
  setQuestionAgents(new Set<string>());
}

export function resetAgentQuestionStateForTests(): void {
  resetAgentQuestionRuntimeState();
}
