import type {
  RequestTaskCommandTakeoverCommand,
  RespondTaskCommandTakeoverCommand,
  ServerMessage,
} from '../electron/remote/protocol.js';
import type { PeerPresenceSnapshot } from '../src/domain/server-state.js';

interface PendingTaskCommandTakeoverRequest {
  action: string;
  expiresAt: number;
  requestId: string;
  requesterClientId: string;
  requesterDisplayName: string;
  targetControllerId: string;
  taskId: string;
  timer: ReturnType<typeof setTimeout>;
}

type TaskCommandTakeoverDecision = 'approved' | 'denied' | 'force-required' | 'owner-missing';

interface CreateBrowserTaskCommandTakeoversOptions {
  getCurrentControllerId: (taskId: string) => string | null;
  getPeerPresence: (clientId: string) => PeerPresenceSnapshot | null;
  hasClientId: (clientId: string) => boolean;
  idleMs: number;
  sendToClientId: (clientId: string, message: ServerMessage) => void;
  timeoutMs: number;
}

function createTaskCommandTakeoverResultMessage(
  requestId: string,
  taskId: string,
  decision: TaskCommandTakeoverDecision,
): ServerMessage {
  return {
    type: 'task-command-takeover-result',
    decision,
    requestId,
    taskId,
  };
}

export function createBrowserTaskCommandTakeovers(
  options: CreateBrowserTaskCommandTakeoversOptions,
): {
  cleanup: () => void;
  cleanupRequestsForClient: (clientId: string) => void;
  getPendingRequest: (requestId: string) => PendingTaskCommandTakeoverRequest | null;
  reconcileTask: (taskId: string) => void;
  requestTakeover: (requesterClientId: string, message: RequestTaskCommandTakeoverCommand) => void;
  respondTakeover: (responderClientId: string, message: RespondTaskCommandTakeoverCommand) => void;
} {
  const pendingTaskCommandTakeoverRequests = new Map<string, PendingTaskCommandTakeoverRequest>();

  function getPendingRequest(requestId: string): PendingTaskCommandTakeoverRequest | null {
    return pendingTaskCommandTakeoverRequests.get(requestId) ?? null;
  }

  function clearTaskCommandTakeoverRequest(
    requestId: string,
  ): PendingTaskCommandTakeoverRequest | null {
    const request = pendingTaskCommandTakeoverRequests.get(requestId) ?? null;
    if (!request) {
      return null;
    }

    clearTimeout(request.timer);
    pendingTaskCommandTakeoverRequests.delete(requestId);
    return request;
  }

  function sendTaskCommandTakeoverResult(
    request: PendingTaskCommandTakeoverRequest,
    decision: TaskCommandTakeoverDecision,
  ): void {
    const resultMessage = createTaskCommandTakeoverResultMessage(
      request.requestId,
      request.taskId,
      decision,
    );
    options.sendToClientId(request.requesterClientId, resultMessage);
    if (request.targetControllerId !== request.requesterClientId) {
      options.sendToClientId(request.targetControllerId, resultMessage);
    }
  }

  function sendDirectTaskCommandTakeoverResult(
    clientId: string,
    requestId: string,
    taskId: string,
    decision: TaskCommandTakeoverDecision,
  ): void {
    options.sendToClientId(
      clientId,
      createTaskCommandTakeoverResultMessage(requestId, taskId, decision),
    );
  }

  function resolveTaskCommandTakeoverRequest(
    requestId: string,
    decision: TaskCommandTakeoverDecision,
  ): void {
    const request = clearTaskCommandTakeoverRequest(requestId);
    if (!request) {
      return;
    }

    sendTaskCommandTakeoverResult(request, decision);
  }

  function getTaskTakeoverTimeoutDecision(
    request: PendingTaskCommandTakeoverRequest,
  ): TaskCommandTakeoverDecision {
    const currentControllerId = options.getCurrentControllerId(request.taskId);
    if (!currentControllerId) {
      return 'owner-missing';
    }

    if (currentControllerId === request.requesterClientId) {
      return 'approved';
    }

    if (currentControllerId !== request.targetControllerId) {
      return 'denied';
    }

    if (!options.hasClientId(request.targetControllerId)) {
      return 'owner-missing';
    }

    const targetPresence = options.getPeerPresence(request.targetControllerId);
    if (!targetPresence) {
      return 'force-required';
    }

    if (targetPresence.visibility === 'hidden') {
      return 'approved';
    }

    if (Date.now() - targetPresence.lastSeenAt >= options.idleMs) {
      return 'approved';
    }

    return 'force-required';
  }

  function getTaskTakeoverResponseDecision(
    request: PendingTaskCommandTakeoverRequest,
    approved: boolean,
  ): 'approved' | 'denied' | 'owner-missing' {
    const currentControllerId = options.getCurrentControllerId(request.taskId);
    if (!currentControllerId) {
      return 'owner-missing';
    }

    if (currentControllerId === request.requesterClientId) {
      return 'approved';
    }

    if (currentControllerId !== request.targetControllerId) {
      return 'denied';
    }

    return approved ? 'approved' : 'denied';
  }

  function getTaskTakeoverControllerChangeDecision(
    request: PendingTaskCommandTakeoverRequest,
  ): 'approved' | 'denied' | 'owner-missing' | null {
    const currentControllerId = options.getCurrentControllerId(request.taskId);
    if (!currentControllerId) {
      return 'owner-missing';
    }

    if (currentControllerId === request.requesterClientId) {
      return 'approved';
    }

    if (currentControllerId !== request.targetControllerId) {
      return 'denied';
    }

    return null;
  }

  function cleanupRequestsForClient(clientId: string): void {
    for (const request of [...pendingTaskCommandTakeoverRequests.values()]) {
      if (request.requesterClientId === clientId) {
        resolveTaskCommandTakeoverRequest(request.requestId, 'denied');
        continue;
      }

      if (request.targetControllerId === clientId) {
        resolveTaskCommandTakeoverRequest(request.requestId, 'owner-missing');
      }
    }
  }

  function reconcileTask(taskId: string): void {
    for (const request of [...pendingTaskCommandTakeoverRequests.values()]) {
      if (request.taskId !== taskId) {
        continue;
      }

      const decision = getTaskTakeoverControllerChangeDecision(request);
      if (!decision) {
        continue;
      }

      resolveTaskCommandTakeoverRequest(request.requestId, decision);
    }
  }

  function requestTakeover(
    requesterClientId: string,
    message: RequestTaskCommandTakeoverCommand,
  ): void {
    const currentControllerId = options.getCurrentControllerId(message.taskId);
    if (!currentControllerId || currentControllerId !== message.targetControllerId) {
      sendDirectTaskCommandTakeoverResult(
        requesterClientId,
        message.requestId,
        message.taskId,
        'owner-missing',
      );
      return;
    }

    if (requesterClientId === message.targetControllerId) {
      sendDirectTaskCommandTakeoverResult(
        requesterClientId,
        message.requestId,
        message.taskId,
        'approved',
      );
      return;
    }

    if (!options.hasClientId(message.targetControllerId)) {
      sendDirectTaskCommandTakeoverResult(
        requesterClientId,
        message.requestId,
        message.taskId,
        'owner-missing',
      );
      return;
    }

    const requesterDisplayName =
      options.getPeerPresence(requesterClientId)?.displayName ??
      `Session ${requesterClientId.slice(0, 6)}`;
    const expiresAt = Date.now() + options.timeoutMs;
    const timer = setTimeout(() => {
      const request = getPendingRequest(message.requestId);
      if (!request) {
        return;
      }

      resolveTaskCommandTakeoverRequest(message.requestId, getTaskTakeoverTimeoutDecision(request));
    }, options.timeoutMs);

    pendingTaskCommandTakeoverRequests.set(message.requestId, {
      action: message.action,
      expiresAt,
      requestId: message.requestId,
      requesterClientId,
      requesterDisplayName,
      targetControllerId: message.targetControllerId,
      taskId: message.taskId,
      timer,
    });

    options.sendToClientId(message.targetControllerId, {
      type: 'task-command-takeover-request',
      action: message.action,
      expiresAt,
      requestId: message.requestId,
      requesterClientId,
      requesterDisplayName,
      taskId: message.taskId,
    });
  }

  function respondTakeover(
    responderClientId: string,
    message: RespondTaskCommandTakeoverCommand,
  ): void {
    const request = getPendingRequest(message.requestId);
    if (!request || request.targetControllerId !== responderClientId) {
      return;
    }

    resolveTaskCommandTakeoverRequest(
      message.requestId,
      getTaskTakeoverResponseDecision(request, message.approved),
    );
  }

  function cleanup(): void {
    for (const request of [...pendingTaskCommandTakeoverRequests.values()]) {
      clearTaskCommandTakeoverRequest(request.requestId);
    }
  }

  return {
    cleanup,
    cleanupRequestsForClient,
    getPendingRequest,
    reconcileTask,
    requestTakeover,
    respondTakeover,
  };
}
