import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

import {
  type ServerMessage,
  type TaskCommandLeaseCommand,
  type TaskCommandLeaseResultMessage,
} from '../../electron/remote/protocol.js';
import { isRemoteServerMessage } from '../../electron/remote/remote-message.js';
import type { BrowserServerController } from '../../server/browser-server.js';
import { startBrowserServer } from '../../server/browser-server.js';
import { BROWSER_CLIENT_ID_HEADER } from '../../src/domain/browser-ipc.js';
import type {
  CoordinatorCreateRunResult,
  CoordinatorToolCallEnvelope,
  CoordinatorToolCallResult,
} from '../../src/domain/coordinator.js';
import { IPC } from '../../electron/ipc/channels.js';

const SOCKET_TIMEOUT_MS = 5_000;

type CoordinatorSocketEventMessage = Extract<ServerMessage, { type: 'coordinator-event' }> & {
  seq?: number;
};
type CoordinatorToolCallRequest = Omit<CoordinatorToolCallEnvelope, 'token'> & {
  token?: string;
};

interface BrowserRequestOptions {
  clientId?: string;
  token?: string;
}

export interface CoordinatorBrowserlessHarness {
  callCoordinatorTool: (envelope: CoordinatorToolCallRequest) => Promise<CoordinatorToolCallResult>;
  close: () => Promise<void>;
  connectWebSocketAndWait: <T>(
    clientId: string,
    lastSeq: number,
    predicate: (message: unknown) => message is T,
  ) => Promise<{
    message: T;
    socket: WebSocket;
  }>;
  connectWebSocket: (clientId: string, lastSeq?: number) => Promise<WebSocket>;
  createCoordinatorRun: (overrides?: Partial<CreateCoordinatorRunRequest>) => Promise<{
    credential: CoordinatorCredentialFile;
    result: CoordinatorCreateRunResult;
  }>;
  ipc: <T>(channel: IPC, body: unknown, options?: BrowserRequestOptions) => Promise<T>;
  ipcResponse: (channel: IPC, body: unknown, options?: BrowserRequestOptions) => Promise<Response>;
  port: number;
  rootDir: string;
  sendTaskCommandLease: (
    socket: WebSocket,
    command: TaskCommandLeaseCommand,
  ) => Promise<TaskCommandLeaseResultMessage>;
  token: string;
  toolCallResponse: (envelope: CoordinatorToolCallRequest) => Promise<Response>;
  userDataPath: string;
  waitForSocketMessage: <T>(
    socket: WebSocket,
    predicate: (message: unknown) => message is T,
  ) => Promise<T>;
}

interface CreateCoordinatorRunRequest {
  coordinatorAgentId: string;
  coordinatorTaskId: string;
  projectId: string;
  projectMode: 'git' | 'non-git';
  projectRoot: string;
}

interface CoordinatorCredentialFile {
  agentId: string;
  createdAt: number;
  runId: string;
  taskId: string;
  token: string;
  tokenId: string;
  toolCallUrl?: string;
  toolCommand?: string;
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate test port');
  }

  return address.port;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function waitForServerControllerClose(controller: BrowserServerController): Promise<void> {
  controller.cleanup();
  // The coordinator runtime cleanup flushes pending persistence
  // asynchronously; the temp state dir must not be removed underneath it.
  await controller.whenCoordinatorRuntimeStopped();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function isTaskCommandLeaseResultForRequest(
  value: unknown,
  requestId: string,
): value is TaskCommandLeaseResultMessage {
  return (
    isRemoteServerMessage(value) &&
    value.type === 'task-command-lease-result' &&
    value.requestId === requestId
  );
}

export async function createCoordinatorBrowserlessHarness(
  options: {
    token?: string;
    userDataPath?: string;
  } = {},
): Promise<CoordinatorBrowserlessHarness> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-coordinator-e2e-'));
  const distDir = path.join(rootDir, 'dist');
  const distRemoteDir = path.join(rootDir, 'dist-remote');
  const userDataPath = options.userDataPath ?? path.join(rootDir, 'user-data');
  const token = options.token ?? 'browserless-coordinator-token';
  const port = await getAvailablePort();
  await Promise.all([
    mkdir(distDir, { recursive: true }),
    mkdir(distRemoteDir, { recursive: true }),
    mkdir(userDataPath, { recursive: true }),
  ]);

  const controller = startBrowserServer({
    distDir,
    distRemoteDir,
    port,
    registerProcessHandlers: false,
    token,
    userDataPath,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await controller.whenReady();
  } catch (startupError) {
    const cleanupErrors: unknown[] = [];
    try {
      await waitForServerControllerClose(controller);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 0) {
      try {
        await rm(rootDir, { force: true, recursive: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        'Coordinator browserless harness startup and cleanup failed',
      );
    }
    throw startupError;
  }

  async function ipcResponse(
    channel: IPC,
    body: unknown,
    requestOptions: BrowserRequestOptions = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${requestOptions.token ?? token}`,
      'Content-Type': 'application/json',
    };
    if (requestOptions.clientId !== undefined) {
      headers[BROWSER_CLIENT_ID_HEADER] = requestOptions.clientId;
    }

    return fetch(`${baseUrl}/api/ipc/${channel}`, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
    });
  }

  async function ipc<T>(
    channel: IPC,
    body: unknown,
    requestOptions: BrowserRequestOptions = {},
  ): Promise<T> {
    const response = await ipcResponse(channel, body, requestOptions);
    const payload = await parseJsonResponse<{ error?: string; result?: T }>(response);
    if (!response.ok) {
      throw new Error(payload.error ?? `IPC ${channel} failed with ${response.status}`);
    }
    return payload.result as T;
  }

  async function toolCallResponse(envelope: CoordinatorToolCallRequest): Promise<Response> {
    return fetch(`${baseUrl}/api/coordinator/tool-call`, {
      body: JSON.stringify({
        ...envelope,
        token: envelope.token ?? token,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  }

  async function callCoordinatorTool(
    envelope: CoordinatorToolCallRequest,
  ): Promise<CoordinatorToolCallResult> {
    const response = await toolCallResponse(envelope);
    const payload = await parseJsonResponse<{
      error?: string;
      result?: CoordinatorToolCallResult;
    }>(response);
    if (!response.ok || !payload.result) {
      throw new Error(payload.error ?? `Coordinator tool call failed with ${response.status}`);
    }

    return payload.result;
  }

  async function createCoordinatorRun(
    overrides: Partial<CreateCoordinatorRunRequest> = {},
  ): Promise<{
    credential: CoordinatorCredentialFile;
    result: CoordinatorCreateRunResult;
  }> {
    const request: CreateCoordinatorRunRequest = {
      coordinatorAgentId: 'agent-coordinator',
      coordinatorTaskId: 'task-coordinator',
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: rootDir,
      ...overrides,
    };
    const result = await ipc<CoordinatorCreateRunResult>(IPC.CoordinatorCreateRun, request);
    const credential = await readJsonFile<CoordinatorCredentialFile>(result.credentialPath);
    return { credential, result };
  }

  async function waitForSocketMessage<T>(
    socket: WebSocket,
    predicate: (message: unknown) => message is T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for websocket message'));
      }, SOCKET_TIMEOUT_MS);

      function cleanup(): void {
        clearTimeout(timeout);
        socket.off('message', handleMessage);
        socket.off('error', handleError);
      }

      function handleError(error: Error): void {
        cleanup();
        reject(error);
      }

      function handleMessage(raw: unknown): void {
        const parsed = JSON.parse(String(raw)) as unknown;
        if (!predicate(parsed)) {
          return;
        }

        cleanup();
        resolve(parsed);
      }

      socket.on('message', handleMessage);
      socket.on('error', handleError);
    });
  }

  async function openWebSocket(): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      function cleanup(): void {
        socket.off('open', handleOpen);
        socket.off('error', handleError);
      }

      function handleOpen(): void {
        cleanup();
        resolve();
      }

      function handleError(error: Error): void {
        cleanup();
        reject(error);
      }

      socket.once('open', handleOpen);
      socket.once('error', handleError);
    });
    return socket;
  }

  function sendAuth(socket: WebSocket, clientId: string, lastSeq: number): void {
    socket.send(
      JSON.stringify({
        clientId,
        lastSeq,
        token,
        type: 'auth',
      }),
    );
  }

  async function connectWebSocket(clientId: string, lastSeq = -1): Promise<WebSocket> {
    const socket = await openWebSocket();
    sendAuth(socket, clientId, lastSeq);
    return socket;
  }

  async function connectWebSocketAndWait<T>(
    clientId: string,
    lastSeq: number,
    predicate: (message: unknown) => message is T,
  ): Promise<{
    message: T;
    socket: WebSocket;
  }> {
    const socket = await openWebSocket();
    const messagePromise = waitForSocketMessage(socket, predicate);
    sendAuth(socket, clientId, lastSeq);

    try {
      return {
        message: await messagePromise,
        socket,
      };
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  async function sendTaskCommandLease(
    socket: WebSocket,
    command: TaskCommandLeaseCommand,
  ): Promise<TaskCommandLeaseResultMessage> {
    const resultPromise = waitForSocketMessage(
      socket,
      (message): message is TaskCommandLeaseResultMessage =>
        isTaskCommandLeaseResultForRequest(message, command.requestId),
    );
    socket.send(JSON.stringify(command));
    return resultPromise;
  }

  async function close(): Promise<void> {
    await waitForServerControllerClose(controller);
    await rm(rootDir, { force: true, recursive: true });
  }

  return {
    callCoordinatorTool,
    close,
    connectWebSocketAndWait,
    connectWebSocket,
    createCoordinatorRun,
    ipc,
    ipcResponse,
    port,
    rootDir,
    sendTaskCommandLease,
    token,
    toolCallResponse,
    userDataPath,
    waitForSocketMessage,
  };
}

export function isCoordinatorEventMessage(value: unknown): value is CoordinatorSocketEventMessage {
  return isRemoteServerMessage(value) && value.type === 'coordinator-event';
}
