import type express from 'express';
import type { IncomingHttpHeaders } from 'http';
import { createHash, randomBytes } from 'crypto';

const AUTH_GATE_PATH = '/auth';
const AUTH_BOOTSTRAP_PATH = '/auth/bootstrap';
const SESSION_COOKIE_NAME = 'parallel_code_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const SESSION_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

interface BrowserSessionRecord {
  expiresAt: number;
  tokenVersion: string;
}

export interface BrowserAuthRequestLike {
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string | undefined;
}

export interface CreateBrowserAuthOptions {
  token: string;
}

export interface BrowserAuthController {
  getAuthGatePath: () => string;
  getBootstrapPath: () => string;
  handleBootstrapIfPresent: (req: express.Request, res: express.Response) => boolean;
  isAuthenticatedRequest: (request: BrowserAuthRequestLike) => boolean;
  isAllowedBrowserOrigin: (request: BrowserAuthRequestLike) => boolean;
  isAllowedMutationRequest: (request: BrowserAuthRequestLike) => boolean;
  registerRoutes: (app: express.Express) => void;
}

function createTokenVersion(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }

  for (const chunk of header.split(';')) {
    const [rawName, ...rawValue] = chunk.trim().split('=');
    if (!rawName || rawValue.length === 0) {
      continue;
    }

    try {
      cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
    } catch {
      cookies.set(rawName, rawValue.join('='));
    }
  }

  return cookies;
}

function getRequestUrl(request: BrowserAuthRequestLike): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

function sanitizeNextPath(value: string | null | undefined): string {
  if (!value) {
    return '/';
  }

  if (!value.startsWith('/') || value.startsWith('//')) {
    return '/';
  }

  return value;
}

function getRequestedNextPath(request: BrowserAuthRequestLike): string {
  const requestUrl = getRequestUrl(request);
  const nextParam = requestUrl.searchParams.get('next');
  if (
    (requestUrl.pathname === AUTH_GATE_PATH || requestUrl.pathname === AUTH_BOOTSTRAP_PATH) &&
    nextParam
  ) {
    return sanitizeNextPath(nextParam);
  }

  const strippedUrl = new URL(requestUrl.pathname + requestUrl.search, 'http://localhost');
  strippedUrl.searchParams.delete('token');
  return sanitizeNextPath(
    strippedUrl.pathname +
      (strippedUrl.searchParams.size > 0 ? `?${strippedUrl.searchParams.toString()}` : ''),
  );
}

function getQueryToken(request: BrowserAuthRequestLike): string | null {
  return getRequestUrl(request).searchParams.get('token');
}

function getBearerToken(request: BrowserAuthRequestLike): string | null {
  const authorization = request.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith('Bearer ')) {
    return null;
  }

  return value.slice('Bearer '.length);
}

function isSecureRequest(request: BrowserAuthRequestLike): boolean {
  const protoHeader = request.headers['x-forwarded-proto'];
  const forwardedProto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  if (forwardedProto === 'https') {
    return true;
  }

  const originHeader = request.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin) {
    return false;
  }

  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

function getRequestOrigin(request: BrowserAuthRequestLike): string | null {
  const originHeader = request.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (origin) {
    return origin;
  }

  const refererHeader = request.headers.referer;
  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
  if (!referer) {
    return null;
  }

  try {
    const url = new URL(referer);
    return url.origin;
  } catch {
    return null;
  }
}

function getExpectedOrigin(request: BrowserAuthRequestLike): string | null {
  const host = request.headers.host;
  if (!host) {
    return null;
  }

  return `${isSecureRequest(request) ? 'https' : 'http'}://${host}`;
}

function renderAuthGateHtml(nextPath: string, errorMessage?: string): string {
  const encodedErrorMessage = errorMessage
    ? `<div style="color:#ef4444;font-size:13px;margin-bottom:12px">${escapeHtml(errorMessage)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Parallel Code Sign In</title>
    <meta http-equiv="Cache-Control" content="no-store" />
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0f1115;
        color: #f5f5f5;
        font-family: "JetBrains Mono", monospace;
      }
      .card {
        width: min(420px, calc(100vw - 32px));
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 14px;
        background: rgba(17, 24, 39, 0.92);
        padding: 24px;
        box-sizing: border-box;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 18px;
      }
      p {
        margin: 0 0 18px;
        color: rgba(255,255,255,0.7);
        font-size: 13px;
        line-height: 1.5;
      }
      label {
        display: block;
        margin-bottom: 6px;
        font-size: 12px;
        color: rgba(255,255,255,0.76);
      }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.05);
        color: inherit;
        font: inherit;
      }
      button {
        margin-top: 14px;
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.16);
        background: rgba(255,255,255,0.08);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      button:hover {
        background: rgba(255,255,255,0.12);
      }
      .hint {
        margin-top: 12px;
        font-size: 11px;
        color: rgba(255,255,255,0.52);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Parallel Code</h1>
      <p>Enter the access token for this browser session.</p>
      ${encodedErrorMessage}
      <form method="GET" action="${AUTH_BOOTSTRAP_PATH}">
        <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
        <label for="token">Access token</label>
        <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" />
        <button type="submit">Continue</button>
      </form>
      <div class="hint">This page intentionally exposes no task or project state before authentication.</div>
    </main>
  </body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function createBrowserAuthController(
  options: CreateBrowserAuthOptions,
): BrowserAuthController {
  const sessions = new Map<string, BrowserSessionRecord>();
  const tokenVersion = createTokenVersion(options.token);

  function hasAuthorizedBearerToken(request: BrowserAuthRequestLike): boolean {
    return getBearerToken(request) === options.token;
  }

  function setSessionCookie(
    response: express.Response,
    sessionId: string,
    request: BrowserAuthRequestLike,
  ): void {
    const cookieParts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${Math.floor(SESSION_COOKIE_MAX_AGE_MS / 1000)}`,
    ];

    if (isSecureRequest(request)) {
      cookieParts.push('Secure');
    }

    response.append('Set-Cookie', cookieParts.join('; '));
  }

  function clearSessionCookie(response: express.Response, request: BrowserAuthRequestLike): void {
    const cookieParts = [
      `${SESSION_COOKIE_NAME}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
    ];

    if (isSecureRequest(request)) {
      cookieParts.push('Secure');
    }

    response.append('Set-Cookie', cookieParts.join('; '));
  }

  function issueSession(response: express.Response, request: BrowserAuthRequestLike): void {
    const sessionId = randomBytes(24).toString('base64url');
    sessions.set(sessionId, {
      expiresAt: Date.now() + SESSION_TTL_MS,
      tokenVersion,
    });
    setSessionCookie(response, sessionId, request);
  }

  function sendAuthGate(response: express.Response, nextPath: string, errorMessage?: string): void {
    response
      .status(401)
      .setHeader('Cache-Control', 'no-store, max-age=0')
      .send(renderAuthGateHtml(nextPath, errorMessage));
  }

  function getSessionId(request: BrowserAuthRequestLike): string | null {
    return parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME) ?? null;
  }

  function hasValidSession(request: BrowserAuthRequestLike): boolean {
    const sessionId = getSessionId(request);
    if (!sessionId) {
      return false;
    }

    const record = sessions.get(sessionId);
    if (!record) {
      return false;
    }

    if (record.tokenVersion !== tokenVersion || record.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return false;
    }

    record.expiresAt = Date.now() + SESSION_TTL_MS;
    return true;
  }

  function handleBootstrap(
    req: express.Request,
    res: express.Response,
    nextPathOverride?: string,
  ): boolean {
    const token = getQueryToken(req);
    if (token !== options.token) {
      return false;
    }

    issueSession(res, req);
    const nextPath = sanitizeNextPath(nextPathOverride ?? getRequestedNextPath(req));
    res.redirect(nextPath);
    return true;
  }

  function maybeHandleBootstrap(req: express.Request, res: express.Response): boolean {
    if (req.method !== 'GET') {
      return false;
    }

    const requestUrl = getRequestUrl(req);
    if (!requestUrl.searchParams.has('token')) {
      return false;
    }

    const nextPath = getRequestedNextPath(req);

    if (!handleBootstrap(req, res, nextPath)) {
      sendAuthGate(res, nextPath, 'Invalid access token.');
      return true;
    }

    return true;
  }

  function isAuthenticatedRequest(request: BrowserAuthRequestLike): boolean {
    return hasValidSession(request);
  }

  function isAllowedBrowserOrigin(request: BrowserAuthRequestLike): boolean {
    const origin = getRequestOrigin(request);
    if (!origin) {
      return true;
    }

    const expectedOrigin = getExpectedOrigin(request);
    return expectedOrigin !== null && origin === expectedOrigin;
  }

  function isAllowedMutationRequest(request: BrowserAuthRequestLike): boolean {
    if (hasAuthorizedBearerToken(request)) {
      return true;
    }

    return isAuthenticatedRequest(request) && isAllowedBrowserOrigin(request);
  }

  function registerRoutes(app: express.Express): void {
    app.get(AUTH_GATE_PATH, (req, res) => {
      if (isAuthenticatedRequest(req)) {
        const nextPath = sanitizeNextPath(
          typeof req.query.next === 'string' ? req.query.next : '/',
        );
        res.redirect(nextPath);
        return;
      }

      const nextPath = sanitizeNextPath(typeof req.query.next === 'string' ? req.query.next : '/');
      sendAuthGate(res, nextPath);
    });

    app.get(AUTH_BOOTSTRAP_PATH, (req, res) => {
      const nextPath = sanitizeNextPath(typeof req.query.next === 'string' ? req.query.next : '/');
      if (!handleBootstrap(req, res, nextPath)) {
        sendAuthGate(res, nextPath, 'Invalid access token.');
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      const sessionId = getSessionId(req);
      if (sessionId) {
        sessions.delete(sessionId);
      }
      clearSessionCookie(res, req);
      res.status(204).end();
    });
  }

  return {
    getAuthGatePath: () => AUTH_GATE_PATH,
    getBootstrapPath: () => AUTH_BOOTSTRAP_PATH,
    handleBootstrapIfPresent: maybeHandleBootstrap,
    isAuthenticatedRequest,
    isAllowedBrowserOrigin,
    isAllowedMutationRequest,
    registerRoutes,
  };
}
