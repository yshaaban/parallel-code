import type { ClientRequest, IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import type express from 'express';
import httpProxy from 'http-proxy';
import { Socket } from 'net';

const PREVIEW_ROUTE_PREFIX = '/_preview';
const SESSION_COOKIE_NAME = 'parallel_code_session';

interface PreviewRouteMatch {
  forwardedSearch: string;
  pathRemainder: string;
  port: number;
  taskId: string;
}

export interface RegisterBrowserPreviewRoutesOptions {
  app: express.Express;
  hasExposedTaskPort: (taskId: string, port: number) => boolean;
  isAuthorizedRequest: (request: {
    headers: IncomingMessage['headers'];
    url?: string | undefined;
  }) => boolean;
  isAllowedBrowserOrigin: (request: {
    headers: IncomingMessage['headers'];
    url?: string | undefined;
  }) => boolean;
  markPreviewUnavailable: (taskId: string, port: number) => void;
  resolvePreviewTarget: (taskId: string, port: number) => Promise<string | null>;
  server: HttpServer;
}

function decodeUriComponentSafely(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function stripBrowserSessionCookie(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const remaining = header
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(`${SESSION_COOKIE_NAME}=`));

  return remaining.length > 0 ? remaining.join('; ') : undefined;
}

function stripPreviewAuthHeaders(headers: IncomingMessage['headers']): void {
  delete headers.authorization;
  const cookieHeader = stripBrowserSessionCookie(headers.cookie);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
    return;
  }

  delete headers.cookie;
}

function parsePreviewRoutePath(url: string | undefined): PreviewRouteMatch | null {
  const parsedUrl = new URL(url ?? '/', 'http://localhost');
  parsedUrl.searchParams.delete('token');
  const pathname = parsedUrl.pathname;
  const match = /^\/_preview\/([^/]+)\/(\d+)(\/.*)?$/u.exec(pathname);
  if (!match) {
    return null;
  }

  const taskId = decodeUriComponentSafely(match[1] ?? '');
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

function parseRoutePort(value: unknown): number | null {
  const rawPort = String(value ?? '');
  if (!/^\d+$/u.test(rawPort)) {
    return null;
  }

  const port = Number.parseInt(rawPort, 10);
  return Number.isInteger(port) ? port : null;
}

function rewriteHtmlForPreview(html: string, previewBasePath: string): string {
  const normalizedBasePath = `${previewBasePath}/`;
  const rewritten = html
    .replace(/((?:src|href|action)=["'])\/(?!\/)/giu, `$1${normalizedBasePath}`)
    .replace(/(url\(["']?)\/(?!\/)/giu, `$1${normalizedBasePath}`);
  return rewritten.replace(/(<head[^>]*>)/iu, `$1<base href="${normalizedBasePath}">`);
}

function rewriteLocationHeader(location: string, previewBasePath: string, port: number): string {
  const localPrefixes = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    `https://127.0.0.1:${port}`,
    `https://localhost:${port}`,
    `https://[::1]:${port}`,
  ];

  for (const prefix of localPrefixes) {
    if (location.startsWith(prefix)) {
      return `${previewBasePath}${location.slice(prefix.length)}`;
    }
  }
  if (location.startsWith('/')) {
    return `${previewBasePath}${location}`;
  }

  return location;
}

function rewriteSetCookieHeaders(
  headers: string[] | string | undefined,
  previewBasePath: string,
): string[] | undefined {
  if (!headers) {
    return undefined;
  }

  const headerList = Array.isArray(headers) ? headers : [headers];
  return headerList.map((header) => {
    if (/;\s*path=/iu.test(header)) {
      return header.replace(/;\s*path=[^;]*/iu, `; Path=${previewBasePath}`);
    }

    return `${header}; Path=${previewBasePath}`;
  });
}

function appendSetCookieHeaders(response: express.Response, headers: ReadonlyArray<string>): void {
  if (headers.length === 0) {
    return;
  }

  const current = response.getHeader('set-cookie');
  if (!current) {
    response.setHeader('set-cookie', [...headers]);
    return;
  }

  const existing = Array.isArray(current) ? current.map(String) : [String(current)];
  response.setHeader('set-cookie', [...existing, ...headers]);
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

  const rewrittenCookies = rewriteSetCookieHeaders(headers['set-cookie'], previewBasePath);
  if (rewrittenCookies) {
    appendSetCookieHeaders(response, rewrittenCookies);
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
    secure: false,
  });

  function handleProxyResponse(
    proxyRes: IncomingMessage,
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage> | Socket,
  ): void {
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
  }

  function handleProxyError(
    _error: Error,
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage> | Socket,
  ): void {
    const match = parsePreviewRoutePath(req.url);
    if (match) {
      options.markPreviewUnavailable(match.taskId, match.port);
    }

    if (res instanceof Socket) {
      res.destroy();
      return;
    }

    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('Preview unavailable');
  }

  function handleProxyRequest(proxyReq: ClientRequest): void {
    proxyReq.setHeader('accept-encoding', 'identity');
    proxyReq.removeHeader('authorization');
    const cookieHeader = stripBrowserSessionCookie(proxyReq.getHeader('cookie')?.toString());
    if (cookieHeader) {
      proxyReq.setHeader('cookie', cookieHeader);
      return;
    }

    proxyReq.removeHeader('cookie');
  }

  function preparePreviewForwarding(
    headers: IncomingMessage['headers'],
    requestUrl: string | undefined,
  ): string {
    const forwardedUrl = new URL(requestUrl ?? '/', 'http://localhost');
    forwardedUrl.searchParams.delete('token');
    stripPreviewAuthHeaders(headers);
    return forwardedUrl.pathname + forwardedUrl.search;
  }

  proxy.on('proxyRes', (proxyRes, req, res) => {
    handleProxyResponse(proxyRes, req, res);
  });
  proxy.on('error', (error, req, res) => {
    handleProxyError(error, req, res);
  });
  proxy.on('proxyReq', (proxyReq) => {
    handleProxyRequest(proxyReq);
  });

  async function handlePreviewRequest(req: express.Request, res: express.Response): Promise<void> {
    const routeTaskId = typeof req.params.taskId === 'string' ? req.params.taskId : '';
    const routePort = parseRoutePort(req.params.port);
    if (!routeTaskId || routePort === null) {
      res.status(404).send('Preview not found');
      return;
    }
    if (!options.isAllowedBrowserOrigin(req) || !options.isAuthorizedRequest(req)) {
      sendUnauthorized(res);
      return;
    }

    if (!options.hasExposedTaskPort(routeTaskId, routePort)) {
      res.status(404).send('Preview not found');
      return;
    }
    const target = await options.resolvePreviewTarget(routeTaskId, routePort);
    if (!target) {
      res.status(502).send('Preview unavailable');
      return;
    }
    req.url = preparePreviewForwarding(req.headers, req.url);

    proxy.web(req, res, {
      target,
    });
  }

  options.app.use('/_preview/:taskId/:port', (req, res) => {
    void handlePreviewRequest(req, res);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const match = parsePreviewRoutePath(req.url);
    if (!match) {
      return;
    }

    if (!options.isAllowedBrowserOrigin(req) || !options.isAuthorizedRequest(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!options.hasExposedTaskPort(match.taskId, match.port)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const target = await options.resolvePreviewTarget(match.taskId, match.port);
    if (!target) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
      return;
    }

    req.url = preparePreviewForwarding(req.headers, match.pathRemainder + match.forwardedSearch);
    proxy.ws(req, socket, head, {
      target,
    });
  }

  const handleUpgradeEvent = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    void handleUpgrade(req, socket, head);
  };

  options.server.on('upgrade', handleUpgradeEvent);

  return () => {
    options.server.off('upgrade', handleUpgradeEvent);
    proxy.close();
  };
}
