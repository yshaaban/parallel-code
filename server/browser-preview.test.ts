import express from 'express';
import { createServer } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { registerBrowserPreviewRoutes } from './browser-preview.js';

interface StartedServer {
  close: () => Promise<void>;
  port: number;
}

function listen(server: ReturnType<typeof createServer>): Promise<StartedServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind server'));
        return;
      }

      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }

              closeResolve();
            });
          }),
      });
    });
  });
}

function createTargetServer(): ReturnType<typeof createServer> {
  const app = express();
  app.use((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(
      `<html><head></head><body data-cookie="${req.headers.cookie ?? ''}" data-auth="${req.headers.authorization ?? ''}"><script type="module" src="/@vite/client"></script></body></html>`,
    );
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => {
    socket.on('message', (message) => {
      socket.send(`echo:${String(message)}`);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/hmr') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit('connection', client, req);
    });
  });

  return server;
}

describe('browser preview proxy', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it('proxies HTML responses, rewrites root-relative assets, and sets preview auth cookies', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      isAuthorizedRequest: (request) => request.query.token === 'secret',
      resolveExposedTaskPort: (taskId, port) =>
        taskId === 'task-1' && port === target.port
          ? {
              label: 'Frontend',
              port,
              protocol: 'http',
              source: 'manual',
              updatedAt: Date.now(),
            }
          : undefined,
      safeCompareToken: (token) => token === 'secret',
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const response = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/?token=secret`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('parallel_preview_token=secret');
    const html = await response.text();
    expect(html).toContain(`<base href="/_preview/task-1/${target.port}/">`);
    expect(html).toContain(`src="/_preview/task-1/${target.port}/@vite/client"`);
    expect(html).toContain('data-cookie=""');
    expect(html).toContain('data-auth=""');
  });

  it('proxies websocket upgrades for exposed task ports', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      isAuthorizedRequest: (request) => request.query.token === 'secret',
      resolveExposedTaskPort: (taskId, port) =>
        taskId === 'task-1' && port === target.port
          ? {
              label: null,
              port,
              protocol: 'http',
              source: 'manual',
              updatedAt: Date.now(),
            }
          : undefined,
      safeCompareToken: (token) => token === 'secret',
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const url = `ws://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/hmr?token=secret`;
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once('open', () => {
        socket.send('hello');
      });
      socket.once('message', (data) => {
        resolve(String(data));
        socket.close();
      });
      socket.once('error', reject);
    });

    expect(message).toBe('echo:hello');
  });
});
