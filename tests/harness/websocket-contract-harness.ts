import { WebSocket } from 'ws';
import { vi } from 'vitest';
import type { ServerMessage } from '../../electron/remote/protocol.js';
import {
  clearGitStatusSnapshots,
  recordGitStatusSnapshot,
} from '../../electron/ipc/git-status-state.js';
import {
  createWebSocketTransport,
  type ClaimAgentControlResult,
  type CreateWebSocketTransportOptions,
  type SendTextResult,
} from '../../electron/remote/ws-transport.js';
import { createBrowserControlPlane } from '../../server/browser-control-plane.js';

type ContractMessage = Record<string, unknown>;

function decodeSentPayload(payload: string | Buffer): unknown {
  const text = typeof payload === 'string' ? payload : payload.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface FakeWebSocketClient extends WebSocket {
  bufferedAmount: number;
  closeEvents: Array<{ code: number; reason: string }>;
  pingCount: number;
  readyState: number;
  sent: unknown[];
  terminated: boolean;
}

export interface WebSocketContractHarnessOptions {
  agentControlLeaseMs?: number;
  heartbeatIntervalMs?: number;
  maxMissedPongs?: number;
}

export interface WebSocketContractHarness {
  authenticateConnection: (
    client: FakeWebSocketClient,
    clientId?: string,
    lastSeq?: number,
  ) => boolean;
  broadcastControl: (message: ServerMessage) => void;
  claimAgentControl: (client: FakeWebSocketClient, agentId: string) => ClaimAgentControlResult;
  cleanupClient: (client: FakeWebSocketClient) => void;
  clearMessages: (client: FakeWebSocketClient) => void;
  createClient: () => FakeWebSocketClient;
  dispose: () => void;
  flush: () => Promise<void>;
  getMessages: (client: FakeWebSocketClient) => unknown[];
  name: string;
  removeGitStatus?: (worktreePath: string) => void;
  replayControlEvents: (client: FakeWebSocketClient, lastSeq?: number) => void;
  remoteStatus?: () => {
    connectedClients: number;
    enabled: true;
    peerClients: number;
    port: number;
    tailscaleUrl: string | null;
    token: string;
    url: string;
    wifiUrl: string | null;
  };
}

type TransportContractOptions = Pick<
  CreateWebSocketTransportOptions<FakeWebSocketClient>,
  'agentControlLeaseMs' | 'heartbeatIntervalMs' | 'maxMissedPongs'
>;

function getSendTextResult(client: FakeWebSocketClient): SendTextResult {
  if (client.readyState === WebSocket.OPEN) {
    return { ok: true };
  }

  return { ok: false, reason: 'not-open' };
}

export function createFakeWebSocketClient(): FakeWebSocketClient {
  const sent: unknown[] = [];
  const client = {
    bufferedAmount: 0,
    closeEvents: [] as Array<{ code: number; reason: string }>,
    pingCount: 0,
    readyState: WebSocket.OPEN,
    sent,
    terminated: false,
    close(code?: number, reason?: string | Buffer): void {
      this.closeEvents.push({
        code: code ?? 1000,
        reason: typeof reason === 'string' ? reason : (reason?.toString() ?? ''),
      });
      this.readyState = WebSocket.CLOSING;
    },
    ping(): void {
      this.pingCount += 1;
    },
    send(payload: string | Buffer): void {
      this.sent.push(decodeSentPayload(payload));
    },
    terminate(): void {
      this.terminated = true;
      this.readyState = WebSocket.CLOSED;
    },
  } as FakeWebSocketClient;

  return client;
}

function clearMessages(client: FakeWebSocketClient): void {
  client.sent.splice(0);
}

function getMessages(client: FakeWebSocketClient): unknown[] {
  return [...client.sent];
}

function createTransportOptions(
  options?: WebSocketContractHarnessOptions,
): TransportContractOptions {
  return {
    ...(options?.agentControlLeaseMs !== undefined
      ? { agentControlLeaseMs: options.agentControlLeaseMs }
      : {}),
    ...(options?.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
    ...(options?.maxMissedPongs !== undefined ? { maxMissedPongs: options.maxMissedPongs } : {}),
  };
}

function sendHarnessText(client: FakeWebSocketClient, text: string): SendTextResult {
  client.send(text);
  return getSendTextResult(client);
}

function isMessageOfType<TType extends string>(
  message: unknown,
  type: TType,
): message is ContractMessage & { type: TType } {
  return typeof message === 'object' && message !== null && message.type === type;
}

export function getMessagesOfType<TType extends string>(
  harness: WebSocketContractHarness,
  client: ReturnType<WebSocketContractHarness['createClient']>,
  type: TType,
): Array<ContractMessage & { type: TType }> {
  return harness
    .getMessages(client)
    .filter((message): message is ContractMessage & { type: TType } =>
      isMessageOfType(message, type),
    );
}

export function getSequencedMessages(
  harness: WebSocketContractHarness,
  client: ReturnType<WebSocketContractHarness['createClient']>,
): Array<ContractMessage & { seq: number }> {
  return harness
    .getMessages(client)
    .filter(
      (message): message is ContractMessage & { seq: number } =>
        typeof message === 'object' &&
        message !== null &&
        typeof (message as { seq?: unknown }).seq === 'number',
    );
}

export function createTransportContractHarness(
  options?: WebSocketContractHarnessOptions,
): WebSocketContractHarness {
  const transport = createWebSocketTransport<FakeWebSocketClient>({
    closeClient: (client, code, reason) => {
      client.close(code, reason);
    },
    sendBroadcastText: sendHarnessText,
    sendDirectText: sendHarnessText,
    terminateClient: (client) => {
      client.terminate();
    },
    ...createTransportOptions(options),
  });

  return {
    authenticateConnection: (client, clientId) => transport.authenticateClient(client, clientId).ok,
    broadcastControl: (message) => {
      transport.broadcastControl(message);
    },
    claimAgentControl: (client, agentId) => transport.claimAgentControl(client, agentId),
    cleanupClient: (client) => {
      transport.cleanupClient(client);
    },
    clearMessages,
    createClient: createFakeWebSocketClient,
    dispose: () => {
      transport.stopHeartbeat();
    },
    flush: async () => {},
    getMessages,
    name: 'shared-transport',
    replayControlEvents: (client, lastSeq) => {
      transport.replayControlEvents(client, lastSeq);
    },
  };
}

export function createBrowserControlPlaneContractHarness(
  options?: WebSocketContractHarnessOptions,
): WebSocketContractHarness {
  clearGitStatusSnapshots();
  const controlPlane = createBrowserControlPlane({
    agentControlLeaseMs: options?.agentControlLeaseMs,
    buildAgentList: () => [],
    cleanupSocketClient: () => {},
    heartbeatIntervalMs: options?.heartbeatIntervalMs,
    maxMissedPongs: options?.maxMissedPongs,
    port: 7777,
    token: 'contract-token',
  });

  return {
    authenticateConnection: (client, clientId, lastSeq) =>
      controlPlane.authenticateConnection(client, clientId, lastSeq),
    broadcastControl: (message) => {
      if (message.type === 'git-status-changed' && message.status) {
        recordGitStatusSnapshot(message);
      }
      controlPlane.broadcastControl(message);
    },
    claimAgentControl: (client, agentId) =>
      controlPlane.transport.claimAgentControl(client, agentId),
    cleanupClient: (client) => {
      controlPlane.cleanupClient(client);
      controlPlane.transport.cleanupClient(client);
    },
    clearMessages,
    createClient: createFakeWebSocketClient,
    dispose: () => {
      controlPlane.cleanup();
      clearGitStatusSnapshots();
    },
    flush: async () => {
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(25);
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    },
    getMessages,
    name: 'browser-control-plane',
    removeGitStatus: (worktreePath) => {
      controlPlane.removeGitStatus(worktreePath);
    },
    remoteStatus: () => controlPlane.getRemoteStatus(),
    replayControlEvents: (client, lastSeq) => {
      controlPlane.transport.replayControlEvents(client, lastSeq);
    },
  };
}
