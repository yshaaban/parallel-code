import express from 'express';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { runIndependentCleanups } from '../scripts/lib/cleanup-outcome.mjs';
import { registerBrowserLatencyDiagnosticsRoutes } from './browser-latency-diagnostics.js';

const TEST_TOKEN = 'latency-diagnostics-test-token';

const servers: Array<import('node:http').Server> = [];

async function startLatencyDiagnosticsServer(options: {
  authorized?: boolean;
}): Promise<{ port: number }> {
  const app = express();
  registerBrowserLatencyDiagnosticsRoutes({
    app,
    authGatePath: '/auth',
    isAuthorizedRequest: (req) => {
      if (options.authorized) {
        return true;
      }

      return req.header('authorization') === `Bearer ${TEST_TOKEN}`;
    },
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server port');
  }

  return { port: address.port };
}

async function closeServer(server: import('node:http').Server): Promise<void> {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
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

describe('browser latency diagnostics routes', () => {
  afterEach(async () => {
    await runIndependentCleanups(
      'Browser latency diagnostics test servers',
      servers
        .splice(0)
        .map(
          (server, index) =>
            [
              `close browser latency diagnostics server ${index + 1}`,
              () => closeServer(server),
            ] as const,
        ),
    );
  });

  it('requires auth for the browser-visible latency ping endpoint', async () => {
    const { port } = await startLatencyDiagnosticsServer({});
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/latency-ping`);

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns no-store latency pong metadata for authorized probes', async () => {
    const { port } = await startLatencyDiagnosticsServer({});
    const response = await fetch(
      `http://127.0.0.1:${port}/api/diagnostics/latency-ping?bytes=16&nonce=abc`,
      {
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
      },
    );
    const payload = (await response.json()) as {
      kind: string;
      nonce: string | null;
      payload: string;
      payloadBytes: number;
      serverReceivedAtMs: number;
      serverSentAtMs: number;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(payload.kind).toBe('latency-pong');
    expect(payload.nonce).toBe('abc');
    expect(payload.payload).toHaveLength(16);
    expect(payload.payloadBytes).toBe(16);
    expect(payload.serverSentAtMs).toBeGreaterThanOrEqual(payload.serverReceivedAtMs);
  });

  it('redirects unauthenticated latency lab requests to the auth gate', async () => {
    const { port } = await startLatencyDiagnosticsServer({});
    const response = await fetch(`http://127.0.0.1:${port}/latency?samples=4`, {
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth?next=%2Flatency%3Fsamples%3D4');
  });

  it('serves the authenticated latency lab before the SPA fallback', async () => {
    const { port } = await startLatencyDiagnosticsServer({ authorized: true });
    const response = await fetch(`http://127.0.0.1:${port}/latency?autorun=1`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Parallel Code Latency Lab');
    expect(html).toContain('/api/diagnostics/latency-ping');
    expect(html).toContain('/api/ipc/get_backend_runtime_diagnostics');
    expect(html).toContain('WebSocket');
  });
});
