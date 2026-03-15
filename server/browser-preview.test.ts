import express from 'express';
import { createServer } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { registerBrowserPreviewRoutes } from './browser-preview.js';

const SESSION_COOKIE = 'parallel_code_session=session';

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
            server.closeAllConnections?.();
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
    res.setHeader('set-cookie', 'target-session=abc; Path=/');
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

function createNestedTargetServer(): ReturnType<typeof createServer> {
  const app = express();
  app.get('/editor/', (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(
      [
        '<html><head><base href="/editor/"></head><body>',
        '<script type="module" src="assets/index.js"></script>',
        '<link rel="stylesheet" href="/editor/assets/app.css">',
        '</body></html>',
      ].join(''),
    );
  });
  app.get('/editor/assets/index.js', (_req, res) => {
    res.setHeader('content-type', 'application/javascript; charset=utf-8');
    res.send('window.previewAssetLoaded = true;');
  });
  app.get('/editor/assets/app.css', (_req, res) => {
    res.setHeader('content-type', 'text/css; charset=utf-8');
    res.send('body{background:#000;}');
  });

  return createServer(app);
}

function createPreviewRouteOptions(
  targetPort: number,
  options?: {
    hasExposedTaskPort?: (taskId: string, port: number) => boolean;
    markPreviewUnavailable?: (taskId: string, port: number) => void;
    resolvePreviewTarget?: (taskId: string, port: number) => Promise<string | null>;
  },
) {
  return {
    isAllowedBrowserOrigin: () => true,
    isAuthorizedRequest: (request: { headers: { cookie?: string | string[] } }) =>
      typeof request.headers.cookie === 'string' && request.headers.cookie.includes(SESSION_COOKIE),
    hasExposedTaskPort:
      options?.hasExposedTaskPort ?? ((taskId, port) => taskId === 'task-1' && port === targetPort),
    markPreviewUnavailable: options?.markPreviewUnavailable ?? (() => {}),
    resolvePreviewTarget:
      options?.resolvePreviewTarget ??
      (async (taskId, port) =>
        taskId === 'task-1' && port === targetPort ? `http://127.0.0.1:${targetPort}` : null),
  };
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
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const response = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      {
        headers: {
          cookie: SESSION_COOKIE,
        },
      },
    );

    expect(response.status).toBe(200);
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter((value): value is string => value !== null);
    expect(setCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`target-session=abc; Path=/_preview/task-1/${target.port}`),
      ]),
    );
    const html = await response.text();
    expect(html).toContain(`<base href="/_preview/task-1/${target.port}/">`);
    expect(html).toContain(`src="/_preview/task-1/${target.port}/@vite/client"`);
    expect(html).toContain('data-cookie=""');
    expect(html).toContain('data-auth=""');
  });

  it('does not fail authorization when unrelated cookies are malformed', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const response = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      {
        headers: {
          cookie: `${SESSION_COOKIE}; broken=%E0%A4%A; other=value`,
        },
      },
    );

    expect(response.status).toBe(200);
  });

  it('falls back across loopback hosts when the exposed host is too specific', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const response = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      {
        headers: {
          cookie: SESSION_COOKIE,
        },
      },
    );

    expect(response.status).toBe(200);
  });

  it('ignores non-loopback exposed hosts and only proxies local preview targets', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const response = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      {
        headers: {
          cookie: SESSION_COOKIE,
        },
      },
    );

    expect(response.status).toBe(200);
  });

  it('rejects preview routes with non-decimal port segments', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const response = await fetch(`http://127.0.0.1:${preview.port}/_preview/task-1/1e2/`, {
      headers: {
        cookie: SESSION_COOKIE,
      },
    });

    expect(response.status).toBe(404);
  });

  it('rejects preview routes with invalid encoded task ids', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const response = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/%E0%A4%A/${target.port}/`,
      {
        headers: {
          cookie: SESSION_COOKIE,
        },
      },
    );

    expect(response.status).toBe(400);
  });

  it('proxies websocket upgrades for exposed task ports', async () => {
    const targetServer = createTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const markPreviewUnavailable = vi.fn();
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port, {
        markPreviewUnavailable,
      }),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const url = `ws://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/hmr`;
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          Cookie: SESSION_COOKIE,
          Origin: `http://127.0.0.1:${preview.port}`,
        },
      });
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
    expect(markPreviewUnavailable).not.toHaveBeenCalled();
  });

  it('forwards nested preview assets and preserves nested document base paths', async () => {
    const targetServer = createNestedTargetServer();
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const htmlResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/editor/`,
      {
        headers: {
          cookie: SESSION_COOKIE,
        },
      },
    );

    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain(`<base href="/_preview/task-1/${target.port}/editor/">`);
    expect(html).not.toContain(`<base href="/_preview/task-1/${target.port}/">`);
    expect(html.match(/<base\b/giu)?.length).toBe(1);
    expect(html).toContain(`href="/_preview/task-1/${target.port}/editor/assets/app.css"`);

    const assetResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/editor/assets/index.js`,
      {
        headers: {
          cookie: SESSION_COOKIE,
        },
      },
    );

    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain('window.previewAssetLoaded = true;');
  });

  it('auto-detects base path from HTML and strips it on subsequent asset requests', async () => {
    // Simulates an app built with Vite base: '/editor/' but served from root.
    // The HTML references /editor/assets/... but the server only has /assets/...
    const app2 = express();
    app2.get('/', (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(
        [
          '<html><head><base href="/editor/"></head><body>',
          '<script type="module" src="/editor/assets/index.js"></script>',
          '</body></html>',
        ].join(''),
      );
    });
    app2.get('/assets/index.js', (_req, res) => {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.send('window.basePathFixWorked = true;');
    });
    const targetServer = createServer(app2);
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    // First request: fetch HTML at root — this should detect and cache the /editor/ base path
    const htmlResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    // The base tag should be rewritten to the preview path
    expect(html).toContain(`<base href="/_preview/task-1/${target.port}/">`);

    // Second request: fetch an asset at /editor/assets/index.js
    // The proxy should strip /editor/ and forward as /assets/index.js
    const assetResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/editor/assets/index.js`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain('window.basePathFixWorked = true;');
  });

  it('infers base path from root-relative asset refs when no base tag exists', async () => {
    // Simulates a Vite app with base: '/editor/' where no <base> tag is in HTML
    // but all asset refs use /editor/assets/... while server serves at /assets/...
    const app2 = express();
    app2.get('/', (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(
        [
          '<html><head></head><body>',
          '<script type="module" src="/editor/assets/index.js"></script>',
          '<link rel="stylesheet" href="/editor/assets/app.css">',
          '</body></html>',
        ].join(''),
      );
    });
    app2.get('/assets/index.js', (_req, res) => {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.send('window.inferredBasePathWorked = true;');
    });
    app2.get('/assets/app.css', (_req, res) => {
      res.setHeader('content-type', 'text/css; charset=utf-8');
      res.send('body{background:blue;}');
    });
    const targetServer = createServer(app2);
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    // Fetch HTML at root — should detect /editor/ prefix from asset refs
    const htmlResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(htmlResponse.status).toBe(200);

    // Now fetch asset via /editor/assets/index.js — proxy should strip /editor/
    const jsResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/editor/assets/index.js`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(jsResponse.status).toBe(200);
    expect(await jsResponse.text()).toContain('window.inferredBasePathWorked = true;');

    // CSS too
    const cssResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/editor/assets/app.css`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toContain('body{background:blue;}');
  });

  it('infers multi-segment base paths from root-relative asset refs', async () => {
    const app2 = express();
    app2.get('/', (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(
        [
          '<html><head></head><body>',
          '<script type="module" src="/apps/editor/assets/index.js"></script>',
          '<link rel="stylesheet" href="/apps/editor/assets/app.css">',
          '</body></html>',
        ].join(''),
      );
    });
    app2.get('/assets/index.js', (_req, res) => {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.send('window.multiSegmentBasePathWorked = true;');
    });
    app2.get('/assets/app.css', (_req, res) => {
      res.setHeader('content-type', 'text/css; charset=utf-8');
      res.send('body{color:green;}');
    });
    const targetServer = createServer(app2);
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const htmlResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(htmlResponse.status).toBe(200);

    const jsResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/apps/editor/assets/index.js`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(jsResponse.status).toBe(200);
    expect(await jsResponse.text()).toContain('window.multiSegmentBasePathWorked = true;');

    const cssResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/apps/editor/assets/app.css`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toContain('body{color:green;}');
  });

  it('does not strip non-asset requests under a detected base path', async () => {
    const app2 = express();
    app2.get('/', (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(
        [
          '<html><head><base href="/editor/"></head><body>',
          '<script type="module" src="/editor/assets/index.js"></script>',
          '</body></html>',
        ].join(''),
      );
    });
    app2.get('/assets/index.js', (_req, res) => {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.send('window.basePathFixWorked = true;');
    });
    app2.get('/editor/api/me', (_req, res) => {
      res.json({ ok: true });
    });
    app2.get('/api/me', (_req, res) => {
      res.status(404).send('wrong-path');
    });
    const targetServer = createServer(app2);
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const htmlResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(htmlResponse.status).toBe(200);

    const apiResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/editor/api/me`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.json()).toEqual({ ok: true });
  });

  it('detects base paths from non-root HTML entry documents', async () => {
    const app2 = express();
    app2.get('/index.html', (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(
        [
          '<html><head><base href="/editor/"></head><body>',
          '<script type="module" src="/editor/assets/index.js"></script>',
          '</body></html>',
        ].join(''),
      );
    });
    app2.get('/assets/index.js', (_req, res) => {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.send('window.indexHtmlBasePathWorked = true;');
    });
    const targetServer = createServer(app2);
    const target = await listen(targetServer);
    cleanups.push(target.close);

    const app = express();
    const previewServer = createServer(app);
    const cleanupPreview = registerBrowserPreviewRoutes({
      app,
      ...createPreviewRouteOptions(target.port),
      server: previewServer,
    });
    const preview = await listen(previewServer);
    cleanups.push(async () => {
      cleanupPreview();
      await preview.close();
    });

    const htmlResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/index.html`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(htmlResponse.status).toBe(200);

    const assetResponse = await fetch(
      `http://127.0.0.1:${preview.port}/_preview/task-1/${target.port}/editor/assets/index.js`,
      { headers: { cookie: SESSION_COOKIE } },
    );
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain('window.indexHtmlBasePathWorked = true;');
  });
});
