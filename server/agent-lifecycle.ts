import {
  getAgentMeta,
  getAgentPauseState,
  onPtyEvent,
  type PtySpawnEventData,
} from '../electron/ipc/pty.js';
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

function getAgentSessionLifecycleFields(
  meta: ReturnType<typeof getAgentMeta>,
): Pick<
  import('../src/domain/server-state.js').AgentLifecycleEvent,
  'launchReason' | 'operationId' | 'resumed'
> {
  return {
    ...(meta?.agentSessionLaunchReason !== undefined
      ? { launchReason: meta.agentSessionLaunchReason }
      : {}),
    ...(meta?.agentSessionOperationId !== undefined
      ? { operationId: meta.agentSessionOperationId }
      : {}),
    ...(meta?.agentSessionResumed !== undefined ? { resumed: meta.agentSessionResumed } : {}),
  };
}

function getExitSessionLifecycleFields(
  data: PtySpawnEventData,
): Pick<
  import('../src/domain/server-state.js').AgentLifecycleEvent,
  'launchReason' | 'operationId' | 'resumed'
> {
  return {
    ...(data.launchReason !== undefined ? { launchReason: data.launchReason } : {}),
    ...(data.operationId !== undefined ? { operationId: data.operationId } : {}),
    ...(data.resumed !== undefined ? { resumed: data.resumed } : {}),
  };
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
      ...getAgentSessionLifecycleFields(meta),
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
      ...getAgentSessionLifecycleFields(meta),
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
      ...getAgentSessionLifecycleFields(meta),
      taskId: meta?.taskId ?? null,
      isShell: meta?.isShell ?? null,
      status: 'running',
    });
  });

  const unsubExit = onPtyEvent('exit', (agentId, data) => {
    const meta = getAgentMeta(agentId);
    releaseAgentControl(agentId);
    broadcastControl({
      type: 'status',
      agentId,
      status: 'exited',
      exitCode: data.exitCode,
    });
    broadcastControl({
      type: 'agent-lifecycle',
      event: 'exit',
      agentId,
      generation: data.generation,
      ...getExitSessionLifecycleFields(data),
      taskId: data.taskId,
      isShell: meta?.isShell ?? null,
      status: 'exited',
      exitCode: data.exitCode,
      signal: data.signal,
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
