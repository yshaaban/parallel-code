import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import { createBrowserAuthController } from './browser-auth.js';

describe('createBrowserAuthController', { timeout: 15_000 }, () => {
  const servers: Array<import('http').Server> = [];

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections?.();
            server.closeIdleConnections?.();
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
  });

  it('exchanges token bootstrap for a session cookie and redirects to the target path', async () => {
    const auth = createBrowserAuthController({ token: 'secret' });
    const app = express();
    auth.registerRoutes(app);

    app.get('/secure', (req, res) => {
      if (!auth.isAuthenticatedRequest(req)) {
        res.status(401).send('unauthorized');
        return;
      }

      res.status(200).send('ok');
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    servers.push(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server port');
    }

    const bootstrapResponse = await fetch(
      `http://127.0.0.1:${address.port}/auth/bootstrap?token=secret&next=%2Fsecure`,
      {
        redirect: 'manual',
      },
    );

    expect(bootstrapResponse.status).toBe(302);
    expect(bootstrapResponse.headers.get('location')).toBe('/secure');
    const cookie = bootstrapResponse.headers.get('set-cookie');
    expect(cookie).toContain('parallel_code_session=');
    expect(cookie).toContain('HttpOnly');

    const secureResponse = await fetch(`http://127.0.0.1:${address.port}/secure`, {
      headers: cookie ? { cookie } : {},
    });

    expect(await secureResponse.text()).toBe('ok');
  });

  it('keeps auth bootstrap next targets intact when bootstrap middleware runs before routes', async () => {
    const auth = createBrowserAuthController({ token: 'secret' });
    const app = express();
    app.use((req, res, next) => {
      if (auth.handleBootstrapIfPresent(req, res)) {
        return;
      }

      next();
    });
    auth.registerRoutes(app);

    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    servers.push(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server port');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/auth/bootstrap?token=secret&next=%2Fsecure`,
      {
        redirect: 'manual',
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/secure');
    expect(response.headers.get('set-cookie')).toContain('parallel_code_session=');
  });

  it('bootstraps deep links and strips the token from the redirected url', async () => {
    const auth = createBrowserAuthController({ token: 'secret' });
    const app = express();
    app.use((req, res, next) => {
      if (auth.handleBootstrapIfPresent(req, res)) {
        return;
      }

      next();
    });
    auth.registerRoutes(app);

    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    servers.push(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server port');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/tasks/123?token=secret&view=review`,
      {
        redirect: 'manual',
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/tasks/123?view=review');
    expect(response.headers.get('set-cookie')).toContain('parallel_code_session=');
  });

  it('renders an auth gate instead of the app shell when unauthenticated', async () => {
    const auth = createBrowserAuthController({ token: 'secret' });
    const app = express();
    auth.registerRoutes(app);

    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    servers.push(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/auth?next=%2Ftasks`);
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(html).toContain('Parallel Code');
    expect(html).toContain('access token');
    expect(html).toContain('name="next" value="/tasks"');
  });

  it('does not allow query-token mutation requests without an authenticated session', async () => {
    const auth = createBrowserAuthController({ token: 'secret' });
    const app = express();
    app.use(express.json());
    auth.registerRoutes(app);

    app.post('/mutate', (req, res) => {
      if (!auth.isAuthenticatedRequest(req)) {
        res.status(401).send('unauthorized');
        return;
      }

      if (!auth.isAllowedMutationRequest(req)) {
        res.status(403).send('forbidden');
        return;
      }

      res.status(204).end();
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    servers.push(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/mutate?token=secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
  });
});
