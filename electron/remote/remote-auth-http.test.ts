import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteCommandGateway, type RemoteGrant } from '../ipc/remote-command-gateway.js';
import {
  REMOTE_AUTH_BOOTSTRAP_PATH,
  REMOTE_AUTH_LOGOUT_PATH,
  REMOTE_AUTH_SESSION_PATH,
  createRemoteAuthHttpHandler,
  type RemoteAuthHttpPaths,
} from './remote-auth-http.js';
import {
  REMOTE_SESSION_COOKIE_NAME,
  REMOTE_SESSION_LIFETIMES,
  createRemoteSessionAuthority,
} from './remote-session-authority.js';

vi.mock('./network.js', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('./network.js')>();
  return {
    ...original,
    validateRemotePeerSocket: (address: { remoteAddress?: string }) =>
      address.remoteAddress === '100.64.0.2',
  };
});

interface RecordedResponse {
  body: string;
  headers: Record<string, string>;
  status: number;
}

function request(
  url: string,
  options: {
    cookie?: string;
    csrf?: string;
    method?: string;
    origin?: string;
    secure?: boolean;
    trustedPeer?: boolean;
  } = {},
): IncomingMessage {
  return {
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      host: 'parallel.test',
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.csrf ? { 'x-parallel-code-csrf': options.csrf } : {}),
    },
    method: options.method ?? 'GET',
    socket: {
      encrypted: options.secure !== false,
      localAddress: '100.64.0.1',
      remoteAddress: options.trustedPeer === false ? '203.0.113.9' : '100.64.0.2',
    },
    url,
  } as unknown as IncomingMessage;
}

function response(): { recorded: RecordedResponse; response: ServerResponse } {
  const recorded: RecordedResponse = { body: '', headers: {}, status: 0 };
  return {
    recorded,
    response: {
      end: (body?: string) => {
        recorded.body = body ?? '';
      },
      writeHead: (status: number, headers: Record<string, string>) => {
        recorded.status = status;
        recorded.headers = headers;
      },
    } as unknown as ServerResponse,
  };
}

function createHarness(now?: () => number, paths?: RemoteAuthHttpPaths) {
  let entropy = 0;
  const grants = new Set<RemoteGrant>(['catalog:read']);
  const authority = createRemoteSessionAuthority({
    accessToken: 'bootstrap-secret',
    grants,
    ...(now ? { now } : {}),
    randomBytes: (size) => Buffer.alloc(size, (entropy += 1)),
    workspacePrincipalId: 'workspace-owner',
  });
  const gateway = createRemoteCommandGateway({
    'task-catalog.get-manifest': {
      execute: () => ({ ok: true }),
      isRequest: (value): value is Record<string, never> =>
        typeof value === 'object' && value !== null && Object.keys(value).length === 0,
      isResult: (value): value is { ok: true } =>
        typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true,
    },
  });
  const handler = createRemoteAuthHttpHandler({
    authority,
    gateway,
    ...(paths ? { paths } : {}),
    peerTrustPolicy: {
      allowedInterfaces: ['tailscale0'],
      allowedPeerRanges: ['100.64.0.0/10'],
    },
  });
  return { authority, handler };
}

describe('createRemoteAuthHttpHandler', () => {
  it('allows a host to namespace scoped auth away from its full browser principal', () => {
    const paths = {
      bootstrap: '/remote/auth/bootstrap',
      logout: '/api/remote/auth/logout',
      session: '/api/remote/auth/session',
    };
    const { handler } = createHarness(undefined, paths);
    const legacy = response();
    expect(
      handler(request(`${REMOTE_AUTH_BOOTSTRAP_PATH}?token=bootstrap-secret`), legacy.response),
    ).toBe(false);
    expect(legacy.recorded.status).toBe(0);

    const scoped = response();
    expect(handler(request(`${paths.bootstrap}?token=bootstrap-secret`), scoped.response)).toBe(
      true,
    );
    expect(scoped.recorded.status).toBe(303);
  });

  it('performs one top-level exchange and redirects without token-bearing state', () => {
    const { handler } = createHarness();
    const output = response();
    expect(
      handler(
        request(
          `${REMOTE_AUTH_BOOTSTRAP_PATH}?token=bootstrap-secret&next=%2Ftasks%3Ftoken%3Dleak%26view%3Dall`,
        ),
        output.response,
      ),
    ).toBe(true);
    expect(output.recorded.status).toBe(303);
    expect(output.recorded.headers.Location).toBe('/tasks?view=all');
    expect(output.recorded.headers['Set-Cookie']).toContain(`${REMOTE_SESSION_COOKIE_NAME}=`);
    expect(output.recorded.headers['Cache-Control']).toContain('no-store');
  });

  it('returns current CSRF/capabilities and rotates through a host-only cookie', () => {
    const { handler } = createHarness();
    const bootstrap = response();
    handler(request(`${REMOTE_AUTH_BOOTSTRAP_PATH}?token=bootstrap-secret`), bootstrap.response);
    const cookie = bootstrap.recorded.headers['Set-Cookie']?.split(';', 1)[0];
    expect(cookie).toBeTruthy();

    const session = response();
    handler(request(REMOTE_AUTH_SESSION_PATH, { cookie }), session.response);
    expect(session.recorded.status).toBe(200);
    expect(JSON.parse(session.recorded.body)).toEqual({
      capabilities: {
        commands: ['task-catalog.get-manifest'],
        mutationAdmission: 'draining',
      },
      csrf: expect.any(String),
    });
  });

  it('does not disclose or rotate session material for rejected connection evidence', () => {
    let now = 1_000;
    const { handler } = createHarness(() => now);
    const bootstrap = response();
    handler(request(`${REMOTE_AUTH_BOOTSTRAP_PATH}?token=bootstrap-secret`), bootstrap.response);
    const cookie = bootstrap.recorded.headers['Set-Cookie']?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    now += REMOTE_SESSION_LIFETIMES.csrfRotationMs;

    for (const options of [
      { cookie, secure: false },
      { cookie, trustedPeer: false },
      { cookie, origin: 'https://attacker.test' },
    ]) {
      const rejected = response();
      handler(request(REMOTE_AUTH_SESSION_PATH, options), rejected.response);
      expect(rejected.recorded.status).toBe(401);
      expect(JSON.parse(rejected.recorded.body)).toEqual({ error: 'unauthenticated' });
      expect(rejected.recorded.headers['Set-Cookie']).toBeUndefined();
    }

    const accepted = response();
    handler(request(REMOTE_AUTH_SESSION_PATH, { cookie }), accepted.response);
    expect(accepted.recorded.status).toBe(200);
    expect(accepted.recorded.headers['Set-Cookie']).toContain(`${REMOTE_SESSION_COOKIE_NAME}=`);
  });

  it('requires exact secure origin and CSRF to logout', () => {
    const { handler } = createHarness();
    const bootstrap = response();
    handler(request(`${REMOTE_AUTH_BOOTSTRAP_PATH}?token=bootstrap-secret`), bootstrap.response);
    const cookie = bootstrap.recorded.headers['Set-Cookie']?.split(';', 1)[0];
    const session = response();
    handler(request(REMOTE_AUTH_SESSION_PATH, { cookie }), session.response);
    const csrf = (JSON.parse(session.recorded.body) as { csrf: string }).csrf;

    const rejected = response();
    handler(
      request(REMOTE_AUTH_LOGOUT_PATH, {
        cookie,
        csrf,
        method: 'POST',
        origin: 'https://attacker.test',
      }),
      rejected.response,
    );
    expect(rejected.recorded.status).toBe(403);

    const accepted = response();
    handler(
      request(REMOTE_AUTH_LOGOUT_PATH, {
        cookie,
        csrf,
        method: 'POST',
        origin: 'https://parallel.test',
      }),
      accepted.response,
    );
    expect(accepted.recorded.status).toBe(204);
    expect(accepted.recorded.headers['Set-Cookie']).toContain('Max-Age=0');
  });

  it('rejects query credentials on API routes', () => {
    const { handler } = createHarness();
    const output = response();
    handler(request(`${REMOTE_AUTH_SESSION_PATH}?token=bootstrap-secret`), output.response);
    expect(output.recorded.status).toBe(400);
  });
});
