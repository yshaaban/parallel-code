import { chunkContainsAgentPrompt } from '../lib/prompt-detection';

const agentReadyCallbacks = new Map<string, () => void>();

export function onAgentReady(agentId: string, callback: () => void): void {
  agentReadyCallbacks.set(agentId, callback);
}

export function offAgentReady(agentId: string): void {
  agentReadyCallbacks.delete(agentId);
}

export function clearAgentReadyCallback(agentId: string): void {
  agentReadyCallbacks.delete(agentId);
}

export function maybeFireAgentReadyCallback(agentId: string, visibleTail: string): void {
  if (!agentReadyCallbacks.has(agentId)) {
    return;
  }

  const normalizedTail = visibleTail
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!chunkContainsAgentPrompt(normalizedTail)) {
    return;
  }

  const callback = agentReadyCallbacks.get(agentId);
  agentReadyCallbacks.delete(agentId);
  callback?.();
}

export function resetAgentReadyCallbackRuntimeState(): void {
  agentReadyCallbacks.clear();
}

export function resetAgentReadyCallbacksForTests(): void {
  resetAgentReadyCallbackRuntimeState();
}
