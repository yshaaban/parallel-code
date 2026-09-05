import { randomBytes, timingSafeEqual } from 'crypto';
import type { RemoteCommandAuthentication, RemoteGrant } from '../ipc/remote-command-gateway.js';

export const REMOTE_SESSION_COOKIE_NAME = '__Host-parallel_code_session';
export const REMOTE_SESSION_CSRF_HEADER = 'x-parallel-code-csrf';
export const REMOTE_SESSION_LIFETIMES = Object.freeze({
  absoluteMs: 8 * 60 * 60 * 1000,
  bearerAbsoluteMs: 15 * 60 * 1000,
  csrfRotationMs: 15 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
});

const MAX_AUTH_SESSIONS = 256;
const MAX_EXCHANGE_SOURCES = 1024;
const MAX_EXCHANGES_PER_WINDOW = 8;
const EXCHANGE_WINDOW_MS = 60_000;
const SAFE_SOURCE_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;

export interface RemoteConnectionEvidence {
  directPeerValidated: boolean;
  expectedOrigin: string | null;
  origin: string | null;
  sourceId?: string | null;
  transportSecure: boolean;
}

interface BrowserSessionRecord {
  absoluteExpiresAt: number;
  authenticationSessionGeneration: string;
  csrf: string;
  idleExpiresAt: number;
  rotateAt: number;
}

interface BearerSessionRecord {
  authenticationSessionGeneration: string;
  expiresAt: number;
}

export type RemoteSessionExchangeResult =
  | {
      absoluteExpiresAt: number;
      cookie: string;
      kind: 'issued';
    }
  | { kind: 'denied' | 'rate-limited' | 'secure-transport-required' | 'untrusted-peer' };

export type RemoteSessionRefreshResult =
  | {
      authentication: RemoteCommandAuthentication;
      cookie?: string;
      csrf: string;
      kind: 'current';
    }
  | { kind: 'unauthenticated' };

export type RemoteBearerExchangeResult =
  | { bearer: string; expiresAt: number; kind: 'issued' }
  | { kind: 'denied' | 'rate-limited' | 'secure-transport-required' | 'untrusted-peer' };

export interface RemoteSessionAuthorityOptions {
  accessToken: string;
  grants: ReadonlySet<RemoteGrant>;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  workspacePrincipalId: string;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!header) return result;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const encodedValue = part.slice(separator + 1).trim();
    try {
      result.set(name, decodeURIComponent(encodedValue));
    } catch {
      // A malformed cookie is ignored instead of being treated as identity.
    }
  }
  return result;
}

function createSessionCookie(sessionId: string, absoluteExpiresAt: number, now: number): string {
  const maxAgeSeconds = Math.max(0, Math.floor((absoluteExpiresAt - now) / 1000));
  return [
    `${REMOTE_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function createRemoteSessionClearCookie(): string {
  return [
    `${REMOTE_SESSION_COOKIE_NAME}=`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ].join('; ');
}

function isValidSourceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && SAFE_SOURCE_ID.test(value);
}

/**
 * Boot-local authentication owner shared by standalone and Electron remote
 * hosts. It creates identity/grants; request payloads and adapters cannot.
 */
export class RemoteSessionAuthority {
  private accessToken: string;
  private authEpoch = 1;
  private readonly bearerSessions = new Map<string, BearerSessionRecord>();
  private readonly browserSessions = new Map<string, BrowserSessionRecord>();
  private exchangeAttempts = new Map<string, number[]>();
  private grants: ReadonlySet<RemoteGrant>;
  private readonly invalidationListeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;

  constructor(private readonly options: RemoteSessionAuthorityOptions) {
    if (!options.accessToken) throw new TypeError('Remote access token cannot be empty');
    if (!SAFE_SOURCE_ID.test(options.workspacePrincipalId)) {
      throw new TypeError('Remote workspace principal is invalid');
    }
    this.accessToken = options.accessToken;
    this.grants = new Set(options.grants);
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? randomBytes;
  }

  exchangeBrowserToken(
    candidate: string | null,
    evidence: RemoteConnectionEvidence,
  ): RemoteSessionExchangeResult {
    const transportError = this.getIssuanceTransportError(evidence);
    if (transportError) return { kind: transportError };
    if (!this.consumeExchangeQuota(evidence.sourceId)) return { kind: 'rate-limited' };
    if (candidate === null || !safeEqual(candidate, this.accessToken)) return { kind: 'denied' };
    this.pruneExpired();
    if (this.browserSessions.size + this.bearerSessions.size >= MAX_AUTH_SESSIONS) {
      return { kind: 'rate-limited' };
    }

    const now = this.readNow();
    const sessionId = this.randomToken(32);
    const absoluteExpiresAt = now + REMOTE_SESSION_LIFETIMES.absoluteMs;
    this.browserSessions.set(sessionId, {
      absoluteExpiresAt,
      authenticationSessionGeneration: this.randomToken(16),
      csrf: this.randomToken(32),
      idleExpiresAt: now + REMOTE_SESSION_LIFETIMES.idleMs,
      rotateAt: now + REMOTE_SESSION_LIFETIMES.csrfRotationMs,
    });
    return {
      absoluteExpiresAt,
      cookie: createSessionCookie(sessionId, absoluteExpiresAt, now),
      kind: 'issued',
    };
  }

  refreshBrowserSession(
    cookieHeader: string | undefined,
    evidence: RemoteConnectionEvidence,
  ): RemoteSessionRefreshResult {
    if (!this.isAcceptedBrowserReadEvidence(evidence)) {
      return { kind: 'unauthenticated' };
    }
    const current = this.getBrowserSession(cookieHeader);
    if (!current) return { kind: 'unauthenticated' };
    const now = this.readNow();
    let { sessionId, record } = current;
    let cookie: string | undefined;
    if (record.rotateAt <= now) {
      this.browserSessions.delete(sessionId);
      sessionId = this.randomToken(32);
      record = {
        ...record,
        csrf: this.randomToken(32),
        rotateAt: now + REMOTE_SESSION_LIFETIMES.csrfRotationMs,
      };
      this.browserSessions.set(sessionId, record);
      cookie = createSessionCookie(sessionId, record.absoluteExpiresAt, now);
    }
    record.idleExpiresAt = Math.min(
      record.absoluteExpiresAt,
      now + REMOTE_SESSION_LIFETIMES.idleMs,
    );
    const authentication = this.createAuthentication(
      'browser-session',
      record.authenticationSessionGeneration,
      record.idleExpiresAt,
      evidence,
      true,
    );
    return {
      authentication,
      ...(cookie ? { cookie } : {}),
      csrf: record.csrf,
      kind: 'current',
    };
  }

  authenticateBrowserRequest(
    cookieHeader: string | undefined,
    csrf: string | undefined,
    evidence: RemoteConnectionEvidence,
  ): RemoteCommandAuthentication | null {
    const current = this.getBrowserSession(cookieHeader);
    if (!current) return null;
    const { record } = current;
    return this.createAuthentication(
      'browser-session',
      record.authenticationSessionGeneration,
      record.idleExpiresAt,
      evidence,
      typeof csrf === 'string' && safeEqual(csrf, record.csrf),
    );
  }

  authenticateBrowserSocket(
    cookieHeader: string | undefined,
    evidence: RemoteConnectionEvidence,
  ): RemoteCommandAuthentication | null {
    if (
      evidence.transportSecure !== true ||
      evidence.directPeerValidated !== true ||
      evidence.origin === null ||
      evidence.expectedOrigin === null ||
      evidence.origin !== evidence.expectedOrigin
    ) {
      return null;
    }
    const current = this.getBrowserSession(cookieHeader);
    if (!current) return null;
    const { record } = current;
    const originValidated =
      evidence.origin !== null &&
      evidence.expectedOrigin !== null &&
      evidence.origin === evidence.expectedOrigin;
    return this.recordBrowserSessionActivity(
      this.createAuthentication(
        'browser-session',
        record.authenticationSessionGeneration,
        record.idleExpiresAt,
        evidence,
        originValidated,
      ),
    );
  }

  exchangeBearerToken(
    candidate: string | null,
    evidence: RemoteConnectionEvidence,
  ): RemoteBearerExchangeResult {
    const transportError = this.getIssuanceTransportError(evidence);
    if (transportError) return { kind: transportError };
    if (!this.consumeExchangeQuota(evidence.sourceId)) return { kind: 'rate-limited' };
    if (candidate === null || !safeEqual(candidate, this.accessToken)) return { kind: 'denied' };
    this.pruneExpired();
    if (this.browserSessions.size + this.bearerSessions.size >= MAX_AUTH_SESSIONS) {
      return { kind: 'rate-limited' };
    }
    const bearer = this.randomToken(32);
    const expiresAt = this.readNow() + REMOTE_SESSION_LIFETIMES.bearerAbsoluteMs;
    this.bearerSessions.set(bearer, {
      authenticationSessionGeneration: this.randomToken(16),
      expiresAt,
    });
    return { bearer, expiresAt, kind: 'issued' };
  }

  authenticateBearerRequest(
    authorization: string | undefined,
    evidence: RemoteConnectionEvidence,
  ): RemoteCommandAuthentication | null {
    if (!authorization?.startsWith('Bearer ')) return null;
    const bearer = authorization.slice('Bearer '.length);
    const record = this.bearerSessions.get(bearer);
    if (!record || record.expiresAt <= this.readNow()) {
      if (record) this.bearerSessions.delete(bearer);
      return null;
    }
    return this.createAuthentication(
      'bearer',
      record.authenticationSessionGeneration,
      record.expiresAt,
      evidence,
      true,
    );
  }

  logout(cookieHeader: string | undefined): void {
    const sessionId = parseCookies(cookieHeader).get(REMOTE_SESSION_COOKIE_NAME);
    if (sessionId && this.browserSessions.delete(sessionId)) this.notifyInvalidation();
  }

  /** Revalidates boot epoch, generation, grants, and the owner's live expiry. */
  getCurrentAuthentication(
    authentication: RemoteCommandAuthentication,
  ): RemoteCommandAuthentication | null {
    if (
      authentication.authEpoch !== String(this.authEpoch) ||
      authentication.principalId !== this.options.workspacePrincipalId ||
      (authentication.kind !== 'browser-session' && authentication.kind !== 'bearer')
    ) {
      return null;
    }
    this.pruneExpired();
    const expiresAt = this.getGenerationExpiry(authentication);
    if (expiresAt === null) return null;
    return {
      ...authentication,
      expiresAt,
      grants: new Set(this.grants),
    };
  }

  /** Counts an authenticated socket message as browser-session activity. */
  refreshSocketAuthentication(
    authentication: RemoteCommandAuthentication,
  ): RemoteCommandAuthentication | null {
    const current = this.getCurrentAuthentication(authentication);
    if (
      !current ||
      current.transportSecure !== true ||
      current.directPeerValidated !== true ||
      current.originValidated !== true
    ) {
      return null;
    }
    if (current.kind === 'browser-session') {
      return this.recordBrowserSessionActivity(current);
    }
    return current;
  }

  /**
   * Records activity only after a request owner has accepted all transport,
   * Origin, CSRF, grant, and shape checks. Merely parsing a valid cookie must
   * never keep a rejected request alive.
   */
  recordBrowserSessionActivity(
    authentication: RemoteCommandAuthentication,
  ): RemoteCommandAuthentication | null {
    const current = this.getCurrentAuthentication(authentication);
    if (!current || current.kind !== 'browser-session') return null;
    const record = this.findBrowserSessionByGeneration(current.authenticationSessionGeneration);
    if (!record) return null;
    const now = this.readNow();
    record.idleExpiresAt = Math.min(
      record.absoluteExpiresAt,
      now + REMOTE_SESSION_LIFETIMES.idleMs,
    );
    return { ...current, expiresAt: record.idleExpiresAt };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  replaceAccessToken(accessToken: string): void {
    if (!accessToken) throw new TypeError('Remote access token cannot be empty');
    this.accessToken = accessToken;
    this.revokeAll();
  }

  replaceGrants(grants: ReadonlySet<RemoteGrant>): void {
    this.grants = new Set(grants);
    this.revokeAll();
  }

  revokeAll(): void {
    this.authEpoch += 1;
    this.browserSessions.clear();
    this.bearerSessions.clear();
    this.exchangeAttempts.clear();
    this.notifyInvalidation();
  }

  private findBrowserSessionByGeneration(generation: string): BrowserSessionRecord | null {
    for (const record of this.browserSessions.values()) {
      if (record.authenticationSessionGeneration === generation) return record;
    }
    return null;
  }

  private getGenerationExpiry(authentication: RemoteCommandAuthentication): number | null {
    if (authentication.kind === 'browser-session') {
      return (
        this.findBrowserSessionByGeneration(authentication.authenticationSessionGeneration)
          ?.idleExpiresAt ?? null
      );
    }
    for (const record of this.bearerSessions.values()) {
      if (
        record.authenticationSessionGeneration === authentication.authenticationSessionGeneration
      ) {
        return record.expiresAt;
      }
    }
    return null;
  }

  private notifyInvalidation(): void {
    for (const listener of this.invalidationListeners) listener();
  }

  private consumeExchangeQuota(sourceId: string | null | undefined): boolean {
    const key = isValidSourceId(sourceId) ? sourceId : 'unknown-peer';
    const now = this.readNow();
    const cutoff = now - EXCHANGE_WINDOW_MS;
    const attempts = (this.exchangeAttempts.get(key) ?? []).filter((entry) => entry > cutoff);
    if (attempts.length >= MAX_EXCHANGES_PER_WINDOW) return false;
    attempts.push(now);
    this.exchangeAttempts.delete(key);
    this.exchangeAttempts.set(key, attempts);
    while (this.exchangeAttempts.size > MAX_EXCHANGE_SOURCES) {
      const oldest = this.exchangeAttempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.exchangeAttempts.delete(oldest);
    }
    return true;
  }

  private createAuthentication(
    kind: 'bearer' | 'browser-session',
    authenticationSessionGeneration: string,
    expiresAt: number,
    evidence: RemoteConnectionEvidence,
    csrfValidated: boolean,
  ): RemoteCommandAuthentication {
    return {
      authEpoch: String(this.authEpoch),
      authenticationSessionGeneration,
      csrfValidated,
      directPeerValidated: evidence.directPeerValidated,
      expiresAt,
      grants: new Set(this.grants),
      kind,
      originValidated:
        evidence.origin !== null &&
        evidence.expectedOrigin !== null &&
        evidence.origin === evidence.expectedOrigin,
      principalId: this.options.workspacePrincipalId,
      sourceId: isValidSourceId(evidence.sourceId) ? evidence.sourceId : null,
      transportSecure: evidence.transportSecure,
    };
  }

  private getBrowserSession(
    cookieHeader: string | undefined,
  ): { record: BrowserSessionRecord; sessionId: string } | null {
    const sessionId = parseCookies(cookieHeader).get(REMOTE_SESSION_COOKIE_NAME);
    if (!sessionId) return null;
    const record = this.browserSessions.get(sessionId);
    const now = this.readNow();
    if (!record || record.absoluteExpiresAt <= now || record.idleExpiresAt <= now) {
      if (record) this.browserSessions.delete(sessionId);
      return null;
    }
    return { record, sessionId };
  }

  private getIssuanceTransportError(
    evidence: RemoteConnectionEvidence,
  ): 'secure-transport-required' | 'untrusted-peer' | null {
    if (!evidence.transportSecure) return 'secure-transport-required';
    if (!evidence.directPeerValidated) return 'untrusted-peer';
    return null;
  }

  private isAcceptedBrowserReadEvidence(evidence: RemoteConnectionEvidence): boolean {
    return (
      evidence.transportSecure === true &&
      evidence.directPeerValidated === true &&
      evidence.expectedOrigin !== null &&
      (evidence.origin === null || evidence.origin === evidence.expectedOrigin)
    );
  }

  private pruneExpired(): void {
    const now = this.readNow();
    for (const [id, record] of this.browserSessions) {
      if (record.absoluteExpiresAt <= now || record.idleExpiresAt <= now) {
        this.browserSessions.delete(id);
      }
    }
    for (const [id, record] of this.bearerSessions) {
      if (record.expiresAt <= now) this.bearerSessions.delete(id);
    }
  }

  private randomToken(bytes: number): string {
    const value = this.random(bytes);
    if (value.byteLength !== bytes)
      throw new Error('Remote auth entropy source returned wrong size');
    return value.toString('base64url');
  }

  private readNow(): number {
    const value = this.now();
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }
}

export function createRemoteSessionAuthority(
  options: RemoteSessionAuthorityOptions,
): RemoteSessionAuthority {
  return new RemoteSessionAuthority(options);
}
