import type { IncomingMessage, ServerResponse } from 'http';
import {
  getRemoteCommandPolicy,
  isRemoteCommandName,
  type RemoteCommandAuthentication,
  type RemoteCommandGateway,
  type RemoteCommandGatewayErrorCode,
  type RemoteCommandGatewayResult,
  type RemoteCommandName,
} from '../ipc/remote-command-gateway.js';

export const REMOTE_COMMAND_HTTP_PATH_PREFIX = '/api/commands/';
export const REMOTE_COMMAND_HTTP_MAX_BODY_BYTES = 1024 * 1024;

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

const BASE_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

export interface RemoteCommandHttpAuthenticationContext {
  command: RemoteCommandName;
  effect: ReturnType<typeof getRemoteCommandPolicy>['effect'];
  request: IncomingMessage;
}

export type RemoteCommandHttpEdgeErrorCode =
  | 'bad-request'
  | 'internal-error'
  | 'payload-too-large'
  | 'unsupported-media-type';

export type RemoteCommandHttpOutcome =
  | { kind: 'edge-error'; code: RemoteCommandHttpEdgeErrorCode }
  | { kind: 'gateway'; result: RemoteCommandGatewayResult };

export interface RemoteCommandHttpResponse {
  body: unknown;
  retryAfterMs?: number;
  status: number;
}

export type RemoteCommandHttpResponseAdapter = (
  outcome: Readonly<RemoteCommandHttpOutcome>,
) => RemoteCommandHttpResponse;

export type RemoteCommandHttpResponseAdapterTable = Partial<
  Record<RemoteCommandName, RemoteCommandHttpResponseAdapter>
>;

export interface CreateRemoteCommandHttpHandlerOptions {
  authenticate(
    context: RemoteCommandHttpAuthenticationContext,
  ): Promise<RemoteCommandAuthentication | null> | RemoteCommandAuthentication | null;
  gateway: RemoteCommandGateway;
  maxBodyBytes?: number;
  onAcceptedAuthentication?: (
    authentication: RemoteCommandAuthentication,
    context: RemoteCommandHttpAuthenticationContext,
  ) => void;
  onInternalError?: (error: unknown) => void;
  responseAdapters?: RemoteCommandHttpResponseAdapterTable;
}

type ParsedBodyResult =
  | { byteLength: number; kind: 'body'; value: unknown }
  | { kind: 'aborted' | 'bad-request' | 'payload-too-large' };

function getHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function getCommand(request: IncomingMessage): RemoteCommandName | null {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://remote.invalid');
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(REMOTE_COMMAND_HTTP_PATH_PREFIX)) return null;
  const command = url.pathname.slice(REMOTE_COMMAND_HTTP_PATH_PREFIX.length);
  return !command.includes('/') && isRemoteCommandName(command) ? command : null;
}

function statusForGatewayError(code: RemoteCommandGatewayErrorCode): number {
  switch (code) {
    case 'bad-request':
      return 400;
    case 'unauthenticated':
      return 401;
    case 'csrf-rejected':
    case 'forbidden':
    case 'origin-rejected':
    case 'secure-transport-required':
    case 'untrusted-peer':
      return 403;
    case 'unsupported-command':
      return 404;
    case 'payload-too-large':
      return 413;
    case 'rate-limited':
      return 429;
    case 'gateway-draining':
      return 503;
    case 'request-aborted':
      return 499;
    case 'internal-error':
      return 500;
  }
}

function defaultHttpResponse(
  outcome: Readonly<RemoteCommandHttpOutcome>,
): RemoteCommandHttpResponse {
  if (outcome.kind === 'gateway') {
    return outcome.result.ok
      ? { body: outcome.result, status: 200 }
      : {
          body: outcome.result,
          ...(outcome.result.error.retryAfterMs !== undefined
            ? { retryAfterMs: outcome.result.error.retryAfterMs }
            : {}),
          status: statusForGatewayError(outcome.result.error.code),
        };
  }

  switch (outcome.code) {
    case 'bad-request':
      return { body: { error: { code: 'bad-request' } }, status: 400 };
    case 'internal-error':
      return { body: { error: { code: 'internal-error' } }, status: 500 };
    case 'payload-too-large':
      return { body: { error: { code: 'payload-too-large' } }, status: 413 };
    case 'unsupported-media-type':
      return { body: { error: { code: 'bad-request' } }, status: 415 };
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  retryAfterMs?: number,
): void {
  if (response.writableEnded) return;
  const headers: Record<string, string> = { ...BASE_SECURITY_HEADERS };
  if (retryAfterMs !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<ParsedBodyResult> {
  const contentLength = getHeader(request, 'content-length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) return Promise.resolve({ kind: 'bad-request' });
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) return Promise.resolve({ kind: 'bad-request' });
    if (declaredBytes > maxBodyBytes) {
      request.resume();
      return Promise.resolve({ kind: 'payload-too-large' });
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const settle = (result: ParsedBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on('aborted', () => settle({ kind: 'aborted' }));
    request.on('error', () => settle({ kind: 'bad-request' }));
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBodyBytes) {
        chunks.length = 0;
        settle({ kind: 'payload-too-large' });
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        const source = Buffer.concat(chunks, bytes).toString('utf8');
        settle({ byteLength: bytes, kind: 'body', value: JSON.parse(source) as unknown });
      } catch {
        settle({ kind: 'bad-request' });
      }
    });
  });
}

function requireBodyLimit(value: number | undefined): number {
  const limit = value ?? REMOTE_COMMAND_HTTP_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REMOTE_COMMAND_HTTP_MAX_BODY_BYTES) {
    throw new TypeError('Remote HTTP body limit must be between 1 byte and 1 MiB');
  }
  return limit;
}

/**
 * Shared raw-HTTP adapter for both standalone and Electron remote hosts. It
 * owns HTTP parsing/status/header policy only; the gateway remains the sole
 * command, grant, and concurrency authority.
 */
export function createRemoteCommandHttpHandler(
  options: CreateRemoteCommandHttpHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const maxBodyBytes = requireBodyLimit(options.maxBodyBytes);

  const writeOutcome = (
    response: ServerResponse,
    command: RemoteCommandName,
    outcome: Readonly<RemoteCommandHttpOutcome>,
  ): void => {
    const mapped = options.responseAdapters?.[command]?.(outcome) ?? defaultHttpResponse(outcome);
    writeJson(response, mapped.status, mapped.body, mapped.retryAfterMs);
  };

  return async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://remote.invalid').pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(REMOTE_COMMAND_HTTP_PATH_PREFIX)) return false;

    if (request.method !== 'POST') {
      writeJson(response, 405, { error: { code: 'bad-request' } });
      return true;
    }
    const command = getCommand(request);
    if (!command) {
      writeJson(response, 404, { error: { code: 'unsupported-command' } });
      return true;
    }
    const contentType = getHeader(request, 'content-type');
    if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) {
      writeOutcome(response, command, {
        code: 'unsupported-media-type',
        kind: 'edge-error',
      });
      return true;
    }

    const authenticationContext: RemoteCommandHttpAuthenticationContext = {
      command,
      effect: getRemoteCommandPolicy(command).effect,
      request,
    };
    let authentication: RemoteCommandAuthentication | null;
    try {
      authentication = await options.authenticate(authenticationContext);
    } catch (error) {
      options.onInternalError?.(error);
      writeOutcome(response, command, { code: 'internal-error', kind: 'edge-error' });
      return true;
    }

    const parsed = await readJsonBody(request, maxBodyBytes);
    if (parsed.kind === 'payload-too-large') {
      writeOutcome(response, command, { code: 'payload-too-large', kind: 'edge-error' });
      return true;
    }
    if (parsed.kind !== 'body') {
      writeOutcome(response, command, { code: 'bad-request', kind: 'edge-error' });
      return true;
    }

    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const result = await options.gateway.dispatch(
        command,
        authentication,
        parsed.value,
        abortController.signal,
        parsed.byteLength,
      );
      if (result.ok) {
        if (authentication) {
          try {
            options.onAcceptedAuthentication?.(authentication, authenticationContext);
          } catch (error) {
            options.onInternalError?.(error);
          }
        }
      }
      writeOutcome(response, command, { kind: 'gateway', result });
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
    return true;
  };
}
