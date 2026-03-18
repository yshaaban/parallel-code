import express from 'express';
import { existsSync } from 'fs';
import path from 'path';

const HTML_CACHE_CONTROL = 'no-store, max-age=0';

export interface RegisterBrowserStaticRoutesOptions {
  app: express.Express;
  authGatePath: string;
  distDir: string;
  distRemoteDir: string;
  isAuthorizedRequest: (req: express.Request) => boolean;
}

function setHtmlCacheHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', HTML_CACHE_CONTROL);
}

function getRequestSearch(req: express.Request): string {
  const originalUrl = req.originalUrl || req.url || '';
  const queryIndex = originalUrl.indexOf('?');
  return queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
}

function createStaticHtmlHandler(rootDir: string): express.RequestHandler {
  return express.static(rootDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        setHtmlCacheHeaders(res);
      }
    },
  });
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
