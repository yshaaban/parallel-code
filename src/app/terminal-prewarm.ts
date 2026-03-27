export type TerminalPrewarmReason =
  | 'focus-intent'
  | 'pointer-intent'
  | 'selection-intent'
  | 'visibility-intent';

type TerminalPrewarmSubscriber = (reason: TerminalPrewarmReason) => void;

const terminalPrewarmSubscribers = new Map<string, Set<TerminalPrewarmSubscriber>>();

function getTerminalPrewarmSubscribers(taskId: string): Set<TerminalPrewarmSubscriber> | null {
  return terminalPrewarmSubscribers.get(taskId) ?? null;
}

export function requestTerminalPrewarm(
  taskId: string,
  reason: TerminalPrewarmReason = 'pointer-intent',
): void {
  const subscribers = getTerminalPrewarmSubscribers(taskId);
  if (!subscribers) {
    return;
  }

  for (const subscriber of subscribers) {
    subscriber(reason);
  }
}

export function subscribeTerminalPrewarm(
  taskId: string,
  subscriber: TerminalPrewarmSubscriber,
): () => void {
  const subscribers =
    terminalPrewarmSubscribers.get(taskId) ?? new Set<TerminalPrewarmSubscriber>();
  subscribers.add(subscriber);
  terminalPrewarmSubscribers.set(taskId, subscribers);

  return () => {
    const currentSubscribers = terminalPrewarmSubscribers.get(taskId);
    if (!currentSubscribers) {
      return;
    }

    currentSubscribers.delete(subscriber);
    if (currentSubscribers.size === 0) {
      terminalPrewarmSubscribers.delete(taskId);
    }
  };
}

export function resetTerminalPrewarmForTests(): void {
  terminalPrewarmSubscribers.clear();
}
