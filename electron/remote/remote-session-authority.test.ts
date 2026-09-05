import { describe, expect, it } from 'vitest';
import type { RemoteGrant } from '../ipc/remote-command-gateway.js';
import {
  REMOTE_SESSION_COOKIE_NAME,
  REMOTE_SESSION_LIFETIMES,
  createRemoteSessionAuthority,
} from './remote-session-authority.js';

const GRANTS = new Set<RemoteGrant>(['catalog:read', 'task:create']);
const SECURE_CONNECTION = {
  directPeerValidated: true,
  expectedOrigin: 'https://parallel.test',
  origin: 'https://parallel.test',
  sourceId: 'peer-1',
  transportSecure: true,
} as const;

function cookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? '';
}

describe('RemoteSessionAuthority', () => {
  it('exchanges the bootstrap token for a fixed secure host-only session', () => {
    let now = 1_000;
    let entropy = 0;
    const authority = createRemoteSessionAuthority({
      accessToken: 'bootstrap-secret',
      grants: GRANTS,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, (entropy += 1)),
      workspacePrincipalId: 'workspace-owner',
    });

    const exchange = authority.exchangeBrowserToken('bootstrap-secret', SECURE_CONNECTION);
    expect(exchange.kind).toBe('issued');
    if (exchange.kind !== 'issued') return;
    expect(exchange.cookie).toContain(`${REMOTE_SESSION_COOKIE_NAME}=`);
    expect(exchange.cookie).toContain('Secure');
    expect(exchange.cookie).toContain('HttpOnly');
    expect(exchange.cookie).toContain('SameSite=Strict');
    expect(exchange.cookie).not.toContain('Domain=');

    const refresh = authority.refreshBrowserSession(
      cookieHeader(exchange.cookie),
      SECURE_CONNECTION,
    );
    expect(refresh.kind).toBe('current');
    if (refresh.kind !== 'current') return;
    expect(refresh.authentication.authenticationSessionGeneration).toHaveLength(22);
    expect(refresh.authentication.grants).toEqual(GRANTS);

    const authenticated = authority.authenticateBrowserRequest(
      cookieHeader(exchange.cookie),
      refresh.csrf,
      SECURE_CONNECTION,
    );
    expect(authenticated).toMatchObject({
      authEpoch: '1',
      csrfValidated: true,
      directPeerValidated: true,
      kind: 'browser-session',
      originValidated: true,
      principalId: 'workspace-owner',
      transportSecure: true,
    });

    now += REMOTE_SESSION_LIFETIMES.idleMs + 1;
    expect(
      authority.authenticateBrowserRequest(
        cookieHeader(exchange.cookie),
        refresh.csrf,
        SECURE_CONNECTION,
      ),
    ).toBeNull();
  });

  it('rotates cookie and CSRF while preserving the exact session generation', () => {
    let now = 1_000;
    let entropy = 0;
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, (entropy += 1)),
      workspacePrincipalId: 'workspace-owner',
    });
    const exchange = authority.exchangeBrowserToken('secret', SECURE_CONNECTION);
    if (exchange.kind !== 'issued') throw new Error('Expected session');
    const first = authority.refreshBrowserSession(cookieHeader(exchange.cookie), SECURE_CONNECTION);
    if (first.kind !== 'current') throw new Error('Expected current session');

    now += REMOTE_SESSION_LIFETIMES.csrfRotationMs;
    const rotated = authority.refreshBrowserSession(
      cookieHeader(exchange.cookie),
      SECURE_CONNECTION,
    );
    expect(rotated.kind).toBe('current');
    if (rotated.kind !== 'current') return;
    expect(rotated.cookie).toBeDefined();
    expect(rotated.csrf).not.toBe(first.csrf);
    expect(rotated.authentication.authenticationSessionGeneration).toBe(
      first.authentication.authenticationSessionGeneration,
    );
    expect(
      authority.authenticateBrowserRequest(
        cookieHeader(exchange.cookie),
        first.csrf,
        SECURE_CONNECTION,
      ),
    ).toBeNull();
  });

  it('does not extend idle lifetime for rejected request proofs', () => {
    const rejectedProofs = [
      { csrf: undefined, evidence: SECURE_CONNECTION },
      { csrf: 'wrong-csrf', evidence: SECURE_CONNECTION },
      { csrf: 'unused', evidence: { ...SECURE_CONNECTION, transportSecure: false } },
      { csrf: 'unused', evidence: { ...SECURE_CONNECTION, directPeerValidated: false } },
      {
        csrf: 'unused',
        evidence: { ...SECURE_CONNECTION, origin: 'https://attacker.test' },
      },
    ] as const;

    for (const rejected of rejectedProofs) {
      let now = 1_000;
      const authority = createRemoteSessionAuthority({
        accessToken: 'secret',
        grants: GRANTS,
        now: () => now,
        randomBytes: (size) => Buffer.alloc(size, size),
        workspacePrincipalId: 'workspace-owner',
      });
      const exchange = authority.exchangeBrowserToken('secret', SECURE_CONNECTION);
      if (exchange.kind !== 'issued') throw new Error('Expected session');
      const cookie = cookieHeader(exchange.cookie);
      const session = authority.refreshBrowserSession(cookie, SECURE_CONNECTION);
      if (session.kind !== 'current') throw new Error('Expected current session');

      now += REMOTE_SESSION_LIFETIMES.idleMs - 1;
      authority.authenticateBrowserRequest(cookie, rejected.csrf, rejected.evidence);
      now += 2;

      expect(
        authority.authenticateBrowserRequest(cookie, session.csrf, SECURE_CONNECTION),
      ).toBeNull();
    }
  });

  it('extends idle lifetime only when an authenticated browser command is accepted', () => {
    let now = 1_000;
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, size),
      workspacePrincipalId: 'workspace-owner',
    });
    const exchange = authority.exchangeBrowserToken('secret', SECURE_CONNECTION);
    if (exchange.kind !== 'issued') throw new Error('Expected session');
    const cookie = cookieHeader(exchange.cookie);
    const session = authority.refreshBrowserSession(cookie, SECURE_CONNECTION);
    if (session.kind !== 'current') throw new Error('Expected current session');

    now += REMOTE_SESSION_LIFETIMES.idleMs - 1;
    const authenticated = authority.authenticateBrowserRequest(
      cookie,
      session.csrf,
      SECURE_CONNECTION,
    );
    if (!authenticated) throw new Error('Expected authenticated command');
    expect(authority.recordBrowserSessionActivity(authenticated)?.expiresAt).toBe(
      now + REMOTE_SESSION_LIFETIMES.idleMs,
    );

    now += 2;
    expect(
      authority.authenticateBrowserRequest(cookie, session.csrf, SECURE_CONNECTION),
    ).not.toBeNull();
  });

  it('does not rotate or disclose session material through rejected refresh evidence', () => {
    let now = 1_000;
    let entropy = 0;
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, (entropy += 1)),
      workspacePrincipalId: 'workspace-owner',
    });
    const exchange = authority.exchangeBrowserToken('secret', SECURE_CONNECTION);
    if (exchange.kind !== 'issued') throw new Error('Expected session');
    const cookie = cookieHeader(exchange.cookie);
    const first = authority.refreshBrowserSession(cookie, SECURE_CONNECTION);
    if (first.kind !== 'current') throw new Error('Expected current session');

    now += REMOTE_SESSION_LIFETIMES.csrfRotationMs;
    for (const evidence of [
      { ...SECURE_CONNECTION, transportSecure: false },
      { ...SECURE_CONNECTION, directPeerValidated: false },
      { ...SECURE_CONNECTION, origin: 'https://attacker.test' },
    ]) {
      expect(authority.refreshBrowserSession(cookie, evidence)).toEqual({
        kind: 'unauthenticated',
      });
    }

    const accepted = authority.refreshBrowserSession(cookie, SECURE_CONNECTION);
    expect(accepted.kind).toBe('current');
    if (accepted.kind !== 'current') return;
    expect(accepted.cookie).toBeDefined();
    expect(accepted.csrf).not.toBe(first.csrf);
  });

  it('rejects sockets unless TLS, direct-peer, and exact-origin evidence all hold', () => {
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      randomBytes: (size) => Buffer.alloc(size, size),
      workspacePrincipalId: 'workspace-owner',
    });
    const exchange = authority.exchangeBrowserToken('secret', SECURE_CONNECTION);
    if (exchange.kind !== 'issued') throw new Error('Expected session');
    const cookie = cookieHeader(exchange.cookie);

    expect(authority.authenticateBrowserSocket(cookie, SECURE_CONNECTION)).not.toBeNull();
    for (const evidence of [
      { ...SECURE_CONNECTION, transportSecure: false },
      { ...SECURE_CONNECTION, directPeerValidated: false },
      { ...SECURE_CONNECTION, origin: null },
      { ...SECURE_CONNECTION, origin: 'https://attacker.test' },
    ]) {
      expect(authority.authenticateBrowserSocket(cookie, evidence)).toBeNull();
    }
  });

  it('tracks current generations, extends socket idle activity, and publishes revocation', () => {
    let now = 1_000;
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, size),
      workspacePrincipalId: 'workspace-owner',
    });
    const invalidated: number[] = [];
    authority.subscribeInvalidation(() => invalidated.push(now));
    const exchange = authority.exchangeBrowserToken('secret', SECURE_CONNECTION);
    if (exchange.kind !== 'issued') throw new Error('Expected session');
    const cookie = cookieHeader(exchange.cookie);
    const socket = authority.authenticateBrowserSocket(cookie, SECURE_CONNECTION);
    if (!socket) throw new Error('Expected socket authentication');

    now += REMOTE_SESSION_LIFETIMES.idleMs - 1;
    const refreshed = authority.refreshSocketAuthentication(socket);
    expect(refreshed?.expiresAt).toBe(now + REMOTE_SESSION_LIFETIMES.idleMs);
    now += 2;
    expect(authority.getCurrentAuthentication(socket)).not.toBeNull();

    authority.logout(cookie);
    expect(authority.getCurrentAuthentication(socket)).toBeNull();
    expect(invalidated).toHaveLength(1);
  });

  it('revokes generations on logout, grant replacement, and token replacement', () => {
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      randomBytes: (size) => Buffer.alloc(size, size),
      workspacePrincipalId: 'workspace-owner',
    });
    const issue = () => {
      const result = authority.exchangeBrowserToken('secret', SECURE_CONNECTION);
      if (result.kind !== 'issued') throw new Error(`Unexpected exchange ${result.kind}`);
      return result.cookie;
    };

    const first = issue();
    authority.logout(cookieHeader(first));
    expect(authority.refreshBrowserSession(cookieHeader(first), SECURE_CONNECTION).kind).toBe(
      'unauthenticated',
    );

    const second = issue();
    authority.replaceGrants(new Set(['catalog:read']));
    expect(authority.refreshBrowserSession(cookieHeader(second), SECURE_CONNECTION).kind).toBe(
      'unauthenticated',
    );

    const third = issue();
    authority.replaceAccessToken('replacement');
    expect(authority.refreshBrowserSession(cookieHeader(third), SECURE_CONNECTION).kind).toBe(
      'unauthenticated',
    );
    expect(authority.exchangeBrowserToken('secret', SECURE_CONNECTION).kind).toBe('denied');
    expect(authority.exchangeBrowserToken('replacement', SECURE_CONNECTION).kind).toBe('issued');
  });

  it('requires secure direct-peer evidence and bounds exchange attempts', () => {
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      randomBytes: (size) => Buffer.alloc(size, size),
      workspacePrincipalId: 'workspace-owner',
    });
    expect(
      authority.exchangeBrowserToken('secret', {
        ...SECURE_CONNECTION,
        transportSecure: false,
      }).kind,
    ).toBe('secure-transport-required');
    expect(
      authority.exchangeBrowserToken('secret', {
        ...SECURE_CONNECTION,
        directPeerValidated: false,
      }).kind,
    ).toBe('untrusted-peer');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(authority.exchangeBrowserToken('wrong', SECURE_CONNECTION).kind).toBe('denied');
    }
    expect(authority.exchangeBrowserToken('secret', SECURE_CONNECTION).kind).toBe('rate-limited');
  });

  it('issues bounded bearer sessions without accepting the bootstrap secret directly', () => {
    let now = 1_000;
    const authority = createRemoteSessionAuthority({
      accessToken: 'secret',
      grants: GRANTS,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, size),
      workspacePrincipalId: 'workspace-owner',
    });
    expect(authority.authenticateBearerRequest('Bearer secret', SECURE_CONNECTION)).toBeNull();
    const exchange = authority.exchangeBearerToken('secret', SECURE_CONNECTION);
    expect(exchange.kind).toBe('issued');
    if (exchange.kind !== 'issued') return;
    expect(
      authority.authenticateBearerRequest(`Bearer ${exchange.bearer}`, SECURE_CONNECTION),
    ).toMatchObject({ kind: 'bearer', principalId: 'workspace-owner' });
    now += REMOTE_SESSION_LIFETIMES.bearerAbsoluteMs;
    expect(
      authority.authenticateBearerRequest(`Bearer ${exchange.bearer}`, SECURE_CONNECTION),
    ).toBeNull();
  });
});
