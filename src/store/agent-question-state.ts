import { createSignal } from 'solid-js';

import {
  recordLocalQuestionStaleGenerationDrop,
  recordLocalQuestionTransition,
} from '../app/runtime-diagnostics';

export interface LocalAgentQuestionState {
  active: boolean;
  agentId: string;
  evidenceRevision: number;
  generation: number;
}

const questionStateByAgent = new Map<string, LocalAgentQuestionState>();
const [questionStateRevision, setQuestionStateRevision] = createSignal(0);

function notifyQuestionStateChanged(): void {
  setQuestionStateRevision((revision) => revision + 1);
}

export function getLocalAgentQuestionState(agentId: string): LocalAgentQuestionState | null {
  questionStateRevision();
  const state = questionStateByAgent.get(agentId);
  return state ? { ...state } : null;
}

export function getLocalAgentQuestionGeneration(
  agentId: string,
  currentGeneration: number,
): number | undefined {
  questionStateRevision();
  const state = questionStateByAgent.get(agentId);
  return state?.active === true && state.generation === currentGeneration
    ? state.generation
    : undefined;
}

export function isLocalAgentQuestionActive(agentId: string, currentGeneration: number): boolean {
  return getLocalAgentQuestionGeneration(agentId, currentGeneration) !== undefined;
}

export function markLocalQuestion(
  agentId: string,
  generation: number,
  evidenceRevision: number,
): void {
  const current = questionStateByAgent.get(agentId);
  if (current && generation < current.generation) {
    recordLocalQuestionStaleGenerationDrop(agentId, generation);
    return;
  }

  if (current?.generation === generation && evidenceRevision <= current.evidenceRevision) {
    return;
  }

  const activeChanged = current?.active !== true || current.generation !== generation;
  questionStateByAgent.set(agentId, {
    active: true,
    agentId,
    evidenceRevision,
    generation,
  });
  if (activeChanged) {
    notifyQuestionStateChanged();
    recordLocalQuestionTransition('enter');
  }
}

export function clearLocalQuestion(
  agentId: string,
  generation: number,
  evidenceRevision: number,
): void {
  const current = questionStateByAgent.get(agentId);
  if (current && generation < current.generation) {
    recordLocalQuestionStaleGenerationDrop(agentId, generation);
    return;
  }
  if (!current || current.generation !== generation) {
    return;
  }

  if (evidenceRevision <= current.evidenceRevision) {
    return;
  }

  questionStateByAgent.set(agentId, {
    active: false,
    agentId,
    evidenceRevision,
    generation,
  });
  if (current.active) {
    notifyQuestionStateChanged();
    recordLocalQuestionTransition('clear');
  }
}

export function resetLocalQuestionForGeneration(agentId: string, generation: number): void {
  const current = questionStateByAgent.get(agentId);
  if (current && generation < current.generation) {
    recordLocalQuestionStaleGenerationDrop(agentId, generation);
    return;
  }

  questionStateByAgent.set(agentId, {
    active: false,
    agentId,
    evidenceRevision: 0,
    generation,
  });
  if (!current || current.active || current.generation !== generation) {
    notifyQuestionStateChanged();
  }
  if (current?.active) {
    recordLocalQuestionTransition('clear');
  }
}

export function removeLocalQuestion(agentId: string): void {
  const current = questionStateByAgent.get(agentId);
  if (!questionStateByAgent.delete(agentId)) {
    return;
  }
  notifyQuestionStateChanged();
  if (current?.active) {
    recordLocalQuestionTransition('clear');
  }
}

export function resetAgentQuestionRuntimeState(): void {
  questionStateByAgent.clear();
  notifyQuestionStateChanged();
}

export function resetAgentQuestionStateForTests(): void {
  resetAgentQuestionRuntimeState();
}
