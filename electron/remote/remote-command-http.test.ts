import { createServer, request as requestHttp, type Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteCommandGateway,
  type RemoteCommandAuthentication,
} from '../ipc/remote-command-gateway.js';
import {
  isGetTaskNotesRequest,
  isGetTaskNotesWireResponse,
  type GetTaskNotesResult,
  type TaskNotesWireResponse,
} from '../../src/domain/task-notes.js';
import { createRemoteCommandHttpHandler } from './remote-command-http.js';
import { TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS } from './task-notes-http.js';

const servers: Server[] = [];

const TRUSTED_AUTHENTICATION: RemoteCommandAuthentication = {
  authEpoch: 'epoch-1',
  authenticationSessionGeneration: 'generation-1',
  expiresAt: Number.MAX_SAFE_INTEGER,
  grants: new Set(['catalog:read']),
  kind: 'trusted-local',
  principalId: 'workspace-owner',
};

const BROWSER_AUTHENTICATION: RemoteCommandAuthentication = {
  authEpoch: 'epoch-1',
  authenticationSessionGeneration: 'generation-1',
  csrfValidated: true,
  directPeerValidated: true,
  expiresAt: Number.MAX_SAFE_INTEGER,
  grants: new Set(['catalog:read']),
  kind: 'browser-session',
  originValidated: true,
  principalId: 'workspace-owner',
  transportSecure: true,
};

const NOTES_AUTHENTICATION: RemoteCommandAuthentication = {
  ...TRUSTED_AUTHENTICATION,
  grants: new Set(['notes:read']),
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startHandler(
  options: Parameters<typeof createRemoteCommandHttpHandler>[0],
): Promise<number> {
  const handler = createRemoteCommandHttpHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return address.port;
}

function createGateway() {
  return createRemoteCommandGateway({
    'task-catalog.get-manifest': {
      execute: () => ({ value: 'safe' }),
      isRequest: (value): value is Record<string, never> =>
        typeof value === 'object' && value !== null && Object.keys(value).length === 0,
      isResult: (value): value is { value: string } =>
        typeof value === 'object' &&
        value !== null &&
        (value as { value?: unknown }).value === 'safe',
    },
  });
}

function createTaskNotesGateway(
  execute: () => TaskNotesWireResponse<GetTaskNotesResult> | unknown,
) {
  return createRemoteCommandGateway({
    'task-notes.get': {
      execute,
      isRequest: isGetTaskNotesRequest,
      isResult: isGetTaskNotesWireResponse,
    },
  });
}

describe('createRemoteCommandHttpHandler', () => {
  it('dispatches through the scoped gateway with no-store security headers', async () => {
    const authenticate = vi.fn(() => TRUSTED_AUTHENTICATION);
    const port = await startHandler({
      authenticate,
      gateway: createGateway(),
      responseAdapters: TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS,
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/commands/task-catalog.get-manifest`,
      {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { value: 'safe' } });
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'task-catalog.get-manifest', effect: 'read' }),
    );
  });

  it('rejects unsupported methods, commands, and media types before dispatch', async () => {
    const authenticate = vi.fn(() => TRUSTED_AUTHENTICATION);
    const port = await startHandler({ authenticate, gateway: createGateway() });

    const [method, command, media] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/commands/task-catalog.get-manifest`),
      fetch(`http://127.0.0.1:${port}/api/commands/local-admin.remove-task`, {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      fetch(`http://127.0.0.1:${port}/api/commands/task-catalog.get-manifest`, {
        body: '{}',
        headers: { 'content-type': 'text/plain' },
        method: 'POST',
      }),
    ]);

    expect(method.status).toBe(405);
    expect(command.status).toBe(404);
    expect(media.status).toBe(415);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('writes direct Notes results and domain errors with exact status and retry policy', async () => {
    const unavailable = {
      ok: true as const,
      result: { kind: 'task-state-unavailable' as const, retryAfterMs: 500 },
    };
    const unavailablePort = await startHandler({
      authenticate: () => NOTES_AUTHENTICATION,
      gateway: createTaskNotesGateway(() => unavailable),
      responseAdapters: TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS,
    });
    const unavailableResponse = await fetch(
      `http://127.0.0.1:${unavailablePort}/api/commands/task-notes.get`,
      {
        body: JSON.stringify({ taskId: 'task-1' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    );

    expect(unavailableResponse.status).toBe(200);
    expect(unavailableResponse.headers.get('retry-after')).toBe('1');
    expect(await unavailableResponse.json()).toEqual(unavailable);

    const rejected = {
      ok: false as const,
      error: { code: 'operation-identity-rejected' as const },
    };
    const rejectedPort = await startHandler({
      authenticate: () => NOTES_AUTHENTICATION,
      gateway: createTaskNotesGateway(() => rejected),
      responseAdapters: TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS,
    });
    const rejectedResponse = await fetch(
      `http://127.0.0.1:${rejectedPort}/api/commands/task-notes.get`,
      {
        body: JSON.stringify({ taskId: 'task-1' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    );

    expect(rejectedResponse.status).toBe(409);
    expect(await rejectedResponse.json()).toEqual(rejected);
    expect(rejectedResponse.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(rejectedResponse.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('normalizes Notes HTTP-edge and invalid-backend failures without nesting', async () => {
    const port = await startHandler({
      authenticate: () => NOTES_AUTHENTICATION,
      gateway: createTaskNotesGateway(() => ({ unsafe: true })),
      maxBodyBytes: 32,
      responseAdapters: TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS,
    });
    const url = `http://127.0.0.1:${port}/api/commands/task-notes.get`;

    const [media, oversized, invalidBackend] = await Promise.all([
      fetch(url, {
        body: JSON.stringify({ taskId: 'task-1' }),
        headers: { 'content-type': 'text/plain' },
        method: 'POST',
      }),
      fetch(url, {
        body: JSON.stringify({ taskId: 'x'.repeat(128) }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      fetch(url, {
        body: JSON.stringify({ taskId: 'task-1' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    ]);

    expect(media.status).toBe(415);
    expect(await media.json()).toEqual({
      ok: false,
      error: { code: 'unsupported-media-type' },
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      ok: false,
      error: { code: 'payload-too-large' },
    });
    expect(invalidBackend.status).toBe(500);
    expect(await invalidBackend.json()).toEqual({
      ok: false,
      error: { code: 'internal-error', retryable: false },
    });
  });

  it('redacts Notes authentication proof failures behind direct public errors', async () => {
    let authentication: RemoteCommandAuthentication | null = null;
    const port = await startHandler({
      authenticate: () => authentication,
      gateway: createTaskNotesGateway(() => ({ ok: true, result: { kind: 'not-found' } })),
      responseAdapters: TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS,
    });
    const invoke = () =>
      fetch(`http://127.0.0.1:${port}/api/commands/task-notes.get`, {
        body: JSON.stringify({ taskId: 'task-1' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

    const unauthenticated = await invoke();
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      ok: false,
      error: { code: 'unauthenticated' },
    });

    authentication = {
      ...BROWSER_AUTHENTICATION,
      csrfValidated: false,
      grants: new Set(['notes:read']),
    };
    const rejectedProof = await invoke();
    expect(rejectedProof.status).toBe(403);
    expect(await rejectedProof.json()).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('terminates parsed-body retention at the configured streaming cap', async () => {
    const authenticate = vi.fn(() => TRUSTED_AUTHENTICATION);
    const port = await startHandler({
      authenticate,
      gateway: createGateway(),
      maxBodyBytes: 32,
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/commands/task-catalog.get-manifest`,
      {
        body: JSON.stringify({ value: 'x'.repeat(128) }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'payload-too-large' } });
  });

  it('bounds chunked bodies even when no content-length is supplied', async () => {
    const port = await startHandler({
      authenticate: () => TRUSTED_AUTHENTICATION,
      gateway: createGateway(),
      maxBodyBytes: 32,
    });

    const response = await new Promise<{ body: string; status: number }>((resolve, reject) => {
      const request = requestHttp(
        {
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          host: '127.0.0.1',
          method: 'POST',
          path: '/api/commands/task-catalog.get-manifest',
          port,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({
              body: Buffer.concat(chunks).toString('utf8'),
              status: incoming.statusCode ?? 0,
            }),
          );
        },
      );
      request.on('error', reject);
      request.write('{"value":"');
      request.write('x'.repeat(128));
      request.end('"}');
    });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'payload-too-large' } });
  });

  it('maps authentication and gateway failures without leaking handler details', async () => {
    const port = await startHandler({ authenticate: () => null, gateway: createGateway() });
    const response = await fetch(
      `http://127.0.0.1:${port}/api/commands/task-catalog.get-manifest`,
      {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'unauthenticated' }, ok: false });
  });

  it('records activity only after every browser command proof and gateway check succeeds', async () => {
    let authentication = BROWSER_AUTHENTICATION;
    const onAcceptedAuthentication = vi.fn();
    const port = await startHandler({
      authenticate: () => authentication,
      gateway: createGateway(),
      onAcceptedAuthentication,
    });
    const invoke = () =>
      fetch(`http://127.0.0.1:${port}/api/commands/task-catalog.get-manifest`, {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

    for (const overrides of [
      { csrfValidated: false },
      { originValidated: false },
      { transportSecure: false },
      { directPeerValidated: false },
    ] satisfies Array<Partial<RemoteCommandAuthentication>>) {
      authentication = { ...BROWSER_AUTHENTICATION, ...overrides };
      expect((await invoke()).status).toBe(403);
    }
    expect(onAcceptedAuthentication).not.toHaveBeenCalled();

    authentication = BROWSER_AUTHENTICATION;
    expect((await invoke()).status).toBe(200);
    expect(onAcceptedAuthentication).toHaveBeenCalledTimes(1);
    expect(onAcceptedAuthentication).toHaveBeenCalledWith(
      BROWSER_AUTHENTICATION,
      expect.objectContaining({
        command: 'task-catalog.get-manifest',
        effect: 'read',
      }),
    );
  });
});
