import express from 'express';
import { existsSync } from 'fs';
import path from 'path';

export interface RegisterBrowserStaticRoutesOptions {
  app: express.Express;
  distDir: string;
  distRemoteDir: string;
}

export function registerBrowserStaticRoutes(options: RegisterBrowserStaticRoutesOptions): void {
  if (existsSync(options.distRemoteDir)) {
    options.app.use('/remote', express.static(options.distRemoteDir));
    options.app.get('/remote/{*path}', (_req, res) => {
      const indexPath = path.join(options.distRemoteDir, 'index.html');
      if (!existsSync(indexPath)) {
        res.status(404).send('dist-remote/index.html not found. Run "npm run build:remote" first.');
        return;
      }
      res.sendFile(indexPath);
    });
  }

  if (existsSync(options.distDir)) {
    options.app.use(express.static(options.distDir));
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
    res.sendFile(indexPath);
  });
}
