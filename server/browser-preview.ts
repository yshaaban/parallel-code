import type { IncomingMessage, Server as HttpServer } from 'http';
import type express from 'express';
import httpProxy from 'http-proxy';
import { Socket } from 'net';
import type { TaskExposedPort } from '../src/domain/server-state.js';

const PREVIEW_COOKIE = 'parallel_preview_token';
const PREVIEW_ROUTE_PREFIX = '/_preview';

interface BrowserPreviewRequest {
  headers: IncomingMessage['headers'];
  url: string | undefined;
}

interface PreviewRouteMatch {
  forwardedSearch: string;
  pathRemainder: string;
  port: number;
  taskId: string;
}

export interface RegisterBrowserPreviewRoutesOptions {
  app: express.Express;
  isAuthorizedRequest: (request: express.Request) => boolean;
  resolveExposedTaskPort: (taskId: string, port: number) => TaskExposedPort | undefined;
  safeCompareToken: (token: string | null) => boolean;
  server: HttpServer;
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

    cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
  }

  return cookies;
}

function stripPreviewCookie(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const remaining = header
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(`${PREVIEW_COOKIE}=`));

  return remaining.length > 0 ? remaining.join('; ') : undefined;
}

function stripPreviewAuthHeaders(headers: IncomingMessage['headers']): void {
  delete headers.authorization;
  const cookieHeader = stripPreviewCookie(headers.cookie);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
    return;
  }

  delete headers.cookie;
}

function getRequestToken(request: BrowserPreviewRequest): string | null {
  const rawUrl = request.url ?? '/';
  const url = new URL(rawUrl, 'http://localhost');
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7);
  }

  return parseCookies(request.headers.cookie).get(PREVIEW_COOKIE) ?? null;
}

function isAuthorizedPreviewRequest(
  request: BrowserPreviewRequest,
  safeCompareToken: (token: string | null) => boolean,
): boolean {
  return safeCompareToken(getRequestToken(request));
}

function parsePreviewRoutePath(url: string | undefined): PreviewRouteMatch | null {
  const parsedUrl = new URL(url ?? '/', 'http://localhost');
  parsedUrl.searchParams.delete('token');
  const pathname = parsedUrl.pathname;
  const match = /^\/_preview\/([^/]+)\/(\d+)(\/.*)?$/u.exec(pathname);
  if (!match) {
    return null;
  }

  const taskId = decodeURIComponent(match[1] ?? '');
  const port = Number.parseInt(match[2] ?? '', 10);
  if (!taskId || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return {
    taskId,
    port,
    pathRemainder: match[3] ?? '/',
    forwardedSearch: parsedUrl.searchParams.size > 0 ? `?${parsedUrl.searchParams.toString()}` : '',
  };
}

function getPreviewBasePath(taskId: string, port: number): string {
  return `${PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${port}`;
}

function rewriteHtmlForPreview(html: string, previewBasePath: string): string {
  const normalizedBasePath = `${previewBasePath}/`;
  const rewritten = html
    .replace(/((?:src|href|action)=["'])\/(?!\/)/giu, `$1${normalizedBasePath}`)
    .replace(/(url\(["']?)\/(?!\/)/giu, `$1${normalizedBasePath}`);
  return rewritten.replace(/(<head[^>]*>)/iu, `$1<base href="${normalizedBasePath}">`);
}

function rewriteLocationHeader(location: string, previewBasePath: string, port: number): string {
  const directPrefix = `http://127.0.0.1:${port}`;
  const localPrefix = `http://localhost:${port}`;

  if (location.startsWith(directPrefix)) {
    return `${previewBasePath}${location.slice(directPrefix.length)}`;
  }
  if (location.startsWith(localPrefix)) {
    return `${previewBasePath}${location.slice(localPrefix.length)}`;
  }
  if (location.startsWith('/')) {
    return `${previewBasePath}${location}`;
  }

  return location;
}

function rewriteSetCookieHeaders(
  headers: string[] | undefined,
  previewBasePath: string,
): string[] | undefined {
  if (!headers) {
    return undefined;
  }

  return headers.map((header) => {
    if (/;\s*path=/iu.test(header)) {
      return header.replace(/;\s*path=[^;]*/iu, `; Path=${previewBasePath}`);
    }

    return `${header}; Path=${previewBasePath}`;
  });
}

function copyProxyHeaders(
  response: express.Response,
  headers: IncomingMessage['headers'],
  previewBasePath: string,
  port: number,
): void {
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) {
      continue;
    }
    if (
      headerName === 'content-length' ||
      headerName === 'x-frame-options' ||
      headerName === 'content-security-policy' ||
      headerName === 'set-cookie' ||
      headerName === 'location' ||
      headerName === 'content-encoding'
    ) {
      continue;
    }

    response.setHeader(headerName, headerValue);
  }

  const location = headers.location;
  if (location) {
    response.setHeader('location', rewriteLocationHeader(String(location), previewBasePath, port));
  }

  const rewrittenCookies = rewriteSetCookieHeaders(
    Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : undefined,
    previewBasePath,
  );
  if (rewrittenCookies) {
    response.setHeader('set-cookie', rewrittenCookies);
  }
}

function sendUnauthorized(res: express.Response): void {
  res.status(401).send('Unauthorized');
}

export function registerBrowserPreviewRoutes(
  options: RegisterBrowserPreviewRoutesOptions,
): () => void {
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    xfwd: true,
    selfHandleResponse: true,
  });

  proxy.on('proxyRes', (proxyRes, req, res) => {
    const request = req as express.Request;
    const response = res as express.Response;
    const match = parsePreviewRoutePath(request.originalUrl);
    if (!match) {
      response.status(proxyRes.statusCode ?? 502).end();
      return;
    }

    const previewBasePath = getPreviewBasePath(match.taskId, match.port);
    const contentType = String(proxyRes.headers['content-type'] ?? '');
    copyProxyHeaders(response, proxyRes.headers, previewBasePath, match.port);

    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);
      if (contentType.includes('text/html')) {
        const rewrittenHtml = rewriteHtmlForPreview(body.toString('utf8'), previewBasePath);
        response.status(proxyRes.statusCode ?? 200).send(rewrittenHtml);
        return;
      }

      response.status(proxyRes.statusCode ?? 200).send(body);
    });
  });

  proxy.on('error', (_error, _req, res) => {
    if (res instanceof Socket) {
      res.destroy();
      return;
    }

    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Preview unavailable');
  });

  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.setHeader('accept-encoding', 'identity');
    proxyReq.removeHeader('authorization');
    const cookieHeader = stripPreviewCookie(proxyReq.getHeader('cookie')?.toString());
    if (cookieHeader) {
      proxyReq.setHeader('cookie', cookieHeader);
      return;
    }

    proxyReq.removeHeader('cookie');
  });

  options.app.use('/_preview/:taskId/:port', (req, res) => {
    const routeTaskId = typeof req.params.taskId === 'string' ? req.params.taskId : '';
    const routePort = Number.parseInt(String(req.params.port ?? ''), 10);
    if (!routeTaskId || !Number.isInteger(routePort)) {
      res.status(404).send('Preview not found');
      return;
    }
    if (
      !isAuthorizedPreviewRequest(req, options.safeCompareToken) &&
      !options.isAuthorizedRequest(req)
    ) {
      sendUnauthorized(res);
      return;
    }

    const exposedPort = options.resolveExposedTaskPort(routeTaskId, routePort);
    if (!exposedPort) {
      res.status(404).send('Preview not found');
      return;
    }

    const token = getRequestToken(req);
    if (token) {
      res.setHeader(
        'set-cookie',
        `${PREVIEW_COOKIE}=${encodeURIComponent(token)}; Path=${PREVIEW_ROUTE_PREFIX}; HttpOnly; SameSite=Lax`,
      );
    }

    const forwardedUrl = new URL(req.url, 'http://localhost');
    forwardedUrl.searchParams.delete('token');
    req.url = forwardedUrl.pathname + forwardedUrl.search;
    stripPreviewAuthHeaders(req.headers);

    proxy.web(req, res, {
      target: `${exposedPort.protocol}://127.0.0.1:${exposedPort.port}`,
    });
  });

  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const match = parsePreviewRoutePath(req.url);
    if (!match) {
      return;
    }

    if (
      !isAuthorizedPreviewRequest(
        {
          headers: req.headers,
          url: req.url,
        },
        options.safeCompareToken,
      )
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const exposedPort = options.resolveExposedTaskPort(match.taskId, match.port);
    if (!exposedPort) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    req.url = match.pathRemainder + match.forwardedSearch;
    stripPreviewAuthHeaders(req.headers);
    proxy.ws(req, socket, head, {
      target: `${exposedPort.protocol}://127.0.0.1:${exposedPort.port}`,
    });
  };

  options.server.on('upgrade', handleUpgrade);

  return () => {
    options.server.off('upgrade', handleUpgrade);
    proxy.close();
  };
}
