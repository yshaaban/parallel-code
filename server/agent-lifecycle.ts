import { getAgentMeta, getAgentPauseState, onPtyEvent } from '../electron/ipc/pty.js';
import { getRemoteAgentStatus, type ServerMessage } from '../electron/remote/protocol.js';

interface RegisterAgentLifecycleBroadcastsOptions {
  broadcastAgentList: () => void;
  broadcastControl: (message: ServerMessage) => void;
  releaseAgentControl: (agentId: string) => void;
}

export function registerAgentLifecycleBroadcasts(
  options: RegisterAgentLifecycleBroadcastsOptions,
): () => void {
  const { broadcastAgentList, broadcastControl, releaseAgentControl } = options;
  const exitBroadcastTimers = new Set<ReturnType<typeof setTimeout>>();

  const unsubSpawn = onPtyEvent('spawn', (agentId) => {
    const meta = getAgentMeta(agentId);
    broadcastAgentList();
    broadcastControl({
      type: 'agent-lifecycle',
      event: 'spawn',
      agentId,
      taskId: meta?.taskId ?? null,
      isShell: meta?.isShell ?? null,
      status: 'running',
    });
  });

  const unsubListChanged = onPtyEvent('list-changed', () => {
    broadcastAgentList();
  });

  const unsubPause = onPtyEvent('pause', (agentId) => {
    const meta = getAgentMeta(agentId);
    broadcastAgentList();
    broadcastControl({
      type: 'agent-lifecycle',
      event: 'pause',
      agentId,
      taskId: meta?.taskId ?? null,
      isShell: meta?.isShell ?? null,
      status: getRemoteAgentStatus(getAgentPauseState(agentId), 'paused'),
    });
  });

  const unsubResume = onPtyEvent('resume', (agentId) => {
    const meta = getAgentMeta(agentId);
    broadcastAgentList();
    broadcastControl({
      type: 'agent-lifecycle',
      event: 'resume',
      agentId,
      taskId: meta?.taskId ?? null,
      isShell: meta?.isShell ?? null,
      status: 'running',
    });
  });

  const unsubExit = onPtyEvent('exit', (agentId, data) => {
    const meta = getAgentMeta(agentId);
    const { exitCode, signal } = (data ?? {}) as {
      exitCode?: number | null;
      signal?: string | null;
    };
    releaseAgentControl(agentId);
    broadcastControl({
      type: 'status',
      agentId,
      status: 'exited',
      exitCode: exitCode ?? null,
    });
    broadcastControl({
      type: 'agent-lifecycle',
      event: 'exit',
      agentId,
      taskId: meta?.taskId ?? null,
      isShell: meta?.isShell ?? null,
      status: 'exited',
      exitCode: exitCode ?? null,
      signal: signal ?? null,
    });
    const timer = setTimeout(() => {
      exitBroadcastTimers.delete(timer);
      broadcastAgentList();
    }, 100);
    exitBroadcastTimers.add(timer);
  });

  return () => {
    for (const timer of exitBroadcastTimers) {
      clearTimeout(timer);
    }
    exitBroadcastTimers.clear();
    unsubSpawn();
    unsubListChanged();
    unsubPause();
    unsubResume();
    unsubExit();
  };
}
