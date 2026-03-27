import { createSignal } from 'solid-js';

export const PROMPT_DISPATCH_WINDOW_MS = 1_500;

interface PromptDispatchEntry {
  dispatchedAt: number;
  generation: number | null;
}

const [promptDispatchTimestamps, setPromptDispatchTimestamps] = createSignal<
  Record<string, PromptDispatchEntry>
>({});

export function markTaskPromptDispatch(
  agentId: string,
  generation: number | null = null,
  dispatchedAt = Date.now(),
): void {
  setPromptDispatchTimestamps((previousTimestamps) => ({
    ...previousTimestamps,
    [agentId]: {
      dispatchedAt,
      generation,
    },
  }));
}

export function clearTaskPromptDispatch(agentId: string): void {
  setPromptDispatchTimestamps((previousTimestamps) => {
    if (!previousTimestamps[agentId]) {
      return previousTimestamps;
    }

    const { [agentId]: _omittedTimestamp, ...nextTimestamps } = previousTimestamps;
    return nextTimestamps;
  });
}

export function getAgentPromptDispatchAt(
  agentId: string,
  generation: number | null = null,
  now = Date.now(),
): number | null {
  const entry = promptDispatchTimestamps()[agentId];
  if (!entry) {
    return null;
  }

  if (generation !== null && entry.generation !== generation) {
    return null;
  }

  if (now - entry.dispatchedAt > PROMPT_DISPATCH_WINDOW_MS) {
    return null;
  }

  return entry.dispatchedAt;
}

export function resetTaskPromptDispatchState(): void {
  setPromptDispatchTimestamps({});
}

export function resetTaskPromptDispatchStateForTests(): void {
  resetTaskPromptDispatchState();
}
