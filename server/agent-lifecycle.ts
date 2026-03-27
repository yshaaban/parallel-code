import { getAgentMeta, getAgentPauseState, onPtyEvent } from '../electron/ipc/pty.js';
import { getRemoteAgentStatus, type ServerMessage } from '../electron/remote/protocol.js';

interface RegisterAgentLifecycleBroadcastsOptions {
  broadcastAgentList: () => void;
  broadcastControl: (message: ServerMessage) => void;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  releaseAgentControl: (agentId: string) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

function getLifecycleGenerationField(
  generation: number | undefined,
): { generation: number } | Record<never, never> {
  return generation !== undefined ? { generation } : {};
}

export function registerAgentLifecycleBroadcasts(
  options: RegisterAgentLifecycleBroadcastsOptions,
): () => void {
  const {
    broadcastAgentList,
    broadcastControl,
    clearTimer = (timer) => clearTimeout(timer),
    releaseAgentControl,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  } = options;
  const exitBroadcastTimers = new Set<ReturnType<typeof setTimeout>>();

  const unsubSpawn = onPtyEvent('spawn', (agentId) => {
    const meta = getAgentMeta(agentId);
    broadcastAgentList();
    broadcastControl({
      type: 'agent-lifecycle',
      event: 'spawn',
      agentId,
      ...getLifecycleGenerationField(meta?.generation),
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
      ...getLifecycleGenerationField(meta?.generation),
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
      ...getLifecycleGenerationField(meta?.generation),
      taskId: meta?.taskId ?? null,
      isShell: meta?.isShell ?? null,
      status: 'running',
    });
  });

  const unsubExit = onPtyEvent('exit', (agentId, data) => {
    const meta = getAgentMeta(agentId);
    const { exitCode, generation, signal } = (data ?? {}) as {
      exitCode?: number | null;
      generation?: number;
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
      ...getLifecycleGenerationField(generation ?? meta?.generation),
      taskId: meta?.taskId ?? null,
      isShell: meta?.isShell ?? null,
      status: 'exited',
      exitCode: exitCode ?? null,
      signal: signal ?? null,
    });
    const timer = setTimer(() => {
      exitBroadcastTimers.delete(timer);
      broadcastAgentList();
    }, 100);
    exitBroadcastTimers.add(timer);
  });

  return () => {
    for (const timer of exitBroadcastTimers) {
      clearTimer(timer);
    }
    exitBroadcastTimers.clear();
    unsubSpawn();
    unsubListChanged();
    unsubPause();
    unsubResume();
    unsubExit();
  };
}
