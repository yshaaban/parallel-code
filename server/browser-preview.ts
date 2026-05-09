import type { ClientRequest, IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import type express from 'express';
import httpProxy from 'http-proxy';
import { Socket } from 'net';
import { assertNever } from '../src/lib/assert-never.js';
import { isTcpPortNumber } from '../src/lib/type-guards.js';

type PreviewRouteKind = 'task-container' | 'task-port';

const PREVIEW_ROUTE_PREFIXES = {
  'task-container': '/_container_preview',
  'task-port': '/_preview',
} satisfies Record<PreviewRouteKind, string>;
const PREVIEW_ROUTE_PREFIX = PREVIEW_ROUTE_PREFIXES['task-port'];
const TASK_CONTAINER_PREVIEW_ROUTE_PREFIX = PREVIEW_ROUTE_PREFIXES['task-container'];
const SESSION_COOKIE_NAME = 'parallel_code_session';
const STRIPPABLE_PREVIEW_PATH_SEGMENTS = new Set([
  'assets',
  'static',
  'public',
  'js',
  'css',
  'img',
  'images',
  'fonts',
  'media',
]);

/**
 * Cache of detected base paths per taskId:port.
 * When an app is built with a base path prefix (e.g. Vite base: '/editor/')
 * but served from root, the HTML references assets at /editor/assets/...
 * while the server only has /assets/... at root. We detect the base path
 * from the HTML <base> tag and strip it when forwarding asset requests.
 */
const detectedBasePaths = new Map<string, string>();
const BASE_PATH_TTL_MS = 5 * 60 * 1000;
const detectedBasePathTimestamps = new Map<string, number>();

function getPreviewCacheKey(kind: PreviewRouteKind, taskId: string, port: number): string {
  return `${kind}:${taskId}:${port}`;
}

function getDetectedBasePath(kind: PreviewRouteKind, taskId: string, port: number): string | null {
  const key = getPreviewCacheKey(kind, taskId, port);
  const timestamp = detectedBasePathTimestamps.get(key);
  if (timestamp && Date.now() - timestamp > BASE_PATH_TTL_MS) {
    detectedBasePaths.delete(key);
    detectedBasePathTimestamps.delete(key);
    return null;
  }
  return detectedBasePaths.get(key) ?? null;
}

function setDetectedBasePath(
  kind: PreviewRouteKind,
  taskId: string,
  port: number,
  basePath: string,
): void {
  const key = getPreviewCacheKey(kind, taskId, port);
  detectedBasePaths.set(key, basePath);
  detectedBasePathTimestamps.set(key, Date.now());
}

function clearDetectedBasePath(kind: PreviewRouteKind, taskId: string, port: number): void {
  const key = getPreviewCacheKey(kind, taskId, port);
  detectedBasePaths.delete(key);
  detectedBasePathTimestamps.delete(key);
}

function extractBaseHrefFromHtml(html: string): string | null {
  const match = /<base\s[^>]*href=["']([^"']+)["']/iu.exec(html);
  if (!match) {
    return null;
  }
  const href = match[1];
  // Only care about path-only base hrefs (not full URLs)
  if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
    return null;
  }
  // Must be a non-trivial path prefix (not just '/')
  if (href === '/' || href === './') {
    return null;
  }
  // Normalize to have leading and trailing slash
  let normalized = href.startsWith('/') ? href : '/' + href;
  if (!normalized.endsWith('/')) {
    normalized += '/';
  }
  return normalized;
}

function inferBasePathFromAssetRefs(html: string): string | null {
  // When there is no <base> tag, look for a common path prefix in
  // root-relative src="" and href="" attributes pointing to assets.
  // e.g. src="/editor/assets/index.js", href="/apps/editor/assets/app.css"
  const refPattern = /(?:src|href)=["']\/([^"']+?)\/(?:assets|static|public|js|css)\//giu;
  const prefixes = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(html)) !== null) {
    const originalPrefix = match[1];
    if (!originalPrefix) {
      continue;
    }

    const normalizedPrefix = originalPrefix.toLowerCase();
    if (!prefixes.has(normalizedPrefix)) {
      prefixes.set(normalizedPrefix, originalPrefix);
    }
  }
  // Only use if all references share the same prefix
  if (prefixes.size !== 1) {
    return null;
  }

  const [originalPrefix] = prefixes.values();
  return originalPrefix ? `/${originalPrefix}/` : null;
}

interface PreviewRouteMatch {
  forwardedSearch: string;
  kind: PreviewRouteKind;
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
  hasTaskContainerPreviewTarget?: (taskId: string, port: number) => boolean;
  markPreviewUnavailable: (taskId: string, port: number) => void;
  resolveTaskContainerPreviewTarget?: (taskId: string, port: number) => Promise<string | null>;
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

function parseRequestUrlSafely(url: string | undefined): URL | null {
  const value = url ?? '/';
  return URL.canParse(value, 'http://localhost') ? new URL(value, 'http://localhost') : null;
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
  const parsedUrl = parseRequestUrlSafely(url);
  if (!parsedUrl) {
    return null;
  }

  parsedUrl.searchParams.delete('token');
  const pathname = parsedUrl.pathname;
  const taskPortMatch = /^\/_preview\/([^/]+)\/(\d+)(\/.*)?$/u.exec(pathname);
  const taskContainerMatch = /^\/_container_preview\/([^/]+)\/(\d+)(\/.*)?$/u.exec(pathname);
  const match = taskPortMatch ?? taskContainerMatch;
  if (!match) {
    return null;
  }

  const taskId = decodeUriComponentSafely(match[1] ?? '');
  const port = Number.parseInt(match[2] ?? '', 10);
  if (!taskId || !isTcpPortNumber(port)) {
    return null;
  }

  return {
    kind: taskPortMatch ? 'task-port' : 'task-container',
    taskId,
    port,
    pathRemainder: match[3] ?? '/',
    forwardedSearch: parsedUrl.searchParams.size > 0 ? `?${parsedUrl.searchParams.toString()}` : '',
  };
}

function isPreviewRoutePath(url: string | undefined): boolean {
  const parsedUrl = parseRequestUrlSafely(url);
  if (!parsedUrl) {
    return false;
  }

  const pathname = parsedUrl.pathname;
  return Object.values(PREVIEW_ROUTE_PREFIXES).some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function getPreviewRoutePrefix(kind: PreviewRouteKind): string {
  return PREVIEW_ROUTE_PREFIXES[kind];
}

function getPreviewBasePath(match: PreviewRouteMatch): string {
  return `${getPreviewRoutePrefix(match.kind)}/${encodeURIComponent(match.taskId)}/${match.port}`;
}

function getPreviewDocumentBasePath(previewBasePath: string, pathRemainder: string): string {
  const documentBasePath = new URL('.', `http://localhost${pathRemainder}`).pathname;
  return `${previewBasePath}${documentBasePath}`;
}

function rewriteRootRelativeReferences(html: string, previewBasePath: string): string {
  return html
    .replace(/((?:src|href|action)=["'])\/(?!\/)/giu, `$1${previewBasePath}/`)
    .replace(/(url\(["']?)\/(?!\/)/giu, `$1${previewBasePath}/`);
}

function injectOrReplaceBaseTag(html: string, previewDocumentBasePath: string): string {
  if (/<base\b/iu.test(html)) {
    // Replace existing base tag with the preview-prefixed version
    return html.replace(
      /<base\s[^>]*href=["'][^"']*["'][^>]*>/iu,
      `<base href="${previewDocumentBasePath}">`,
    );
  }

  return html.replace(/(<head[^>]*>)/iu, `$1<base href="${previewDocumentBasePath}">`);
}

function rewriteHtmlForPreview(
  html: string,
  previewBasePath: string,
  previewDocumentBasePath: string,
): string {
  const rewrittenHtml = rewriteRootRelativeReferences(html, previewBasePath);
  return injectOrReplaceBaseTag(rewrittenHtml, previewDocumentBasePath);
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
  return headerList.map((header) => rewriteSetCookieHeader(header, previewBasePath));
}

function rewriteSetCookieHeader(header: string, previewBasePath: string): string {
  const [cookiePair = '', ...attributes] = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const rewrittenAttributes: string[] = [];
  let hasPath = false;

  for (const attribute of attributes) {
    const attributeName = attribute.split('=', 1)[0]?.toLowerCase();
    if (attributeName === 'domain') {
      continue;
    }

    if (attributeName === 'path') {
      if (!hasPath) {
        rewrittenAttributes.push(`Path=${previewBasePath}`);
        hasPath = true;
      }
      continue;
    }

    rewrittenAttributes.push(attribute);
  }

  if (!hasPath) {
    rewrittenAttributes.push(`Path=${previewBasePath}`);
  }

  return [cookiePair, ...rewrittenAttributes].join('; ');
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

type PreviewTargetResolution =
  | { kind: 'target'; target: string }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

type PreviewTargetFailureResolution = Exclude<PreviewTargetResolution, { kind: 'target' }>;

interface PreviewTargetFailureResponse {
  body: string;
  status: number;
  statusLine: string;
}

const PREVIEW_TARGET_FAILURE_RESPONSES = {
  'not-found': {
    body: 'Preview not found',
    status: 404,
    statusLine: 'HTTP/1.1 404 Not Found',
  },
  unauthorized: {
    body: 'Unauthorized',
    status: 401,
    statusLine: 'HTTP/1.1 401 Unauthorized',
  },
  unavailable: {
    body: 'Preview unavailable',
    status: 502,
    statusLine: 'HTTP/1.1 502 Bad Gateway',
  },
} satisfies Record<PreviewTargetFailureResolution['kind'], PreviewTargetFailureResponse>;

function respondToPreviewTargetResolution(
  resolution: PreviewTargetResolution,
  handlers: {
    onFailure: (failure: PreviewTargetFailureResponse) => void;
    onTarget: (target: string) => void;
  },
): void {
  switch (resolution.kind) {
    case 'target':
      handlers.onTarget(resolution.target);
      return;
    case 'unauthorized':
    case 'not-found':
    case 'unavailable':
      handlers.onFailure(PREVIEW_TARGET_FAILURE_RESPONSES[resolution.kind]);
      return;
    default:
      assertNever(resolution, 'Unhandled preview target resolution');
  }
}

interface ProxyRequestState {
  match: PreviewRouteMatch;
  retriedWithStrippedBasePath: boolean;
  target: string;
}

export function registerBrowserPreviewRoutes(
  options: RegisterBrowserPreviewRoutesOptions,
): () => void {
  const proxyRequestStates = new WeakMap<IncomingMessage, ProxyRequestState>();
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
    const requestState = proxyRequestStates.get(req);
    const match = requestState?.match ?? parsePreviewRoutePath(request.originalUrl);
    if (!match) {
      response.status(proxyRes.statusCode ?? 502).end();
      return;
    }

    const previewBasePath = getPreviewBasePath(match);
    const previewDocumentBasePath = getPreviewDocumentBasePath(
      previewBasePath,
      match.pathRemainder,
    );
    const contentType = String(proxyRes.headers['content-type'] ?? '');
    const statusCode = proxyRes.statusCode ?? 200;

    if (
      requestState &&
      shouldRetryWithStrippedDetectedBasePath(req, requestState) &&
      statusCode === 404
    ) {
      proxyRes.resume();
      requestState.retriedWithStrippedBasePath = true;
      req.url = stripDetectedBasePath(
        requestState.match.pathRemainder,
        getDetectedBasePath(
          requestState.match.kind,
          requestState.match.taskId,
          requestState.match.port,
        ) ?? '',
      );
      if (requestState.match.forwardedSearch) {
        req.url += requestState.match.forwardedSearch;
      }
      proxy.web(req, response, {
        target: requestState.target,
      });
      return;
    }

    copyProxyHeaders(response, proxyRes.headers, previewBasePath, match.port);

    if (!contentType.includes('text/html')) {
      response.status(statusCode);
      proxyRes.pipe(response);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);

      const rawHtml = body.toString('utf8');

      const appBasePath = extractBaseHrefFromHtml(rawHtml) ?? inferBasePathFromAssetRefs(rawHtml);
      if (appBasePath) {
        setDetectedBasePath(match.kind, match.taskId, match.port, appBasePath);
      } else {
        clearDetectedBasePath(match.kind, match.taskId, match.port);
      }

      const rewrittenHtml = rewriteHtmlForPreview(
        rawHtml,
        previewBasePath,
        previewDocumentBasePath,
      );
      response.status(statusCode).send(rewrittenHtml);
    });
  }

  function handleProxyError(
    _error: Error,
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage> | Socket,
  ): void {
    const requestState = proxyRequestStates.get(req);
    const match = requestState?.match ?? parsePreviewRoutePath(req.url);
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
    match: PreviewRouteMatch,
  ): string {
    stripPreviewAuthHeaders(headers);
    return match.pathRemainder + match.forwardedSearch;
  }

  function shouldRetryWithStrippedDetectedBasePath(
    request: IncomingMessage,
    requestState: ProxyRequestState,
  ): boolean {
    if (requestState.retriedWithStrippedBasePath) {
      return false;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return false;
    }

    const detectedBase = getDetectedBasePath(
      requestState.match.kind,
      requestState.match.taskId,
      requestState.match.port,
    );
    if (!detectedBase || !requestState.match.pathRemainder.startsWith(detectedBase)) {
      return false;
    }

    const relativePath = requestState.match.pathRemainder.slice(detectedBase.length);
    const normalizedRelativePath = relativePath.startsWith('/')
      ? relativePath.slice(1)
      : relativePath;
    const relativePathSegments = normalizedRelativePath.split('/');
    const firstSegment = relativePathSegments[0] ?? '';
    const lastSegment = relativePathSegments[relativePathSegments.length - 1] ?? '';
    const acceptHeader = request.headers.accept;
    const acceptValue = Array.isArray(acceptHeader) ? acceptHeader[0] : acceptHeader;
    const acceptsHtml = typeof acceptValue === 'string' && acceptValue.includes('text/html');

    return (
      acceptsHtml || STRIPPABLE_PREVIEW_PATH_SEGMENTS.has(firstSegment) || lastSegment.includes('.')
    );
  }

  function stripDetectedBasePath(path: string, detectedBase: string): string {
    if (!detectedBase || !path.startsWith(detectedBase)) {
      return path;
    }

    return `/${path.slice(detectedBase.length)}`;
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

  async function resolvePreviewTargetForRequest(
    request: {
      headers: IncomingMessage['headers'];
      url?: string | undefined;
    },
    match: PreviewRouteMatch,
  ): Promise<PreviewTargetResolution> {
    if (!options.isAllowedBrowserOrigin(request) || !options.isAuthorizedRequest(request)) {
      return { kind: 'unauthorized' };
    }

    try {
      switch (match.kind) {
        case 'task-port': {
          if (!options.hasExposedTaskPort(match.taskId, match.port)) {
            return { kind: 'not-found' };
          }

          const target = await options.resolvePreviewTarget(match.taskId, match.port);
          return target ? { kind: 'target', target } : { kind: 'unavailable' };
        }
        case 'task-container': {
          if (!(options.hasTaskContainerPreviewTarget?.(match.taskId, match.port) ?? false)) {
            return { kind: 'not-found' };
          }

          const target =
            (await options.resolveTaskContainerPreviewTarget?.(match.taskId, match.port)) ?? null;
          return target ? { kind: 'target', target } : { kind: 'unavailable' };
        }
        default:
          return assertNever(match.kind, 'Unhandled preview route kind');
      }
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function handlePreviewRequest(req: express.Request, res: express.Response): Promise<void> {
    const routeMatch = parsePreviewRoutePath(req.originalUrl);
    if (!routeMatch) {
      res.status(404).send('Preview not found');
      return;
    }

    const targetResolution = await resolvePreviewTargetForRequest(req, routeMatch);
    respondToPreviewTargetResolution(targetResolution, {
      onTarget(target) {
        proxyRequestStates.set(req, {
          match: routeMatch,
          retriedWithStrippedBasePath: false,
          target,
        });
        req.url = preparePreviewForwarding(req.headers, routeMatch);

        proxy.web(req, res, {
          target,
        });
      },
      onFailure(failure) {
        res.status(failure.status).send(failure.body);
      },
    });
  }

  options.app.use(`${PREVIEW_ROUTE_PREFIX}/:taskId/:port`, (req, res) => {
    void handlePreviewRequest(req, res);
  });

  options.app.use(`${TASK_CONTAINER_PREVIEW_ROUTE_PREFIX}/:taskId/:port`, (req, res) => {
    void handlePreviewRequest(req, res);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const match = parsePreviewRoutePath(req.url);
    if (!match) {
      if (isPreviewRoutePath(req.url)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    const targetResolution = await resolvePreviewTargetForRequest(req, match);
    respondToPreviewTargetResolution(targetResolution, {
      onTarget(target) {
        proxyRequestStates.set(req, {
          match,
          retriedWithStrippedBasePath: false,
          target,
        });
        req.url = preparePreviewForwarding(req.headers, match);
        proxy.ws(req, socket, head, {
          target,
        });
      },
      onFailure(failure) {
        socket.write(`${failure.statusLine}\r\n\r\n`);
        socket.destroy();
      },
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
