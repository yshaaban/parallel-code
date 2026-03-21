import {
  expect,
  test as base,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
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
const TERMINAL_STATUS_HISTORY_STORAGE_KEY = '__parallelCodeTerminalStatusHistory';
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';
const TERMINAL_LOADING_TEXT =
  /Connecting to terminal…|Attaching terminal…|Restoring terminal output…/u;

interface BrowserLabOpenPageOptions {
  clientId?: string;
  displayName?: string;
  expectAppShell?: boolean;
  path?: string;
}

interface BrowserLabHarness {
  beginTerminalStatusHistory: (page: Page, terminalIndex?: number) => Promise<void>;
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
  readTerminalStatusHistory: (page: Page, terminalIndex?: number) => Promise<string[]>;
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

function getTerminalInput(page: Page, terminalIndex = 0): Locator {
  return page.locator(TERMINAL_INPUT_SELECTOR).nth(terminalIndex);
}

function getTerminalStatusContainer(page: Page, terminalIndex = 0): Locator {
  return page.locator(TERMINAL_STATUS_SELECTOR).filter({
    has: getTerminalInput(page, terminalIndex),
  });
}

async function readTerminalStatus(input: Locator): Promise<string | null> {
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-status') ?? null,
    TERMINAL_STATUS_SELECTOR,
  );
}

async function readTerminalStatusElement(input: Locator): Promise<{
  agentId: string | null;
  status: string | null;
}> {
  return input.evaluate((element, statusSelector) => {
    const statusElement = element.closest(statusSelector);
    return {
      agentId: statusElement?.getAttribute('data-terminal-agent-id') ?? null,
      status: statusElement?.getAttribute('data-terminal-status') ?? null,
    };
  }, TERMINAL_STATUS_SELECTOR);
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
      const input = getTerminalInput(page, terminalIndex);
      const statusContainer = getTerminalStatusContainer(page, terminalIndex);
      await input.waitFor({ state: 'attached' });
      await expect.poll(() => readTerminalStatus(input)).toBe('ready');
      await expect(statusContainer.getByText(TERMINAL_LOADING_TEXT)).toHaveCount(0);
    }

    async function beginTerminalStatusHistory(page: Page, terminalIndex = 0): Promise<void> {
      const input = getTerminalInput(page, terminalIndex);
      await input.waitFor({ state: 'attached' });
      await input.evaluate(
        (element, { statusSelector, storageKey }) => {
          const statusElement = element.closest(statusSelector);
          if (!(statusElement instanceof HTMLElement)) {
            return;
          }

          const agentId = statusElement.getAttribute('data-terminal-agent-id');
          if (!agentId) {
            return;
          }

          type TerminalStatusHistoryEntry = {
            history: string[];
            observer: MutationObserver;
          };

          const windowWithHistory = window as typeof window & {
            [key: string]: Record<string, TerminalStatusHistoryEntry> | undefined;
          };
          const historyStore =
            windowWithHistory[storageKey] ?? (windowWithHistory[storageKey] = {});
          if (historyStore[agentId]) {
            return;
          }

          const history = [statusElement.getAttribute('data-terminal-status') ?? 'unknown'];
          let lastStatus = history[0];
          const observer = new MutationObserver(() => {
            const nextStatus = statusElement.getAttribute('data-terminal-status') ?? 'unknown';
            if (nextStatus === lastStatus) {
              return;
            }

            history.push(nextStatus);
            lastStatus = nextStatus;
          });
          observer.observe(statusElement, {
            attributeFilter: ['data-terminal-status'],
            attributes: true,
          });
          historyStore[agentId] = { history, observer };
        },
        {
          statusSelector: TERMINAL_STATUS_SELECTOR,
          storageKey: TERMINAL_STATUS_HISTORY_STORAGE_KEY,
        },
      );
    }

    async function readTerminalStatusHistory(page: Page, terminalIndex = 0): Promise<string[]> {
      const input = getTerminalInput(page, terminalIndex);
      await input.waitFor({ state: 'attached' });
      const statusElement = await readTerminalStatusElement(input);
      if (!statusElement.agentId) {
        return [];
      }

      return page.evaluate(
        ({ agentId, storageKey }) => {
          const historyStore = (
            window as typeof window & {
              [key: string]:
                | Record<string, { history: string[]; observer: MutationObserver }>
                | undefined;
            }
          )[storageKey];
          return [...(historyStore?.[agentId]?.history ?? [])];
        },
        {
          agentId: statusElement.agentId,
          storageKey: TERMINAL_STATUS_HISTORY_STORAGE_KEY,
        },
      );
    }

    async function focusTerminal(page: Page, terminalIndex = 0): Promise<void> {
      await waitForTerminalReady(page, terminalIndex);
      const input = getTerminalInput(page, terminalIndex);
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
      const terminalList = page.locator(TERMINAL_INPUT_SELECTOR);
      const terminalCount = await terminalList.count();
      await page.getByRole('button', { name: 'New terminal' }).click();
      await expect
        .poll(async () => terminalList.count(), { timeout: 15_000 })
        .toBe(terminalCount + 1);
      await waitForTerminalReady(page, terminalCount);
      await page.waitForTimeout(TERMINAL_CREATE_DEBOUNCE_BUFFER_MS);
      return terminalCount;
    }

    await use({
      beginTerminalStatusHistory,
      createShellTerminal,
      focusTerminal,
      getAuthedUrl,
      gotoApp,
      invokeIpc,
      openSession,
      readTerminalStatusHistory,
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
