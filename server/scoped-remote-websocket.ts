import { WebSocket, type WebSocketServer } from 'ws';
import { registerRemoteWebSocketServer } from '../electron/remote/ws-server.js';
import { createWebSocketTransport, type SendTextResult } from '../electron/remote/ws-transport.js';
import type { RemoteAgent } from '../electron/remote/protocol.js';
import type { ScopedRemoteCommandRuntime } from '../electron/remote/scoped-command-runtime.js';
import type { TaskCatalogDeltaBatch } from '../src/domain/task-catalog.js';
import type { TaskNotesChangedNotification } from '../src/domain/task-notes.js';
import type { RemoteTaskCreationOperationSource } from '../electron/ipc/task-creation-remote-commands.js';

export interface StandaloneScopedRemoteWebSocket {
  cleanup(): void;
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

function sendText(client: WebSocket, text: string): SendTextResult {
  if (client.readyState !== WebSocket.OPEN) return { ok: false, reason: 'not-open' };
  try {
    client.send(text);
    return { ok: true };
  } catch (error) {
    return { error, ok: false, reason: 'send-error' };
  }
}

/** A dedicated WSS keeps scoped remote credentials out of full browser IPC. */
export function createStandaloneScopedRemoteWebSocket(options: {
  getAgentList(): RemoteAgent[];
  runtime: ScopedRemoteCommandRuntime;
  subscribeTaskCatalog(listener: (batch: TaskCatalogDeltaBatch) => void): () => void;
  subscribeTaskNotesChanged(
    listener: (notification: TaskNotesChangedNotification) => void,
  ): () => void;
  taskCreationOperations: RemoteTaskCreationOperationSource;
  wss: WebSocketServer;
}): StandaloneScopedRemoteWebSocket {
  const transport = createWebSocketTransport<WebSocket>({
    closeClient: (client, code, reason) => client.close(code, reason),
    sendBroadcastText: sendText,
    sendDirectText: sendText,
    terminateClient: (client) => client.terminate(),
  });
  const socketServer = registerRemoteWebSocketServer({
    authenticateConnection: (client, clientId, lastSeq, access = { terminalRead: true }) => {
      const result = transport.authenticateClient(client, clientId, {
        receiveControlEvents: access.terminalRead,
      });
      if (!result.ok) return false;
      if (lastSeq !== undefined && access.terminalRead) {
        transport.replayControlEvents(client, lastSeq);
      }
      if (access.terminalRead) {
        transport.sendMessage(client, { list: options.getAgentList(), type: 'agents' });
        transport.sendAgentControllers(client);
      }
      return true;
    },
    authenticateScopedConnection: (request) => options.runtime.authenticateSocket(request),
    getAgentList: options.getAgentList,
    getCurrentScopedAuthentication: (authentication) =>
      options.runtime.getCurrentAuthentication(authentication),
    refreshScopedAuthentication: (authentication) =>
      options.runtime.refreshSocketAuthentication(authentication),
    remoteCommandGateway: options.runtime.gateway,
    safeCompareToken: () => false,
    subscribeScopedAuthenticationInvalidation: (listener) =>
      options.runtime.subscribeAuthenticationInvalidation(listener),
    subscribeTaskCatalog: options.subscribeTaskCatalog,
    taskCreationOperations: options.taskCreationOperations,
    subscribeTaskNotesChanged: options.subscribeTaskNotesChanged,
    transport,
    wss: options.wss,
  });

  return {
    cleanup: () => {
      socketServer.cleanup();
      transport.stopHeartbeat();
      for (const client of options.wss.clients) {
        transport.cleanupClient(client);
      }
    },
    startHeartbeat: () => transport.startHeartbeat(),
    stopHeartbeat: () => transport.stopHeartbeat(),
  };
}
