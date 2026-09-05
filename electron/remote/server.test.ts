import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as requestHttps, type RequestOptions } from 'node:https';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  createRemoteTaskCreationOperationSource,
  createTaskCreationRemoteCommandRegistrations,
} from '../ipc/task-creation-remote-commands.js';
import type {
  TaskCreationOperationListener,
  TaskCreationWorkflow,
} from '../ipc/task-creation-workflow.js';
import type { RemoteGrant } from '../ipc/remote-command-gateway.js';
import type {
  TaskCreationCapabilities,
  TaskCreationTerminalOperationSnapshot,
} from '../../src/domain/task-creation.js';
import { isGetTaskNotesRequest, isGetTaskNotesWireResponse } from '../../src/domain/task-notes.js';
import type {
  TaskCreationOperationCapability,
  TaskCreationOperationId,
} from '../../src/domain/task-creation-ticket.js';
import {
  REMOTE_AUTH_BOOTSTRAP_PATH,
  REMOTE_AUTH_LOGOUT_PATH,
  REMOTE_AUTH_SESSION_PATH,
} from './remote-auth-http.js';
import { startRemoteServer } from './server.js';

const OPERATION_ID = Buffer.alloc(16, 0x31).toString('base64url') as TaskCreationOperationId;
const OPERATION_CAPABILITY = Buffer.alloc(32, 0x42).toString(
  'base64url',
) as TaskCreationOperationCapability;

interface HttpsResponse {
  body: string;
  headers: import('node:http').IncomingHttpHeaders;
  status: number;
}

async function getAvailablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Port probe did not bind');
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function getLoopbackInterfaceName(): string {
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (addresses?.some((address) => address.address === '127.0.0.1')) return name;
  }
  throw new Error('No IPv4 loopback interface is available');
}

async function createTestTlsPair(directory: string): Promise<{ cert: Buffer; key: Buffer }> {
  const certificatePath = path.join(directory, 'certificate.pem');
  const keyPath = path.join(directory, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  const [cert, key] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
  return { cert, key };
}

function sendHttpsRequest(
  port: number,
  request: Pick<RequestOptions, 'headers' | 'method' | 'path'> & { body?: string },
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = requestHttps(
      {
        headers: request.headers,
        hostname: '127.0.0.1',
        method: request.method ?? 'GET',
        path: request.path,
        port,
        rejectUnauthorized: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: incoming.headers,
            status: incoming.statusCode ?? 0,
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(request.body);
  });
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function enabledCapabilities(): TaskCreationCapabilities {
  return {
    coordinator: { reason: 'coordinator-not-supported', supported: false },
    enabled: true,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    modes: { agent: { enabled: true }, terminal: { enabled: true } },
    permissionBypass: { enabled: true },
  };
}

function operationSnapshot(
  version: number,
  phase: 'cancelled-before-preparation' | 'validating',
): TaskCreationTerminalOperationSnapshot {
  return {
    commit: 'not-committed',
    committedTaskId: null,
    committedWorkspaceRevision: null,
    current: {
      catalogVersion: 1,
      serverInstanceId: 'server-1',
      task: null,
      taskClosing: false,
      taskState: 'not-visible',
      workspaceRevision: 1,
    },
    managedArtifactRecovery: { kind: 'none' },
    operationId: OPERATION_ID,
    phase,
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    taskMode: 'terminal',
    version,
  };
}

function createWorkflowHarness() {
  const listeners = new Set<TaskCreationOperationListener>();
  let current: TaskCreationTerminalOperationSnapshot | null = null;
  const createEffect = vi.fn();
  const cancelEffect = vi.fn();
  const unsubscribe = vi.fn(async () => undefined);
  const publish = async (snapshot: TaskCreationTerminalOperationSnapshot): Promise<void> => {
    await Promise.all([...listeners].map((listener) => listener(snapshot)));
  };

  const workflow: TaskCreationWorkflow = {
    cancel: vi.fn(async (_authentication, request) => {
      if (!current) return { kind: 'operation-state-unavailable' as const };
      if (current.phase === 'cancelled-before-preparation') {
        return {
          kind: 'snapshot' as const,
          outcome: 'already-terminal' as const,
          snapshot: current,
        };
      }
      if (request.expectedVersion !== current.version) {
        return {
          kind: 'snapshot' as const,
          outcome: 'version-conflict' as const,
          snapshot: current,
        };
      }
      cancelEffect();
      current = operationSnapshot(current.version + 1, 'cancelled-before-preparation');
      await publish(current);
      return { kind: 'snapshot' as const, outcome: 'cancelled' as const, snapshot: current };
    }),
    create: vi.fn(async (_authentication, intent) => {
      if (current) {
        return { kind: 'snapshot' as const, outcome: 'joined' as const, snapshot: current };
      }
      createEffect();
      current = operationSnapshot(1, 'validating');
      expect(intent.operationCapability).toBe(OPERATION_CAPABILITY);
      await publish(current);
      return { kind: 'snapshot' as const, outcome: 'accepted' as const, snapshot: current };
    }),
    get: vi.fn(async () =>
      current
        ? { kind: 'snapshot' as const, outcome: 'found' as const, snapshot: current }
        : { kind: 'operation-state-unavailable' as const },
    ),
    getCapabilities: vi.fn(async () => enabledCapabilities()),
    getPickerPage: vi.fn(async (_authentication, request) => ({
      catalogVersion: 1,
      generation: 1,
      items: [],
      kind: request.kind,
      nextCursor: null,
      serverInstanceId: 'server-1',
      truncated: false,
    })),
    getWorktreeLinkCandidates: vi.fn(async () => ({ kind: 'unavailable' as const })),
    issue: vi.fn(async () => ({
      expiresAt: Date.now() + 60_000,
      issuedAt: Date.now(),
      operationId: OPERATION_ID,
      operationTicket: 'integration-ticket',
    })),
    refreshOperation: vi.fn(async () => undefined),
    retryShell: vi.fn(async () => {
      throw new Error('Shell retry is outside this server assembly test');
    }),
    subscribeOperation: vi.fn(async (_authentication, request, listener) => {
      if (
        request.operationId !== OPERATION_ID ||
        request.operationCapability !== OPERATION_CAPABILITY
      ) {
        return {
          kind: 'lookup-rejected-without-snapshot' as const,
          code: 'capability-denied' as const,
        };
      }
      listeners.add(listener);
      if (current) await listener(current);
      return {
        kind: 'subscribed' as const,
        unsubscribe: async () => {
          listeners.delete(listener);
          await unsubscribe();
        },
      };
    }),
  };

  return { cancelEffect, createEffect, unsubscribe, workflow };
}

function parseJson(response: HttpsResponse): unknown {
  return JSON.parse(response.body) as unknown;
}

describe('startRemoteServer scoped task-creation assembly', () => {
  it('enforces scoped grants and drives issue, idempotent create/status, cancel, events, and revocation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-remote-server-'));
    const tls = await createTestTlsPair(directory);
    const port = await getAvailablePort();
    const origin = `https://127.0.0.1:${port}`;
    const harness = createWorkflowHarness();
    const grants = new Set<RemoteGrant>(['task:create']);
    const server = await startRemoteServer({
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' }),
      getTaskName: (taskId) => taskId,
      port,
      scopedCommands: {
        grants,
        mutationAdmissionInitiallyOpen: true,
        peerTrustPolicy: {
          allowedInterfaces: [getLoopbackInterfaceName()],
          allowedPeerRanges: ['127.0.0.0/8'],
        },
        registrations: createTaskCreationRemoteCommandRegistrations(harness.workflow),
        taskCreationOperations: createRemoteTaskCreationOperationSource(harness.workflow),
        tls,
        workspacePrincipalId: 'workspace-owner',
      },
      staticDir: directory,
    });
    let socket: WebSocket | null = null;

    try {
      const bootstrap = await sendHttpsRequest(port, {
        path: `${REMOTE_AUTH_BOOTSTRAP_PATH}?token=${encodeURIComponent(server.token)}&next=%2F`,
      });
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.location).toBe('/');
      const setCookie = Array.isArray(bootstrap.headers['set-cookie'])
        ? bootstrap.headers['set-cookie'][0]
        : bootstrap.headers['set-cookie'];
      const cookie = setCookie?.split(';', 1)[0];
      expect(cookie).toContain('__Host-parallel_code_session=');

      const session = await sendHttpsRequest(port, {
        headers: cookie ? { Cookie: cookie } : {},
        path: REMOTE_AUTH_SESSION_PATH,
      });
      expect(session.status).toBe(200);
      const sessionPayload = parseJson(session) as {
        capabilities: { commands: string[]; mutationAdmission: string };
        csrf: string;
      };
      expect(sessionPayload.capabilities).toEqual({
        commands: expect.arrayContaining([
          'task-creation.cancel',
          'task-creation.create',
          'task-creation.get',
          'task-creation.get-capabilities',
          'task-creation.issue',
        ]),
        mutationAdmission: 'open',
      });
      expect(sessionPayload.csrf).toEqual(expect.any(String));

      const command = (name: string, body: unknown) =>
        sendHttpsRequest(port, {
          body: JSON.stringify(body),
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            'Content-Type': 'application/json',
            Origin: origin,
            'X-Parallel-Code-CSRF': sessionPayload.csrf,
          },
          method: 'POST',
          path: `/api/commands/${name}`,
        });

      const capabilities = await command('task-creation.get-capabilities', {});
      expect(capabilities.status).toBe(200);
      expect(parseJson(capabilities)).toMatchObject({
        ok: true,
        result: {
          locations: {
            'existing-worktree': { enabled: false, reason: 'not-authorized' },
            'managed-worktree': { enabled: true },
            'project-root': { enabled: false, reason: 'not-authorized' },
          },
          permissionBypass: { enabled: false, reason: 'not-authorized' },
        },
      });

      const issued = await command('task-creation.issue', {});
      expect(issued.status).toBe(200);
      expect(parseJson(issued)).toMatchObject({
        ok: true,
        result: { operationId: OPERATION_ID, operationTicket: 'integration-ticket' },
      });
      expect(harness.workflow.issue).toHaveBeenCalledWith(
        expect.objectContaining({ authEpoch: '1', workspacePrincipalId: 'workspace-owner' }),
      );
      const issuedAuthentication = vi.mocked(harness.workflow.issue).mock.calls[0]?.[0];
      expect(issuedAuthentication?.authenticationSessionGeneration).toBeInstanceOf(Uint8Array);
      expect(issuedAuthentication?.authenticationSessionGeneration).toHaveLength(16);
      expect(issued.body).not.toContain(OPERATION_CAPABILITY);

      const intent = {
        launch: { kind: 'terminal' as const },
        location: { kind: 'managed-worktree' as const, requestedLinkNames: [] },
        name: 'Remote terminal',
        operationCapability: OPERATION_CAPABILITY,
        operationId: OPERATION_ID,
        operationTicket: 'integration-ticket',
        projectId: 'project-1',
        stepsTracking: false,
      };
      const denied = await command('task-creation.create', {
        ...intent,
        location: { kind: 'project-root' },
      });
      expect(denied.status).toBe(403);
      expect(parseJson(denied)).toEqual({ ok: false, error: { code: 'forbidden' } });
      expect(harness.workflow.create).not.toHaveBeenCalled();
      expect(denied.body).not.toContain(OPERATION_CAPABILITY);

      const messages: unknown[] = [];
      socket = new WebSocket(`wss://127.0.0.1:${port}/?clientId=integration-client`, {
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          Origin: origin,
        },
        rejectUnauthorized: false,
      });
      socket.on('message', (data) => messages.push(JSON.parse(String(data)) as unknown));
      await waitForWebSocketOpen(socket);
      expect(server.connectedClients()).toBe(1);

      socket.send(
        JSON.stringify({
          operationCapability: OPERATION_CAPABILITY,
          operationId: OPERATION_ID,
          type: 'subscribe-task-creation-operation',
        }),
      );
      await vi.waitFor(
        () =>
          expect(messages).toContainEqual({
            operationId: OPERATION_ID,
            state: 'ready',
            type: 'task-creation-operation-subscription-state',
          }),
        { timeout: 5_000 },
      );
      expect(harness.workflow.subscribeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ authEpoch: '1', workspacePrincipalId: 'workspace-owner' }),
        { operationCapability: OPERATION_CAPABILITY, operationId: OPERATION_ID },
        expect.any(Function),
      );

      const created = await command('task-creation.create', intent);
      expect(created.status).toBe(200);
      expect(parseJson(created)).toMatchObject({
        ok: true,
        result: { outcome: 'accepted', snapshot: { phase: 'validating', version: 1 } },
      });
      await vi.waitFor(
        () =>
          expect(messages).toContainEqual(
            expect.objectContaining({
              snapshot: expect.objectContaining({ phase: 'validating', version: 1 }),
              type: 'task-creation-operation-snapshot',
            }),
          ),
        { timeout: 5_000 },
      );

      const joined = await command('task-creation.create', intent);
      expect(joined.status).toBe(200);
      expect(parseJson(joined)).toMatchObject({
        ok: true,
        result: { outcome: 'joined', snapshot: { version: 1 } },
      });
      const status = await command('task-creation.get', {
        operationCapability: OPERATION_CAPABILITY,
        operationId: OPERATION_ID,
      });
      expect(status.status).toBe(200);
      expect(parseJson(status)).toMatchObject({
        ok: true,
        result: { outcome: 'found', snapshot: { version: 1 } },
      });
      expect(harness.createEffect).toHaveBeenCalledTimes(1);

      const cancelled = await command('task-creation.cancel', {
        expectedVersion: 1,
        operationCapability: OPERATION_CAPABILITY,
        operationId: OPERATION_ID,
      });
      expect(cancelled.status).toBe(200);
      expect(parseJson(cancelled)).toMatchObject({
        ok: true,
        result: {
          outcome: 'cancelled',
          snapshot: { phase: 'cancelled-before-preparation', version: 2 },
        },
      });
      await vi.waitFor(
        () =>
          expect(messages).toContainEqual(
            expect.objectContaining({
              snapshot: expect.objectContaining({
                phase: 'cancelled-before-preparation',
                version: 2,
              }),
              type: 'task-creation-operation-snapshot',
            }),
          ),
        { timeout: 5_000 },
      );
      const alreadyTerminal = await command('task-creation.cancel', {
        expectedVersion: 2,
        operationCapability: OPERATION_CAPABILITY,
        operationId: OPERATION_ID,
      });
      expect(alreadyTerminal.status).toBe(200);
      expect(parseJson(alreadyTerminal)).toMatchObject({
        ok: true,
        result: { outcome: 'already-terminal', snapshot: { version: 2 } },
      });
      expect(harness.cancelEffect).toHaveBeenCalledTimes(1);
      expect(
        [created, joined, status, cancelled, alreadyTerminal]
          .map((response) => response.body)
          .join('\n'),
      ).not.toContain(OPERATION_CAPABILITY);
      expect(JSON.stringify(messages)).not.toContain(OPERATION_CAPABILITY);

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        socket?.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
      });
      const logout = await sendHttpsRequest(port, {
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          Origin: origin,
          'X-Parallel-Code-CSRF': sessionPayload.csrf,
        },
        method: 'POST',
        path: REMOTE_AUTH_LOGOUT_PATH,
      });
      expect(logout.status).toBe(204);
      await expect(closed).resolves.toEqual({ code: 4001, reason: 'Secure session required' });
      await vi.waitFor(() => expect(harness.unsubscribe).toHaveBeenCalledTimes(1));
      expect(server.connectedClients()).toBe(0);

      const revoked = await command('task-creation.get', {
        operationCapability: OPERATION_CAPABILITY,
        operationId: OPERATION_ID,
      });
      expect(revoked.status).toBe(401);
      expect(parseJson(revoked)).toEqual({ ok: false, error: { code: 'unauthenticated' } });
      expect(harness.workflow.get).toHaveBeenCalledTimes(1);
    } finally {
      socket?.terminate();
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);
});

describe('startRemoteServer scoped Notes HTTP parity', () => {
  it('serves the direct Notes wire envelope with its exact domain status', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-remote-notes-'));
    const tls = await createTestTlsPair(directory);
    const port = await getAvailablePort();
    const origin = `https://127.0.0.1:${port}`;
    const server = await startRemoteServer({
      getAgentStatus: () => ({ exitCode: null, lastLine: '', status: 'running' }),
      getTaskName: (taskId) => taskId,
      port,
      scopedCommands: {
        grants: new Set(['notes:read']),
        peerTrustPolicy: {
          allowedInterfaces: [getLoopbackInterfaceName()],
          allowedPeerRanges: ['127.0.0.0/8'],
        },
        registrations: {
          'task-notes.get': {
            execute: () => ({
              ok: false as const,
              error: { code: 'operation-identity-rejected' as const },
            }),
            isRequest: isGetTaskNotesRequest,
            isResult: isGetTaskNotesWireResponse,
          },
        },
        tls,
        workspacePrincipalId: 'workspace-owner',
      },
      staticDir: directory,
    });

    try {
      const bootstrap = await sendHttpsRequest(port, {
        path: `${REMOTE_AUTH_BOOTSTRAP_PATH}?token=${encodeURIComponent(server.token)}&next=%2F`,
      });
      const setCookie = Array.isArray(bootstrap.headers['set-cookie'])
        ? bootstrap.headers['set-cookie'][0]
        : bootstrap.headers['set-cookie'];
      const cookie = setCookie?.split(';', 1)[0];
      const session = await sendHttpsRequest(port, {
        headers: cookie ? { Cookie: cookie } : {},
        path: REMOTE_AUTH_SESSION_PATH,
      });
      const sessionPayload = parseJson(session) as { csrf: string };
      const response = await sendHttpsRequest(port, {
        body: JSON.stringify({ taskId: 'task-1' }),
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          'Content-Type': 'application/json',
          Origin: origin,
          'X-Parallel-Code-CSRF': sessionPayload.csrf,
        },
        method: 'POST',
        path: '/api/commands/task-notes.get',
      });

      expect(response.status).toBe(409);
      expect(response.headers['cache-control']).toBe('no-store, max-age=0');
      expect(parseJson(response)).toEqual({
        ok: false,
        error: { code: 'operation-identity-rejected' },
      });
    } finally {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  }, 20_000);
});
