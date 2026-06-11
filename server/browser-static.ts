import express from 'express';
import { existsSync } from 'fs';
import path from 'path';

const HTML_CACHE_CONTROL = 'no-store, max-age=0';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const DEFAULT_STATIC_CACHE_CONTROL = 'public, max-age=0';

const COMPRESSIBLE_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const HASHED_ASSET_PATH_PATTERN = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/;

export interface PrecompressedVariant {
  encoding: 'br' | 'gzip';
  path: string;
}

export interface RegisterBrowserStaticRoutesOptions {
  app: express.Express;
  authGatePath: string;
  distDir: string;
  distRemoteDir: string;
  isAuthorizedRequest: (req: express.Request) => boolean;
}

export function selectPrecompressedVariant(
  acceptEncoding: string | undefined,
  filePath: string,
  exists: (candidatePath: string) => boolean,
): PrecompressedVariant | null {
  if (!acceptEncoding) {
    return null;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!(extension in COMPRESSIBLE_CONTENT_TYPES)) {
    return null;
  }

  const encodings = acceptEncoding.toLowerCase();
  if (/(^|[\s,])br($|[\s,;])/.test(encodings) && exists(`${filePath}.br`)) {
    return { encoding: 'br', path: `${filePath}.br` };
  }
  if (/(^|[\s,])gzip($|[\s,;])/.test(encodings) && exists(`${filePath}.gz`)) {
    return { encoding: 'gzip', path: `${filePath}.gz` };
  }

  return null;
}

export function isHashedAssetRequestPath(requestPath: string): boolean {
  return HASHED_ASSET_PATH_PATTERN.test(requestPath);
}

function setHtmlCacheHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', HTML_CACHE_CONTROL);
}

function getRequestSearch(req: express.Request): string {
  const originalUrl = req.originalUrl || req.url || '';
  const queryIndex = originalUrl.indexOf('?');
  return queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
}

function resolveStaticFilePath(rootDir: string, requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const resolved = path.normalize(path.join(rootDir, decodedPath));
  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
    return null;
  }

  return resolved;
}

function createStaticHtmlHandler(rootDir: string): express.RequestHandler {
  const identityHandler = express.static(rootDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        setHtmlCacheHeaders(res);
        return;
      }

      const requestPath = res.req.path;
      if (isHashedAssetRequestPath(requestPath)) {
        res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
      }
      if (path.extname(filePath).toLowerCase() in COMPRESSIBLE_CONTENT_TYPES) {
        res.setHeader('Vary', 'Accept-Encoding');
      }
    },
  });

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      identityHandler(req, res, next);
      return;
    }

    const filePath = resolveStaticFilePath(rootDir, req.path);
    if (!filePath) {
      identityHandler(req, res, next);
      return;
    }

    const acceptEncodingHeader = req.headers['accept-encoding'];
    const variant = selectPrecompressedVariant(
      typeof acceptEncodingHeader === 'string' ? acceptEncodingHeader : undefined,
      filePath,
      existsSync,
    );
    if (!variant) {
      identityHandler(req, res, next);
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.sendFile(
      variant.path,
      {
        cacheControl: false,
        headers: {
          'Cache-Control': isHashedAssetRequestPath(req.path)
            ? IMMUTABLE_CACHE_CONTROL
            : DEFAULT_STATIC_CACHE_CONTROL,
          'Content-Encoding': variant.encoding,
          'Content-Type': COMPRESSIBLE_CONTENT_TYPES[extension] ?? 'application/octet-stream',
          Vary: 'Accept-Encoding',
        },
      },
      (error) => {
        if (error && !res.headersSent) {
          identityHandler(req, res, next);
        }
      },
    );
  };
}

function isAuthExemptRequest(req: express.Request, authGatePath: string): boolean {
  return (
    req.path === authGatePath ||
    req.path.startsWith(`${authGatePath}/`) ||
    req.path.startsWith('/api/')
  );
}

function redirectToAuthGate(
  req: express.Request,
  res: express.Response,
  authGatePath: string,
  fallbackPath: string,
): void {
  const nextPath = encodeURIComponent(req.originalUrl || req.url || fallbackPath);
  res.redirect(`${authGatePath}?next=${nextPath}`);
}

function ensureAuthorizedRequest(
  req: express.Request,
  res: express.Response,
  options: RegisterBrowserStaticRoutesOptions,
  fallbackPath: string,
): boolean {
  if (isAuthExemptRequest(req, options.authGatePath)) {
    return true;
  }

  if (options.isAuthorizedRequest(req)) {
    return true;
  }

  redirectToAuthGate(req, res, options.authGatePath, fallbackPath);
  return false;
}

function createAuthorizedStaticHandler(
  staticHandler: express.RequestHandler,
  options: RegisterBrowserStaticRoutesOptions,
  fallbackPath: string,
): express.RequestHandler {
  return (req, res, next) => {
    if (!ensureAuthorizedRequest(req, res, options, fallbackPath)) {
      return;
    }

    staticHandler(req, res, next);
  };
}

export function registerBrowserStaticRoutes(options: RegisterBrowserStaticRoutesOptions): void {
  const remoteStaticHandler = createStaticHtmlHandler(options.distRemoteDir);
  const appStaticHandler = createStaticHtmlHandler(options.distDir);

  if (existsSync(options.distRemoteDir)) {
    options.app.get(/^\/remote$/, (req, res) => {
      if (!ensureAuthorizedRequest(req, res, options, '/remote')) {
        return;
      }

      res.redirect(`/remote/${getRequestSearch(req)}`);
    });

    options.app.use(
      '/remote',
      createAuthorizedStaticHandler(remoteStaticHandler, options, '/remote'),
    );
    options.app.get('/remote/{*path}', (req, res) => {
      if (!ensureAuthorizedRequest(req, res, options, '/remote')) {
        return;
      }

      const indexPath = path.join(options.distRemoteDir, 'index.html');
      if (!existsSync(indexPath)) {
        res.status(404).send('dist-remote/index.html not found. Run "npm run build:remote" first.');
        return;
      }
      setHtmlCacheHeaders(res);
      res.sendFile(indexPath);
    });
  }

  if (existsSync(options.distDir)) {
    options.app.use(createAuthorizedStaticHandler(appStaticHandler, options, '/'));
  }

  options.app.use((req, res, next) => {
    if (!ensureAuthorizedRequest(req, res, options, '/')) {
      return;
    }

    if (isAuthExemptRequest(req, options.authGatePath)) {
      next();
      return;
    }

    const indexPath = path.join(options.distDir, 'index.html');
    if (!existsSync(indexPath)) {
      res.status(404).send('dist/index.html not found. Build the frontend first.');
      return;
    }
    setHtmlCacheHeaders(res);
    res.sendFile(indexPath);
  });
}
