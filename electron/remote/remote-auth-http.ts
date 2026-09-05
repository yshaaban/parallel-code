import type { IncomingMessage, ServerResponse } from 'http';
import type { RemoteCommandGateway } from '../ipc/remote-command-gateway.js';
import { validateRemotePeerSocket, type RemotePeerTrustPolicy } from './network.js';
import {
  REMOTE_SESSION_CSRF_HEADER,
  createRemoteSessionClearCookie,
  type RemoteConnectionEvidence,
  type RemoteSessionAuthority,
} from './remote-session-authority.js';

export const REMOTE_AUTH_BOOTSTRAP_PATH = '/auth/bootstrap';
export const REMOTE_AUTH_SESSION_PATH = '/api/auth/session';
export const REMOTE_AUTH_LOGOUT_PATH = '/api/auth/logout';

export interface RemoteAuthHttpPaths {
  bootstrap: string;
  logout: string;
  session: string;
}

export const DEFAULT_REMOTE_AUTH_HTTP_PATHS = Object.freeze({
  bootstrap: REMOTE_AUTH_BOOTSTRAP_PATH,
  logout: REMOTE_AUTH_LOGOUT_PATH,
  session: REMOTE_AUTH_SESSION_PATH,
}) satisfies RemoteAuthHttpPaths;

const AUTH_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Content-Type': 'application/json; charset=utf-8',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

export interface CreateRemoteAuthHttpHandlerOptions {
  authority: RemoteSessionAuthority;
  gateway: RemoteCommandGateway;
  paths?: RemoteAuthHttpPaths;
  peerTrustPolicy: RemotePeerTrustPolicy;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function getSecureSocket(request: IncomingMessage): boolean {
  return (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true;
}

function getRequestOrigin(request: IncomingMessage): string | null {
  return firstHeader(request.headers.origin) ?? null;
}

function getExpectedOrigin(request: IncomingMessage): string | null {
  const host = request.headers.host;
  return host && getSecureSocket(request) ? `https://${host}` : null;
}

export function getRemoteConnectionEvidence(
  request: IncomingMessage,
  peerTrustPolicy: RemotePeerTrustPolicy,
): RemoteConnectionEvidence {
  const socketAddress = {
    ...(request.socket.localAddress ? { localAddress: request.socket.localAddress } : {}),
    ...(request.socket.remoteAddress ? { remoteAddress: request.socket.remoteAddress } : {}),
  };
  return {
    directPeerValidated: validateRemotePeerSocket(socketAddress, peerTrustPolicy),
    expectedOrigin: getExpectedOrigin(request),
    origin: getRequestOrigin(request),
    sourceId: request.socket.remoteAddress ?? null,
    transportSecure: getSecureSocket(request),
  };
}

function sanitizeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const parsed = new URL(value, 'https://remote.invalid');
    parsed.searchParams.delete('token');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(statusCode, { ...AUTH_SECURITY_HEADERS, ...extraHeaders });
  response.end(JSON.stringify(body));
}

function writeRedirect(response: ServerResponse, location: string, cookie: string): void {
  response.writeHead(303, {
    ...AUTH_SECURITY_HEADERS,
    Location: location,
    'Set-Cookie': cookie,
  });
  response.end();
}

/** Secure session routes; each host may namespace them away from its other principals. */
export function createRemoteAuthHttpHandler(
  options: CreateRemoteAuthHttpHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  const paths = options.paths ?? DEFAULT_REMOTE_AUTH_HTTP_PATHS;
  return (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'https://remote.invalid');
    } catch {
      return false;
    }
    const evidence = getRemoteConnectionEvidence(request, options.peerTrustPolicy);

    if (url.pathname === paths.bootstrap) {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method-not-allowed' });
        return true;
      }
      const exchange = options.authority.exchangeBrowserToken(
        url.searchParams.get('token'),
        evidence,
      );
      if (exchange.kind !== 'issued') {
        const status =
          exchange.kind === 'rate-limited' ? 429 : exchange.kind === 'denied' ? 401 : 403;
        writeJson(response, status, { error: exchange.kind });
        return true;
      }
      writeRedirect(response, sanitizeNextPath(url.searchParams.get('next')), exchange.cookie);
      return true;
    }

    if (url.pathname === paths.session) {
      if (request.method !== 'GET' || url.searchParams.has('token')) {
        writeJson(response, request.method === 'GET' ? 400 : 405, { error: 'bad-request' });
        return true;
      }
      const current = options.authority.refreshBrowserSession(request.headers.cookie, evidence);
      if (current.kind !== 'current') {
        writeJson(response, 401, { error: 'unauthenticated' });
        return true;
      }
      writeJson(
        response,
        200,
        {
          capabilities: options.gateway.getCapabilities(current.authentication),
          csrf: current.csrf,
        },
        current.cookie ? { 'Set-Cookie': current.cookie } : {},
      );
      return true;
    }

    if (url.pathname === paths.logout) {
      if (request.method !== 'POST' || url.searchParams.has('token')) {
        writeJson(response, request.method === 'POST' ? 400 : 405, { error: 'bad-request' });
        return true;
      }
      const authentication = options.authority.authenticateBrowserRequest(
        request.headers.cookie,
        firstHeader(request.headers[REMOTE_SESSION_CSRF_HEADER]),
        evidence,
      );
      if (
        !authentication ||
        authentication.transportSecure !== true ||
        authentication.directPeerValidated !== true ||
        authentication.originValidated !== true ||
        authentication.csrfValidated !== true
      ) {
        writeJson(response, 403, { error: 'forbidden' });
        return true;
      }
      options.authority.logout(request.headers.cookie);
      response.writeHead(204, {
        ...AUTH_SECURITY_HEADERS,
        'Set-Cookie': createRemoteSessionClearCookie(),
      });
      response.end();
      return true;
    }

    return false;
  };
}
