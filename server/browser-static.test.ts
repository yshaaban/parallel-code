import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { registerBrowserStaticRoutes } from './browser-static.js';

async function createTempDist(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(directory, { recursive: true });
  return directory;
}

describe('registerBrowserStaticRoutes', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it('serves no-store headers for browser and remote HTML shells', async () => {
    const distDir = await createTempDist('parallel-code-dist-');
    const distRemoteDir = await createTempDist('parallel-code-remote-');
    tempDirs.push(distDir, distRemoteDir);

    await writeFile(path.join(distDir, 'index.html'), '<html><body>desktop</body></html>');
    await writeFile(path.join(distRemoteDir, 'index.html'), '<html><body>remote</body></html>');

    const app = express();
    registerBrowserStaticRoutes({
      app,
      authGatePath: '/auth',
      distDir,
      distRemoteDir,
      isAuthorizedRequest: () => true,
    });

    const server = await new Promise<import('http').Server>((resolve) => {
      const nextServer = app.listen(0, () => resolve(nextServer));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve test server port');
      }

      const desktopResponse = await fetch(`http://127.0.0.1:${address.port}/`);
      const remoteResponse = await fetch(`http://127.0.0.1:${address.port}/remote/agent-1`);

      expect(desktopResponse.headers.get('cache-control')).toBe('no-store, max-age=0');
      expect(remoteResponse.headers.get('cache-control')).toBe('no-store, max-age=0');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }, 15_000);

  it('redirects unauthenticated shell requests to the auth gate', async () => {
    const distDir = await createTempDist('parallel-code-dist-auth-');
    tempDirs.push(distDir);
    await writeFile(path.join(distDir, 'index.html'), '<html><body>desktop</body></html>');

    const app = express();
    registerBrowserStaticRoutes({
      app,
      authGatePath: '/auth',
      distDir,
      distRemoteDir: distDir,
      isAuthorizedRequest: () => false,
    });

    const server = await new Promise<import('http').Server>((resolve) => {
      const nextServer = app.listen(0, () => resolve(nextServer));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve test server port');
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/tasks/123`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/auth?next=%2Ftasks%2F123');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
