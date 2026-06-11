// Renderer-side registry of the output channel ids whose terminals are
// currently focused / switch-target. The backend-focus-reporter folds this
// set into ReportClientTaskFocus.focusedChannelIds, which is the single focus
// signal the server's channel-lane priority consumes; terminal sessions only
// publish their channel here, they never own wire priority.

const focusedChannelIdsByAgentId = new Map<string, string>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setTerminalFocusedChannel(
  agentId: string,
  channelId: string,
  focused: boolean,
): void {
  if (focused) {
    if (focusedChannelIdsByAgentId.get(agentId) === channelId) {
      return;
    }

    focusedChannelIdsByAgentId.set(agentId, channelId);
    notifyListeners();
    return;
  }

  if (focusedChannelIdsByAgentId.get(agentId) !== channelId) {
    return;
  }

  focusedChannelIdsByAgentId.delete(agentId);
  notifyListeners();
}

export function getFocusedTerminalChannelIds(): string[] {
  return [...focusedChannelIdsByAgentId.values()].sort();
}

export function subscribeFocusedTerminalChannels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetTerminalFocusedChannelsForTests(): void {
  focusedChannelIdsByAgentId.clear();
  listeners.clear();
}
