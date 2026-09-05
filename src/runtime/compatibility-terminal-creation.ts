const PENDING_COMPATIBILITY_TERMINAL_CREATION_LIMIT = 4_096;

const pendingCreations = new Map<string, true>();

function identityKey(taskId: string, agentId: string): string {
  return JSON.stringify([taskId, agentId]);
}

/**
 * Records only fresh, user-initiated compatibility sessions. The identity
 * remains pending across remounts and response loss so a retry can dedupe at
 * the backend, but the process-local set is never persisted as reconnect
 * authority.
 */
export function markCompatibilityTerminalCreationPending(taskId: string, agentId: string): void {
  const key = identityKey(taskId, agentId);
  pendingCreations.delete(key);
  pendingCreations.set(key, true);
  while (pendingCreations.size > PENDING_COMPATIBILITY_TERMINAL_CREATION_LIMIT) {
    const oldest = pendingCreations.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingCreations.delete(oldest);
  }
}

export function isCompatibilityTerminalCreationPending(taskId: string, agentId: string): boolean {
  return pendingCreations.has(identityKey(taskId, agentId));
}

export function completeCompatibilityTerminalCreation(taskId: string, agentId: string): void {
  pendingCreations.delete(identityKey(taskId, agentId));
}

export function clearCompatibilityTerminalCreationsForTests(): void {
  pendingCreations.clear();
}
