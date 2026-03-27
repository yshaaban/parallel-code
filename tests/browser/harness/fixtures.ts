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
import { hasShellPromptReadyInTail } from '../../../src/lib/prompt-detection.js';
import type { BrowserLabScenario } from './scenarios.js';
import { createPromptReadyScenario } from './scenarios.js';
import {
  startStandaloneBrowserServer,
  type BrowserLabServer,
  type BrowserLabServerLifecycleSnapshot,
} from './standalone-server.js';
import { BROWSER_CLIENT_ID_HEADER } from '../../../src/domain/browser-ipc.js';
import { waitForShellTerminalCreation } from './terminal-creation.js';

const DISPLAY_NAME_STORAGE_KEY = 'parallel-code-display-name';
const CLIENT_ID_STORAGE_KEY = 'parallel-code-client-id';
const TERMINAL_CREATE_DEBOUNCE_BUFFER_MS = 350;
const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';
const TERMINAL_STATUS_HISTORY_STORAGE_KEY = '__parallelCodeTerminalStatusHistory';
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';
const TERMINAL_LOADING_OVERLAY_SELECTOR = '[data-terminal-loading-overlay="true"]';
const BROWSER_LAB_PAGE_LIFECYCLE_STORAGE_KEY = '__parallelCodeBrowserLabPageLifecycle';

interface BrowserLabOpenPageOptions {
  clientId?: string;
  displayName?: string;
  expectAppShell?: boolean;
  path?: string;
  prepareContext?: (context: BrowserContext) => Promise<void> | void;
}

interface WaitForTerminalReadyOptions {
  requireLiveRenderReady?: boolean;
}

type WaitForTerminalInteractiveReadyOptions = WaitForTerminalReadyOptions;

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
  invokeSessionIpc: <TResult>(
    request: APIRequestContext,
    page: Page,
    channel: IPC,
    body?: unknown,
  ) => Promise<TResult>;
  openSession: (
    browser: Browser,
    options?: BrowserLabOpenPageOptions,
  ) => Promise<{ context: BrowserContext; page: Page }>;
  readConnectionBannerHistory: (page: Page) => Promise<Array<string | null>>;
  readLifecycleSnapshot: (page: Page) => Promise<BrowserLabLifecycleSnapshot>;
  readTerminalStatusHistory: (page: Page, terminalIndex?: number) => Promise<string[]>;
  runInTerminal: (
    page: Page,
    text: string,
    options?: { pressEnter?: boolean; terminalIndex?: number },
  ) => Promise<void>;
  server: BrowserLabServer;
  typeInTerminal: (page: Page, text: string, terminalIndex?: number) => Promise<void>;
  waitForTerminalInteractiveReady: (
    page: Page,
    terminalIndex?: number,
    options?: WaitForTerminalInteractiveReadyOptions,
  ) => Promise<void>;
  waitForTerminalReady: (
    page: Page,
    terminalIndex?: number,
    options?: WaitForTerminalReadyOptions,
  ) => Promise<void>;
  waitForShellPromptReady: (
    request: APIRequestContext,
    agentId: string,
    timeoutMs?: number,
  ) => Promise<void>;
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

export interface BrowserLabLifecycleEvent {
  atMs: number;
  detail: string | null;
  kind: string;
  source: 'browser' | 'window';
}

export interface BrowserLabConnectionBannerEvent {
  atMs: number;
  message: string | null;
  state: string | null;
}

export interface BrowserLabPageLifecycleSnapshot {
  banner: BrowserLabConnectionBannerEvent[];
  events: BrowserLabLifecycleEvent[];
}

export interface BrowserLabLifecycleSnapshot {
  page: BrowserLabPageLifecycleSnapshot;
  server: BrowserLabServerLifecycleSnapshot;
}

export interface BrowserLabTerminalSnapshot {
  agentId: string | null;
  cursorBlink: boolean;
  liveRenderReady: boolean;
  loadingOverlayVisible: boolean;
  presentationMode: string | null;
  renderHibernating: boolean;
  restoreBlocked: boolean;
  status: string | null;
  surfaceTier: string | null;
}

export interface BrowserLabTerminalDiagnosticsSnapshot {
  anomalySnapshot: unknown | null;
  capturedAtMs: number;
  outputDiagnostics: unknown | null;
  pageLifecycle: BrowserLabPageLifecycleSnapshot;
  rendererDiagnostics: unknown | null;
  terminalSnapshots: BrowserLabTerminalSnapshot[];
  uiFluidityDiagnostics: unknown | null;
}

declare global {
  interface Window {
    __parallelCodeTerminalDiagnostics?: {
      exportJson: () => string;
      getSnapshot: () => BrowserLabTerminalDiagnosticsSnapshot;
      reset: () => void;
    };
  }
}

function getTerminalInput(page: Page, terminalIndex = 0): Locator {
  return page.locator(TERMINAL_INPUT_SELECTOR).nth(terminalIndex);
}

function getTerminalRoot(page: Page, terminalIndex = 0): Locator {
  return page
    .locator(`${TERMINAL_STATUS_SELECTOR}:has(${TERMINAL_INPUT_SELECTOR})`)
    .nth(terminalIndex);
}

export function getTerminalLoadingOverlay(page: Page, terminalIndex = 0): Locator {
  return getTerminalRoot(page, terminalIndex).locator(TERMINAL_LOADING_OVERLAY_SELECTOR);
}

function getBrowserLabPageLifecycle(page: Page): Promise<BrowserLabPageLifecycleSnapshot> {
  return page.evaluate((storageKey) => {
    const lifecycle = (
      window as typeof window & {
        [key: string]:
          | {
              banner: Array<{ atMs: number; message: string | null; state: string | null }>;
              events: Array<{
                atMs: number;
                detail: string | null;
                kind: string;
                source: 'browser' | 'window';
              }>;
              initialized?: boolean;
            }
          | undefined;
      }
    )[storageKey];

    return {
      banner: [...(lifecycle?.banner ?? [])],
      events: [...(lifecycle?.events ?? [])],
    };
  }, BROWSER_LAB_PAGE_LIFECYCLE_STORAGE_KEY);
}

function readAllTerminalSnapshots(page: Page): Promise<BrowserLabTerminalSnapshot[]> {
  return page.evaluate(
    ({ loadingOverlaySelector, statusSelector }) => {
      return Array.from(document.querySelectorAll(statusSelector)).map((statusElement) => ({
        agentId: statusElement.getAttribute('data-terminal-agent-id'),
        cursorBlink: statusElement.getAttribute('data-terminal-cursor-blink') === 'true',
        liveRenderReady: statusElement.getAttribute('data-terminal-live-render-ready') === 'true',
        loadingOverlayVisible:
          statusElement.querySelector(loadingOverlaySelector) instanceof HTMLElement,
        presentationMode: statusElement.getAttribute('data-terminal-presentation-mode'),
        renderHibernating:
          statusElement.getAttribute('data-terminal-render-hibernating') === 'true',
        restoreBlocked: statusElement.getAttribute('data-terminal-restore-blocked') === 'true',
        status: statusElement.getAttribute('data-terminal-status'),
        surfaceTier: statusElement.getAttribute('data-terminal-surface-tier'),
      }));
    },
    {
      loadingOverlaySelector: TERMINAL_LOADING_OVERLAY_SELECTOR,
      statusSelector: TERMINAL_STATUS_SELECTOR,
    },
  );
}

async function readTerminalStatus(input: Locator): Promise<string | null> {
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-status') ?? null,
    TERMINAL_STATUS_SELECTOR,
  );
}

async function readTerminalLiveRenderReady(input: Locator): Promise<string | null> {
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-live-render-ready') ?? null,
    TERMINAL_STATUS_SELECTOR,
  );
}

async function readTerminalLoadingOverlayVisible(input: Locator): Promise<boolean> {
  return input.evaluate(
    (element, { overlaySelector, statusSelector }) => {
      const statusElement = element.closest(statusSelector);
      if (!(statusElement instanceof HTMLElement)) {
        return false;
      }

      return statusElement.querySelector(overlaySelector) instanceof HTMLElement;
    },
    {
      overlaySelector: TERMINAL_LOADING_OVERLAY_SELECTOR,
      statusSelector: TERMINAL_STATUS_SELECTOR,
    },
  );
}

async function readTerminalCursorBlink(input: Locator): Promise<boolean> {
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-cursor-blink') === 'true',
    TERMINAL_STATUS_SELECTOR,
  );
}

async function readTerminalRestoreBlocked(input: Locator): Promise<boolean> {
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-restore-blocked') === 'true',
    TERMINAL_STATUS_SELECTOR,
  );
}

async function waitForTerminalKeyboardFocus(page: Page, terminalIndex: number): Promise<void> {
  await expect
    .poll(async () => readTerminalKeyboardFocusState(page, terminalIndex), { timeout: 5_000 })
    .toEqual({
      activeIndex: terminalIndex,
      hasFocus: true,
      visibilityState: 'visible',
    });
}

async function readTerminalKeyboardFocusState(
  page: Page,
  terminalIndex: number,
): Promise<{
  activeIndex: number;
  hasFocus: boolean;
  visibilityState: string;
}> {
  return page.evaluate((index) => {
    const inputs = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Terminal input"]'),
    );
    const input = inputs[index];
    if (!input) {
      return {
        activeIndex: -1,
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
      };
    }

    return {
      activeIndex: inputs.findIndex((element) => element === document.activeElement),
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    };
  }, terminalIndex);
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

async function readSessionClientId(page: Page): Promise<string | null> {
  return page.evaluate(
    (storageKey) => window.sessionStorage.getItem(storageKey),
    CLIENT_ID_STORAGE_KEY,
  );
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
    const pages = new Set<Page>();
    const browserLifecycleEventsByPage = new Map<Page, BrowserLabLifecycleEvent[]>();
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
      await options.prepareContext?.(context);
      await context.addInitScript((storageKey) => {
        type BrowserLabPageLifecycleStore = {
          banner: Array<{ atMs: number; message: string | null; state: string | null }>;
          events: Array<{
            atMs: number;
            detail: string | null;
            kind: string;
            source: 'browser' | 'window';
          }>;
          initialized?: boolean;
        };

        const windowWithLifecycle = window as typeof window & {
          [key: string]: BrowserLabPageLifecycleStore | undefined;
        };
        const lifecycle =
          windowWithLifecycle[storageKey] ??
          (windowWithLifecycle[storageKey] = {
            banner: [],
            events: [],
          });
        if (lifecycle.initialized) {
          return;
        }

        lifecycle.initialized = true;

        function recordWindowEvent(kind: string, detail: string | null = null): void {
          lifecycle.events.push({
            atMs: Date.now(),
            detail,
            kind,
            source: 'window',
          });
        }

        function readBanner(): { message: string | null; state: string | null } {
          const banner = document.querySelector<HTMLElement>('[data-app-connection-banner="true"]');
          if (!banner) {
            return {
              message: null,
              state: null,
            };
          }

          return {
            message: banner.textContent?.trim() ?? null,
            state: banner.getAttribute('data-app-connection-banner-state'),
          };
        }

        function recordBanner(): void {
          const banner = readBanner();
          const previous = lifecycle.banner[lifecycle.banner.length - 1];
          if (previous?.message === banner.message && previous?.state === banner.state) {
            return;
          }

          lifecycle.banner.push({
            atMs: Date.now(),
            message: banner.message,
            state: banner.state,
          });
        }

        function readTerminalSnapshots(): BrowserLabTerminalSnapshot[] {
          return Array.from(document.querySelectorAll('[data-terminal-status]')).map(
            (statusElement) => ({
              agentId: statusElement.getAttribute('data-terminal-agent-id'),
              cursorBlink: statusElement.getAttribute('data-terminal-cursor-blink') === 'true',
              liveRenderReady:
                statusElement.getAttribute('data-terminal-live-render-ready') === 'true',
              loadingOverlayVisible:
                statusElement.querySelector('[data-terminal-loading-overlay="true"]') instanceof
                HTMLElement,
              presentationMode: statusElement.getAttribute('data-terminal-presentation-mode'),
              renderHibernating:
                statusElement.getAttribute('data-terminal-render-hibernating') === 'true',
              restoreBlocked:
                statusElement.getAttribute('data-terminal-restore-blocked') === 'true',
              status: statusElement.getAttribute('data-terminal-status'),
              surfaceTier: statusElement.getAttribute('data-terminal-surface-tier'),
            }),
          );
        }

        const bannerObserver = new MutationObserver(() => {
          recordBanner();
        });

        function ensureBannerObserver(): void {
          if (!(document.documentElement instanceof HTMLElement)) {
            return;
          }

          bannerObserver.observe(document.documentElement, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ['data-app-connection-banner-state'],
          });
          recordBanner();
        }

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', ensureBannerObserver, { once: true });
        } else {
          ensureBannerObserver();
        }

        window.addEventListener('error', (event) => {
          recordWindowEvent('error', event.message ?? null);
        });
        window.addEventListener('blur', () => {
          recordWindowEvent('blur');
        });
        window.addEventListener('focus', () => {
          recordWindowEvent('focus');
        });
        window.addEventListener('offline', () => {
          recordWindowEvent('offline');
        });
        window.addEventListener('online', () => {
          recordWindowEvent('online');
        });
        window.addEventListener('pagehide', () => {
          recordWindowEvent('pagehide');
        });
        window.addEventListener('pageshow', () => {
          recordWindowEvent('pageshow');
        });
        window.addEventListener('unhandledrejection', (event) => {
          recordWindowEvent(
            'unhandledrejection',
            event.reason instanceof Error ? event.reason.message : String(event.reason ?? ''),
          );
        });
        document.addEventListener('visibilitychange', () => {
          recordWindowEvent('visibilitychange', document.visibilityState);
        });
        document.addEventListener(
          'focusin',
          (event) => {
            const target = event.target instanceof HTMLElement ? event.target : null;
            const terminalInput =
              target?.closest('textarea[aria-label="Terminal input"]') instanceof
              HTMLTextAreaElement;
            recordWindowEvent(
              'focusin',
              terminalInput ? 'terminal-input' : (target?.tagName?.toLowerCase() ?? null),
            );
          },
          true,
        );
        document.addEventListener(
          'focusout',
          (event) => {
            const target = event.target instanceof HTMLElement ? event.target : null;
            const terminalInput =
              target?.closest('textarea[aria-label="Terminal input"]') instanceof
              HTMLTextAreaElement;
            recordWindowEvent(
              'focusout',
              terminalInput ? 'terminal-input' : (target?.tagName?.toLowerCase() ?? null),
            );
          },
          true,
        );

        recordWindowEvent('init', document.visibilityState);
        recordBanner();

        if (!window.__parallelCodeTerminalDiagnostics) {
          window.__parallelCodeTerminalDiagnostics = {
            exportJson(): string {
              return JSON.stringify(this.getSnapshot(), null, 2);
            },
            getSnapshot(): BrowserLabTerminalDiagnosticsSnapshot {
              return {
                anomalySnapshot: window.__parallelCodeTerminalAnomalyMonitor?.getSnapshot() ?? null,
                capturedAtMs: Date.now(),
                outputDiagnostics:
                  window.__parallelCodeTerminalOutputDiagnostics?.getSnapshot() ?? null,
                pageLifecycle: {
                  banner: [...lifecycle.banner],
                  events: [...lifecycle.events],
                },
                rendererDiagnostics:
                  window.__parallelCodeRendererRuntimeDiagnostics?.getSnapshot() ?? null,
                terminalSnapshots: readTerminalSnapshots(),
                uiFluidityDiagnostics:
                  window.__parallelCodeUiFluidityDiagnostics?.getSnapshot() ?? null,
              };
            },
            reset(): void {
              window.__parallelCodeRendererRuntimeDiagnostics?.reset();
              window.__parallelCodeTerminalOutputDiagnostics?.reset();
              window.__parallelCodeTerminalAnomalyMonitor?.reset();
              window.__parallelCodeUiFluidityDiagnostics?.reset();
              lifecycle.banner.length = 0;
              lifecycle.events.length = 0;
              recordBanner();
            },
          };
        }
      }, BROWSER_LAB_PAGE_LIFECYCLE_STORAGE_KEY);

      const page = await context.newPage();
      pages.add(page);
      const browserLifecycleEvents: BrowserLabLifecycleEvent[] = [];
      browserLifecycleEventsByPage.set(page, browserLifecycleEvents);
      const recordBrowserEvent = (kind: string, detail: string | null = null): void => {
        browserLifecycleEvents.push({
          atMs: Date.now(),
          detail,
          kind,
          source: 'browser',
        });
      };
      page.on('close', () => {
        recordBrowserEvent('page-close');
      });
      page.on('crash', () => {
        recordBrowserEvent('page-crash');
      });
      context.on('close', () => {
        recordBrowserEvent('context-close');
      });
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
      return invokeIpcWithClientId<TResult>(request, channel, body);
    }

    async function invokeIpcWithClientId<TResult>(
      request: APIRequestContext,
      channel: IPC,
      body?: unknown,
      clientId?: string | null,
    ): Promise<TResult> {
      const response = await request.post(`${server.baseUrl}/api/ipc/${channel}`, {
        data: body ?? {},
        headers: {
          Authorization: `Bearer ${server.authToken}`,
          ...(clientId ? { [BROWSER_CLIENT_ID_HEADER]: clientId } : {}),
        },
      });

      expect(response.ok(), `IPC ${channel} should return 2xx`).toBeTruthy();
      const payload = (await response.json()) as { result: TResult };
      return payload.result;
    }

    async function invokeSessionIpc<TResult>(
      request: APIRequestContext,
      page: Page,
      channel: IPC,
      body?: unknown,
    ): Promise<TResult> {
      const clientId = await readSessionClientId(page);
      return invokeIpcWithClientId<TResult>(request, channel, body, clientId);
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

    async function waitForShellPromptReady(
      request: APIRequestContext,
      agentId: string,
      timeoutMs = 15_000,
    ): Promise<void> {
      await expect
        .poll(
          async () => {
            const scrollback = await invokeIpc<string>(request, IPC.GetAgentScrollback, {
              agentId,
            });
            if (typeof scrollback !== 'string' || scrollback.length === 0) {
              return false;
            }

            return hasShellPromptReadyInTail(Buffer.from(scrollback, 'base64').toString('utf8'));
          },
          { timeout: timeoutMs },
        )
        .toBe(true);
    }

    async function waitForTerminalReady(
      page: Page,
      terminalIndex = 0,
      options: WaitForTerminalReadyOptions = {},
    ): Promise<void> {
      const input = getTerminalInput(page, terminalIndex);
      await input.waitFor({ state: 'attached' });
      await expect.poll(() => readTerminalStatus(input)).toBe('ready');
      if (options.requireLiveRenderReady !== false) {
        await expect.poll(() => readTerminalLiveRenderReady(input)).toBe('true');
      }
      await expect.poll(() => readTerminalLoadingOverlayVisible(input)).toBe(false);
    }

    async function waitForTerminalInteractiveReady(
      page: Page,
      terminalIndex = 0,
      options: WaitForTerminalInteractiveReadyOptions = {},
    ): Promise<void> {
      const input = getTerminalInput(page, terminalIndex);
      await waitForTerminalReady(page, terminalIndex, options);
      await expect.poll(() => readTerminalRestoreBlocked(input)).toBe(false);
      await expect.poll(() => readTerminalCursorBlink(input)).toBe(true);
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

    async function readLifecycleSnapshot(page: Page): Promise<BrowserLabLifecycleSnapshot> {
      const pageLifecycle = await getBrowserLabPageLifecycle(page);
      return {
        page: {
          ...pageLifecycle,
          events: [...pageLifecycle.events, ...(browserLifecycleEventsByPage.get(page) ?? [])],
        },
        server: server.getLifecycleSnapshot(),
      };
    }

    async function readConnectionBannerHistory(page: Page): Promise<Array<string | null>> {
      const lifecycle = await getBrowserLabPageLifecycle(page);
      return lifecycle.banner.map((entry) => entry.state);
    }

    async function focusTerminal(page: Page, terminalIndex = 0): Promise<void> {
      await waitForTerminalReady(page, terminalIndex);
      const input = getTerminalInput(page, terminalIndex);
      const terminalRoot = getTerminalRoot(page, terminalIndex);
      await page.bringToFront();
      await terminalRoot.scrollIntoViewIfNeeded();
      await terminalRoot.click();
      await input.focus();
      await waitForTerminalKeyboardFocus(page, terminalIndex);
    }

    async function typeInTerminal(page: Page, text: string, terminalIndex = 0): Promise<void> {
      await focusTerminal(page, terminalIndex);
      await waitForTerminalKeyboardFocus(page, terminalIndex);
      await getTerminalInput(page, terminalIndex).pressSequentially(text);
    }

    async function runInTerminal(
      page: Page,
      text: string,
      options: {
        pressEnter?: boolean;
        terminalIndex?: number;
      } = {},
    ): Promise<void> {
      const terminalIndex = options.terminalIndex ?? 0;
      await waitForTerminalInteractiveReady(page, terminalIndex);
      await typeInTerminal(page, text, terminalIndex);
      if (options.pressEnter !== false) {
        await waitForTerminalKeyboardFocus(page, terminalIndex);
        await getTerminalInput(page, terminalIndex).press('Enter');
      }
    }

    async function createShellTerminal(page: Page): Promise<number> {
      const terminalList = page.locator(TERMINAL_INPUT_SELECTOR);
      const terminalCount = await terminalList.count();
      const createTerminalButton = page.getByRole('button', { name: 'New terminal' });
      await waitForShellTerminalCreation({
        clickCreateTerminal: async () => {
          await createTerminalButton.scrollIntoViewIfNeeded();
          await createTerminalButton.click();
        },
        waitForTerminalCount: async (timeoutMs) => {
          try {
            await expect
              .poll(async () => terminalList.count(), { timeout: timeoutMs })
              .toBe(terminalCount + 1);
            return true;
          } catch {
            return false;
          }
        },
      });

      await waitForTerminalReady(page, terminalCount);
      await page.waitForTimeout(TERMINAL_CREATE_DEBOUNCE_BUFFER_MS);
      return terminalCount;
    }

    try {
      await use({
        beginTerminalStatusHistory,
        createShellTerminal,
        focusTerminal,
        getAuthedUrl,
        gotoApp,
        invokeIpc,
        invokeSessionIpc,
        openSession,
        readConnectionBannerHistory,
        readTerminalStatusHistory,
        readLifecycleSnapshot,
        runInTerminal,
        server,
        typeInTerminal,
        waitForTerminalInteractiveReady,
        waitForTerminalReady,
        waitForShellPromptReady,
        waitForAgentScrollback,
      });
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const lifecycleSnapshots: Array<{
          page:
            | BrowserLabPageLifecycleSnapshot
            | { banner: []; events: BrowserLabLifecycleEvent[] };
          server: BrowserLabServerLifecycleSnapshot;
        }> = [];
        if (pages.size === 0) {
          lifecycleSnapshots.push({
            page: { banner: [], events: [] },
            server: server.getLifecycleSnapshot(),
          });
        }

        for (const page of pages) {
          try {
            lifecycleSnapshots.push(await readLifecycleSnapshot(page));
          } catch {
            lifecycleSnapshots.push({
              page: {
                banner: [],
                events: [...(browserLifecycleEventsByPage.get(page) ?? [])],
              },
              server: server.getLifecycleSnapshot(),
            });
          }
        }

        await testInfo.attach('browser-lab-lifecycle.json', {
          body: JSON.stringify(lifecycleSnapshots, null, 2),
          contentType: 'application/json',
        });
        const terminalSnapshots: Array<BrowserLabTerminalSnapshot[]> = [];
        for (const page of pages) {
          try {
            terminalSnapshots.push(await readAllTerminalSnapshots(page));
          } catch {
            terminalSnapshots.push([]);
          }
        }
        await testInfo.attach('browser-lab-terminals.json', {
          body: JSON.stringify(terminalSnapshots, null, 2),
          contentType: 'application/json',
        });
      }

      await Promise.allSettled(
        Array.from(contexts, (context) => {
          return context.close();
        }),
      );
      await server.stop();
    }
  },
});

export { expect } from '@playwright/test';
