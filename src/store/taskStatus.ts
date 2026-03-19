export type { TaskDotStatus } from '../app/task-presentation-status';
export { getTaskDotStatus } from '../app/task-presentation-status';
import {
  hasHydraPromptInTail,
  hasReadyPromptInTail,
  isTrustQuestionAutoHandled as isTrustQuestionAutoHandledWithSetting,
  looksLikeQuestion,
  normalizeForComparison,
  stripAnsi,
} from '../lib/prompt-detection';
import {
  clearAgentActivity,
  getAgentOutputTail,
  isAutoTrustSettling,
  isAgentIdle,
  markAgentBusy,
  markAgentOutput,
  markAgentSpawned,
  resetAgentOutputActivityRuntimeState,
} from './agent-output-activity';
import {
  offAgentReady,
  onAgentReady,
  resetAgentReadyCallbackRuntimeState,
} from './agent-ready-callbacks';
import { isAgentAskingQuestion, resetAgentQuestionRuntimeState } from './agent-question-state';
import { store } from './core';

export {
  clearAgentActivity,
  getAgentOutputTail,
  hasHydraPromptInTail,
  hasReadyPromptInTail,
  isAgentAskingQuestion,
  isAutoTrustSettling,
  isAgentIdle,
  looksLikeQuestion,
  markAgentBusy,
  markAgentOutput,
  markAgentSpawned,
  normalizeForComparison,
  offAgentReady,
  onAgentReady,
  stripAnsi,
};

export function isTrustQuestionAutoHandled(tail: string): boolean {
  return isTrustQuestionAutoHandledWithSetting(tail, store.autoTrustFolders);
}

export function resetTaskStatusRuntimeState(): void {
  resetAgentOutputActivityRuntimeState();
  resetAgentReadyCallbackRuntimeState();
  resetAgentQuestionRuntimeState();
}

export function resetTaskStatusStateForTests(): void {
  resetTaskStatusRuntimeState();
}
