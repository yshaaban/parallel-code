import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { gzipSync, brotliCompressSync } from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { runIndependentCleanups } from '../scripts/lib/cleanup-outcome.mjs';
import {
  isHashedAssetRequestPath,
  registerBrowserStaticRoutes,
  selectPrecompressedVariant,
} from './browser-static.js';

async function createTempDist(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(directory, { recursive: true });
  return directory;
}

async function closeTestServer(server: import('http').Server): Promise<void> {
  server.closeAllConnections?.();
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

async function drainResponses(...responses: Response[]): Promise<void> {
  await Promise.all(responses.map((response) => response.arrayBuffer().then(() => undefined)));
}

describe('registerBrowserStaticRoutes', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await runIndependentCleanups(
      'Browser static test temporary directories',
      tempDirs
        .splice(0)
        .map(
          (directory, index) =>
            [
              `remove browser static temporary directory ${index + 1}`,
              () => rm(directory, { force: true, recursive: true }),
            ] as const,
        ),
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
      await drainResponses(desktopResponse, remoteResponse);
    } finally {
      await closeTestServer(server);
    }
  }, 15_000);

  it('preserves remote query parameters when redirecting /remote to /remote/', async () => {
    const distDir = await createTempDist('parallel-code-dist-remote-redirect-');
    tempDirs.push(distDir);
    await writeFile(path.join(distDir, 'index.html'), '<html><body>remote</body></html>');

    const app = express();
    registerBrowserStaticRoutes({
      app,
      authGatePath: '/auth',
      distDir,
      distRemoteDir: distDir,
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

      const response = await fetch(
        `http://127.0.0.1:${address.port}/remote?token=abc123&mode=mobile`,
        { redirect: 'manual' },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/remote/?token=abc123&mode=mobile');
      await drainResponses(response);
    } finally {
      await closeTestServer(server);
    }
  });

  it('redirects unauthenticated desktop shell and asset requests before static files are served', async () => {
    const distDir = await createTempDist('parallel-code-dist-auth-static-');
    tempDirs.push(distDir);
    await writeFile(path.join(distDir, 'index.html'), '<html><body>desktop</body></html>');
    await mkdir(path.join(distDir, 'assets'), { recursive: true });
    await writeFile(path.join(distDir, 'assets', 'app.js'), 'console.log("desktop")');

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

      const shellResponse = await fetch(`http://127.0.0.1:${address.port}/`, {
        redirect: 'manual',
      });
      const assetResponse = await fetch(`http://127.0.0.1:${address.port}/assets/app.js`, {
        redirect: 'manual',
      });

      expect(shellResponse.status).toBe(302);
      expect(shellResponse.headers.get('location')).toBe('/auth?next=%2F');
      expect(assetResponse.status).toBe(302);
      expect(assetResponse.headers.get('location')).toBe('/auth?next=%2Fassets%2Fapp.js');
      await drainResponses(shellResponse, assetResponse);
    } finally {
      await closeTestServer(server);
    }
  });

  it('keeps scoped remote static authority separate from the full browser auth gate', async () => {
    const distDir = await createTempDist('parallel-code-dist-separated-auth-');
    tempDirs.push(distDir);
    await writeFile(path.join(distDir, 'index.html'), '<html><body>shell</body></html>');

    const app = express();
    registerBrowserStaticRoutes({
      app,
      authGatePath: '/auth',
      distDir,
      distRemoteDir: distDir,
      isAuthorizedRemoteRequest: () => false,
      isAuthorizedRequest: () => true,
      remoteAuthGatePath: null,
    });

    const server = await new Promise<import('http').Server>((resolve) => {
      const nextServer = app.listen(0, () => resolve(nextServer));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve test server port');
      }
      const desktop = await fetch(`http://127.0.0.1:${address.port}/`);
      const remote = await fetch(`http://127.0.0.1:${address.port}/remote/`, {
        redirect: 'manual',
      });

      expect(desktop.status).toBe(200);
      expect(remote.status).toBe(401);
      expect(remote.headers.get('location')).toBeNull();
      await drainResponses(desktop, remote);
    } finally {
      await closeTestServer(server);
    }
  });

  it('selects precompressed variants by encoding preference with identity fallback', () => {
    const siblings = new Set([
      '/dist/assets/app-abcdef12.js.br',
      '/dist/assets/app-abcdef12.js.gz',
    ]);
    const exists = (candidate: string): boolean => siblings.has(candidate);

    expect(selectPrecompressedVariant('br, gzip', '/dist/assets/app-abcdef12.js', exists)).toEqual({
      encoding: 'br',
      path: '/dist/assets/app-abcdef12.js.br',
    });
    expect(selectPrecompressedVariant('gzip', '/dist/assets/app-abcdef12.js', exists)).toEqual({
      encoding: 'gzip',
      path: '/dist/assets/app-abcdef12.js.gz',
    });
    expect(
      selectPrecompressedVariant('gzip', '/dist/assets/other-12345678.js', () => false),
    ).toBeNull();
    expect(
      selectPrecompressedVariant(undefined, '/dist/assets/app-abcdef12.js', exists),
    ).toBeNull();
    expect(selectPrecompressedVariant('br', '/dist/assets/photo.png', () => true)).toBeNull();
    expect(
      selectPrecompressedVariant('identity', '/dist/assets/app-abcdef12.js', exists),
    ).toBeNull();
  });

  it('classifies hashed asset request paths for immutable caching', () => {
    expect(isHashedAssetRequestPath('/assets/index-DGVUb4mE.js')).toBe(true);
    expect(isHashedAssetRequestPath('/assets/index-DjJEihq7.css')).toBe(true);
    expect(isHashedAssetRequestPath('/index.html')).toBe(false);
    expect(isHashedAssetRequestPath('/assets/manifest.json')).toBe(false);
  });

  it('serves precompressed assets with Content-Encoding, immutable caching, and no-store HTML', async () => {
    const distDir = await createTempDist('parallel-code-dist-compressed-');
    tempDirs.push(distDir);

    const jsBody = `console.log("desktop bundle");`.repeat(64);
    await writeFile(path.join(distDir, 'index.html'), '<html><body>desktop</body></html>');
    await mkdir(path.join(distDir, 'assets'), { recursive: true });
    const assetPath = path.join(distDir, 'assets', 'index-DGVUb4mE.js');
    await writeFile(assetPath, jsBody);
    await writeFile(`${assetPath}.gz`, gzipSync(Buffer.from(jsBody)));
    await writeFile(`${assetPath}.br`, brotliCompressSync(Buffer.from(jsBody)));

    const app = express();
    registerBrowserStaticRoutes({
      app,
      authGatePath: '/auth',
      distDir,
      distRemoteDir: distDir,
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
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const brotliResponse = await fetch(`${baseUrl}/assets/index-DGVUb4mE.js`, {
        headers: { 'accept-encoding': 'br, gzip' },
      });
      expect(brotliResponse.headers.get('content-encoding')).toBe('br');
      expect(brotliResponse.headers.get('vary')).toBe('Accept-Encoding');
      expect(brotliResponse.headers.get('content-type')).toContain('javascript');
      expect(brotliResponse.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(await brotliResponse.text()).toBe(jsBody);

      const gzipResponse = await fetch(`${baseUrl}/assets/index-DGVUb4mE.js`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(gzipResponse.headers.get('content-encoding')).toBe('gzip');
      expect(await gzipResponse.text()).toBe(jsBody);

      const identityResponse = await fetch(`${baseUrl}/assets/index-DGVUb4mE.js`, {
        headers: { 'accept-encoding': 'identity' },
      });
      expect(identityResponse.headers.get('content-encoding')).toBeNull();
      expect(identityResponse.headers.get('vary')).toBe('Accept-Encoding');
      expect(identityResponse.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(await identityResponse.text()).toBe(jsBody);

      const htmlResponse = await fetch(`${baseUrl}/`, {
        headers: { 'accept-encoding': 'br, gzip' },
      });
      expect(htmlResponse.headers.get('cache-control')).toBe('no-store, max-age=0');
      expect(htmlResponse.headers.get('content-encoding')).toBeNull();
      await drainResponses(htmlResponse);
    } finally {
      await closeTestServer(server);
    }
  }, 15_000);

  it('keeps the auth gate ahead of precompressed asset serving', async () => {
    const distDir = await createTempDist('parallel-code-dist-compressed-auth-');
    tempDirs.push(distDir);
    await writeFile(path.join(distDir, 'index.html'), '<html><body>desktop</body></html>');
    await mkdir(path.join(distDir, 'assets'), { recursive: true });
    const assetPath = path.join(distDir, 'assets', 'index-DGVUb4mE.js');
    await writeFile(assetPath, 'console.log("bundle")');
    await writeFile(`${assetPath}.gz`, gzipSync(Buffer.from('console.log("bundle")')));

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

      const response = await fetch(`http://127.0.0.1:${address.port}/assets/index-DGVUb4mE.js`, {
        headers: { 'accept-encoding': 'gzip' },
        redirect: 'manual',
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/auth?next=%2Fassets%2Findex-DGVUb4mE.js');
      await drainResponses(response);
    } finally {
      await closeTestServer(server);
    }
  });

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
      await drainResponses(response);
    } finally {
      await closeTestServer(server);
    }
  });
});
