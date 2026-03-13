import express from 'express';
import { existsSync } from 'fs';
import path from 'path';

const HTML_CACHE_CONTROL = 'no-store, max-age=0';

export interface RegisterBrowserStaticRoutesOptions {
  app: express.Express;
  distDir: string;
  distRemoteDir: string;
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
  if (existsSync(options.distRemoteDir)) {
    options.app.use('/remote', createStaticHtmlHandler(options.distRemoteDir));
    options.app.get('/remote/{*path}', (_req, res) => {
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
    options.app.use(createStaticHtmlHandler(options.distDir));
  }

  options.app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
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
