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
const TERMINAL_CREATE_DEBOUNCE_BUFFER_MS = 350;
const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';

interface BrowserLabOpenPageOptions {
  clientId?: string;
  displayName?: string;
  expectAppShell?: boolean;
  path?: string;
}

interface BrowserLabHarness {
  createShellTerminal: (page: Page) => Promise<number>;
  focusTerminal: (page: Page, terminalIndex?: number) => Promise<void>;
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
  runInTerminal: (
    page: Page,
    text: string,
    options?: { pressEnter?: boolean; terminalIndex?: number },
  ) => Promise<void>;
  server: BrowserLabServer;
  typeInTerminal: (page: Page, text: string, terminalIndex?: number) => Promise<void>;
  waitForTerminalReady: (page: Page, terminalIndex?: number) => Promise<void>;
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

    async function waitForTerminalReady(page: Page, terminalIndex = 0): Promise<void> {
      await page.locator(TERMINAL_INPUT_SELECTOR).nth(terminalIndex).waitFor({ state: 'attached' });
    }

    async function focusTerminal(page: Page, terminalIndex = 0): Promise<void> {
      await waitForTerminalReady(page, terminalIndex);
      const input = page.locator(TERMINAL_INPUT_SELECTOR).nth(terminalIndex);
      await input.click({ force: true });
      await input.focus();
    }

    async function typeInTerminal(page: Page, text: string, terminalIndex = 0): Promise<void> {
      await focusTerminal(page, terminalIndex);
      await page.keyboard.type(text);
    }

    async function runInTerminal(
      page: Page,
      text: string,
      options: {
        pressEnter?: boolean;
        terminalIndex?: number;
      } = {},
    ): Promise<void> {
      await typeInTerminal(page, text, options.terminalIndex ?? 0);
      if (options.pressEnter !== false) {
        await page.keyboard.press('Enter');
      }
    }

    async function createShellTerminal(page: Page): Promise<number> {
      const terminalCount = await page.locator(TERMINAL_INPUT_SELECTOR).count();
      await page.getByRole('button', { name: 'New terminal' }).click();
      await waitForTerminalReady(page, terminalCount);
      await page.waitForTimeout(TERMINAL_CREATE_DEBOUNCE_BUFFER_MS);
      return terminalCount;
    }

    await use({
      createShellTerminal,
      focusTerminal,
      getAuthedUrl,
      gotoApp,
      invokeIpc,
      openSession,
      runInTerminal,
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
