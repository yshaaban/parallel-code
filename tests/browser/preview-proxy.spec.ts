import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';

import type { Page } from '@playwright/test';

import { IPC } from '../../electron/ipc/channels.js';
import type { TaskPortSnapshot } from '../../src/domain/server-state.js';
import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

interface PreviewTargetRequest {
  authorization: string | null;
  cookie: string | null;
  url: string;
}

interface PreviewTargetServer {
  close: () => Promise<void>;
  port: number;
  requests: PreviewTargetRequest[];
}

function readRequestHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value.join('; ');
  }

  return value ?? null;
}

function capturePreviewTargetRequest(req: IncomingMessage): PreviewTargetRequest {
  return {
    authorization: readRequestHeader(req, 'authorization'),
    cookie: readRequestHeader(req, 'cookie'),
    url: req.url ?? '/',
  };
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function writeJavaScript(res: ServerResponse, script: string): void {
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
  });
  res.end(script);
}

function writeHtml(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': 'target-session=abc; Path=/; HttpOnly',
  });
  res.end(
    [
      '<html><head><title>Preview Canary</title></head>',
      '<body>',
      `<main id="preview-root" data-path="${escapeHtmlAttribute(req.url ?? '/')}">Preview canary</main>`,
      '<a id="preview-relative-link" href="deeper/page?from=link">Deeper</a>',
      '<script type="module" src="/assets/app.js"></script>',
      '</body></html>',
    ].join(''),
  );
}

function createPreviewAssetScript(req: IncomingMessage): string {
  const request = capturePreviewTargetRequest(req);
  return `
const root = document.querySelector('#preview-root');
if (root instanceof HTMLElement) {
  root.dataset.scriptLoaded = 'true';
  root.dataset.scriptPath = ${JSON.stringify(request.url)};
  root.dataset.scriptAuth = ${JSON.stringify(request.authorization ?? '')};
  root.dataset.scriptCookie = ${JSON.stringify(request.cookie ?? '')};
}
`;
}

function createPreviewTargetServer(): Promise<PreviewTargetServer> {
  const requests: PreviewTargetRequest[] = [];
  const server = createServer((req, res) => {
    requests.push(capturePreviewTargetRequest(req));
    const url = new URL(req.url ?? '/', 'http://preview-target.test');
    if (url.pathname === '/assets/app.js') {
      writeJavaScript(res, createPreviewAssetScript(req));
      return;
    }

    writeHtml(req, res);
  });

  return new Promise<PreviewTargetServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Preview target failed to bind to an ephemeral port'));
        return;
      }

      resolve({
        port: address.port,
        requests,
        close: () => closeHttpServer(server),
      });
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function buildPreviewPath(taskId: string, port: number, path: string): string {
  return `/_preview/${encodeURIComponent(taskId)}/${port}${path}`;
}

async function expectPreviewScriptLoaded(page: Page): Promise<void> {
  await expect(page.locator('#preview-root')).toHaveAttribute('data-script-loaded', 'true');
}

function expectNoParallelCodeAuthReachedTarget(
  requests: PreviewTargetRequest[],
  authToken: string,
): void {
  for (const request of requests) {
    expect(request.authorization).toBeNull();
    expect(request.cookie ?? '').not.toContain('parallel_code_session=');
    expect(request.cookie ?? '').not.toContain(authToken);
    expect(request.url).not.toContain(authToken);
  }
}

test.describe('browser-lab preview proxy', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('loads exposed previews through the browser cookie jar without leaking app auth', async ({
    browser,
    browserLab,
    request,
  }) => {
    const target = await createPreviewTargetServer();
    try {
      const session = await browserLab.openSession(browser, {
        displayName: 'Preview Proxy Browser Canary',
      });
      const { context, page } = session;

      try {
        const snapshot = await browserLab.invokeIpc<TaskPortSnapshot>(request, IPC.ExposePort, {
          label: 'Preview browser canary',
          port: target.port,
          taskId: browserLab.server.taskId,
        });
        expect(snapshot.exposed.map((port) => port.port)).toContain(target.port);

        const previewPath = buildPreviewPath(
          browserLab.server.taskId,
          target.port,
          '/nested/path?mode=browser',
        );
        const previewResponse = await page.goto(
          new URL(previewPath, browserLab.server.baseUrl).href,
        );

        expect(previewResponse?.ok()).toBe(true);
        await expect(page).toHaveURL(
          new RegExp(`/_preview/${browserLab.server.taskId}/${target.port}/nested/path`, 'u'),
        );
        await expect(page.locator('#preview-root')).toHaveAttribute(
          'data-path',
          '/nested/path?mode=browser',
        );
        await expectPreviewScriptLoaded(page);
        await expect(page.locator('#preview-root')).toHaveAttribute(
          'data-script-path',
          '/assets/app.js',
        );
        await expect(page.locator('#preview-root')).toHaveAttribute('data-script-auth', '');
        await expect(page.locator('#preview-root')).toHaveAttribute(
          'data-script-cookie',
          'target-session=abc',
        );
        await expect
          .poll(() => page.evaluate(() => document.baseURI))
          .toContain(`/_preview/${browserLab.server.taskId}/${target.port}/nested/`);

        await page.locator('#preview-relative-link').click();
        await expect(page.locator('#preview-root')).toHaveAttribute(
          'data-path',
          '/nested/deeper/page?from=link',
        );
        await expectPreviewScriptLoaded(page);
        await expect(page.locator('#preview-root')).toHaveAttribute(
          'data-script-cookie',
          'target-session=abc',
        );

        expectNoParallelCodeAuthReachedTarget(target.requests, browserLab.server.authToken);
      } finally {
        await context.close();
      }
    } finally {
      await target.close();
    }
  });
});
