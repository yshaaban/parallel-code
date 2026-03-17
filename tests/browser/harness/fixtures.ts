import {
  expect,
  test as base,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { IPC } from '../../../electron/ipc/channels.js';
import type { BrowserLabScenario } from './scenarios.js';
import { createPromptReadyScenario } from './scenarios.js';
import { startStandaloneBrowserServer, type BrowserLabServer } from './standalone-server.js';

const DISPLAY_NAME_STORAGE_KEY = 'parallel-code-display-name';
const CLIENT_ID_STORAGE_KEY = 'parallel-code-client-id';

interface BrowserLabOpenPageOptions {
  clientId?: string;
  displayName?: string;
  expectAppShell?: boolean;
  path?: string;
}

interface BrowserLabHarness {
  getAuthedUrl: (path?: string) => string;
  gotoApp: (page: Page, options?: BrowserLabOpenPageOptions) => Promise<void>;
  invokeIpc: <TResult>(
    request: APIRequestContext,
    channel: IPC,
    body?: unknown,
  ) => Promise<TResult>;
  openSession: (
    browser: Browser,
    options?: BrowserLabOpenPageOptions,
  ) => Promise<{ context: BrowserContext; page: Page }>;
  server: BrowserLabServer;
  typeInTerminal: (page: Page, text: string) => Promise<void>;
  waitForTerminalReady: (page: Page) => Promise<void>;
  waitForAgentScrollback: (
    request: APIRequestContext,
    agentId: string,
    text: string,
    timeoutMs?: number,
  ) => Promise<void>;
}

interface BrowserLabOptions {
  scenario: BrowserLabScenario;
}

interface BrowserLabWorkerFixtures {
  browserLabRootDir: string;
}

export const test = base.extend<
  BrowserLabOptions & { browserLab: BrowserLabHarness },
  BrowserLabWorkerFixtures
>({
  scenario: [createPromptReadyScenario(), { option: true }],
  browserLabRootDir: [
    async ({ browserName: _browserName }, use, workerInfo) => {
      const rootDir = `.playwright-browser-lab/worker-${workerInfo.workerIndex}`;
      await use(rootDir);
    },
    { scope: 'worker' },
  ],
  browserLab: async ({ browserLabRootDir, scenario }, use, testInfo) => {
    const contexts = new Set<BrowserContext>();
    const server = await startStandaloneBrowserServer({
      rootDir: browserLabRootDir,
      scenario,
      testSlug: testInfo.title,
    });

    async function openSession(
      browser: Browser,
      options: BrowserLabOpenPageOptions = {},
    ): Promise<{ context: BrowserContext; page: Page }> {
      const context = await browser.newContext();
      contexts.add(context);

      if (options.displayName || options.clientId) {
        await context.addInitScript(
          ([displayNameStorageKey, displayName, clientIdStorageKey, clientId]) => {
            if (displayName) {
              window.localStorage.setItem(displayNameStorageKey, displayName);
            }
            if (clientId) {
              window.sessionStorage.setItem(clientIdStorageKey, clientId);
            }
          },
          [
            DISPLAY_NAME_STORAGE_KEY,
            options.displayName ?? null,
            CLIENT_ID_STORAGE_KEY,
            options.clientId ?? null,
          ] as const,
        );
      }

      const page = await context.newPage();
      await gotoApp(page, options);
      return { context, page };
    }

    function getAuthedUrl(path = '/'): string {
      const url = new URL(path, server.baseUrl);
      url.searchParams.set('token', server.authToken);
      return url.toString();
    }

    async function gotoApp(page: Page, options: BrowserLabOpenPageOptions = {}): Promise<void> {
      await page.goto(getAuthedUrl(options.path ?? '/'));
      if (options.expectAppShell === false) {
        return;
      }

      await page.locator('.app-shell').waitFor({ state: 'visible' });
    }

    async function invokeIpc<TResult>(
      request: APIRequestContext,
      channel: IPC,
      body?: unknown,
    ): Promise<TResult> {
      const response = await request.post(`${server.baseUrl}/api/ipc/${channel}`, {
        data: body ?? {},
        headers: {
          Authorization: `Bearer ${server.authToken}`,
        },
      });

      expect(response.ok(), `IPC ${channel} should return 2xx`).toBeTruthy();
      const payload = (await response.json()) as { result: TResult };
      return payload.result;
    }

    async function waitForAgentScrollback(
      request: APIRequestContext,
      agentId: string,
      text: string,
      timeoutMs = 15_000,
    ): Promise<void> {
      await expect
        .poll(
          async () => {
            const scrollback = await invokeIpc<string>(request, IPC.GetAgentScrollback, {
              agentId,
            });
            if (typeof scrollback !== 'string' || scrollback.length === 0) {
              return '';
            }

            return Buffer.from(scrollback, 'base64').toString('utf8');
          },
          { timeout: timeoutMs },
        )
        .toContain(text);
    }

    async function waitForTerminalReady(page: Page): Promise<void> {
      await page.locator('.xterm').waitFor({ state: 'visible' });
      await page.locator('.xterm-helper-textarea, .xterm textarea').first().waitFor({
        state: 'attached',
      });
    }

    async function typeInTerminal(page: Page, text: string): Promise<void> {
      await waitForTerminalReady(page);
      await page
        .locator('.xterm')
        .first()
        .click({
          position: { x: 24, y: 24 },
        });
      const input = page.locator('.xterm-helper-textarea, .xterm textarea').first();
      await input.focus();
      await page.keyboard.type(text);
    }

    await use({
      getAuthedUrl,
      gotoApp,
      invokeIpc,
      openSession,
      server,
      typeInTerminal,
      waitForTerminalReady,
      waitForAgentScrollback,
    });

    for (const context of contexts) {
      await context.close();
    }
    await server.stop();
  },
});

export { expect } from '@playwright/test';
