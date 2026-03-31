import { getTerminalExperimentDenseOverloadMinimumVisibleCount } from '../lib/terminal-performance-experiments';
import { isTerminalHighLoadModeEnabled } from './terminal-high-load-mode';
import {
  clearTerminalTypingAgent,
  completeTerminalTypingEcho,
  getTerminalInteractivitySnapshot,
  isTerminalInteractivityCriticalActive,
  isTerminalInteractivityEchoReservationActive,
  isTerminalInteractivityPromptSuppressionActive,
  noteTerminalTypingCritical,
  resetTerminalInteractivityForTests,
  resetTerminalInteractivityState,
  settleTerminalTypingCritical,
  subscribeTerminalInteractivityChanges,
  type TerminalInteractivitySnapshot,
} from './terminal-interactivity-governor';

export type TerminalFocusedInputSnapshot = TerminalInteractivitySnapshot;

export function noteTerminalFocusedInput(taskId: string, agentId?: string): void {
  noteTerminalTypingCritical(taskId, agentId);
}

export function completeTerminalFocusedInputEcho(taskId: string, agentId?: string): void {
  completeTerminalTypingEcho(taskId, agentId);
}

export function clearTerminalFocusedInputAgent(agentId: string): void {
  clearTerminalTypingAgent(agentId);
}

export function settleTerminalFocusedInput(taskId: string, agentId?: string): void {
  settleTerminalTypingCritical(taskId, agentId);
}

export function isTerminalFocusedInputActive(taskId?: string, agentId?: string): boolean {
  return isTerminalInteractivityCriticalActive(taskId, agentId);
}

export function isTerminalFocusedInputEchoReservationActive(
  taskId?: string,
  agentId?: string,
): boolean {
  return isTerminalInteractivityEchoReservationActive(taskId, agentId);
}

export function isTerminalFocusedInputPromptSuppressionActive(agentId: string): boolean {
  return isTerminalInteractivityPromptSuppressionActive(agentId);
}

export function isTerminalDenseFocusedInputProtectionActive(visibleTerminalCount: number): boolean {
  const denseOverloadMinimumVisibleCount = getTerminalExperimentDenseOverloadMinimumVisibleCount();
  if (
    !isTerminalInteractivityCriticalActive() ||
    !isTerminalHighLoadModeEnabled() ||
    denseOverloadMinimumVisibleCount <= 0
  ) {
    return false;
  }

  return visibleTerminalCount >= denseOverloadMinimumVisibleCount;
}

export function getTerminalFocusedInputSnapshot(): TerminalFocusedInputSnapshot {
  return getTerminalInteractivitySnapshot();
}

export function subscribeTerminalFocusedInputChanges(listener: () => void): () => void {
  return subscribeTerminalInteractivityChanges(listener);
}

export function resetTerminalFocusedInputForTests(): void {
  resetTerminalInteractivityForTests();
}

export function resetTerminalFocusedInputState(): void {
  resetTerminalInteractivityState();
}
