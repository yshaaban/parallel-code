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

function createStaticHtmlHandler(rootDir: string): express.RequestHandler {
  return express.static(rootDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        setHtmlCacheHeaders(res);
      }
    },
  });
}

export function registerBrowserStaticRoutes(options: RegisterBrowserStaticRoutesOptions): void {
  const remoteStaticHandler = createStaticHtmlHandler(options.distRemoteDir);
  const appStaticHandler = createStaticHtmlHandler(options.distDir);

  if (existsSync(options.distRemoteDir)) {
    options.app.use('/remote', (req, res, next) => {
      if (!options.isAuthorizedRequest(req)) {
        const nextPath = encodeURIComponent(req.originalUrl || req.url || '/remote');
        res.redirect(`${options.authGatePath}?next=${nextPath}`);
        return;
      }

      remoteStaticHandler(req, res, next);
    });
    options.app.get('/remote/{*path}', (req, res) => {
      if (!options.isAuthorizedRequest(req)) {
        const nextPath = encodeURIComponent(req.originalUrl || req.url || '/remote');
        res.redirect(`${options.authGatePath}?next=${nextPath}`);
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
    options.app.use(appStaticHandler);
  }

  options.app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    if (req.path === options.authGatePath) {
      next();
      return;
    }
    if (!options.isAuthorizedRequest(req)) {
      const nextPath = encodeURIComponent(req.originalUrl || req.url || '/');
      res.redirect(`${options.authGatePath}?next=${nextPath}`);
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
