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
const REMOTE_CLIENT_ID_STORAGE_KEY = 'parallel-code-remote-client-id';
const TERMINAL_CREATE_DEBOUNCE_BUFFER_MS = 350;
const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';
const TERMINAL_STATUS_HISTORY_STORAGE_KEY = '__parallelCodeTerminalStatusHistory';
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';
const TERMINAL_LOADING_OVERLAY_SELECTOR = '[data-terminal-loading-overlay="true"]';
const BROWSER_LAB_PAGE_LIFECYCLE_STORAGE_KEY = '__parallelCodeBrowserLabPageLifecycle';
const DEFAULT_TERMINAL_TYPE_DELAY_MS = 20;

interface BrowserLabOpenPageOptions {
  clientId?: string;
  displayName?: string;
  expectAppShell?: boolean;
  gotoWaitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
  onAfterGoto?: () => void;
  onBeforeGoto?: () => void;
  path?: string;
  prepareContext?: (context: BrowserContext) => Promise<void> | void;
  viewportSize?: {
    height: number;
    width: number;
  };
}

interface WaitForTerminalReadyOptions {
  requireLiveRenderReady?: boolean;
}

type WaitForTerminalInteractiveReadyOptions = WaitForTerminalReadyOptions;

interface TypeInTerminalOptions {
  requireInteractiveReady?: boolean;
  terminalIndex?: number;
  typeDelayMs?: number;
}

interface RunInTerminalOptions extends TypeInTerminalOptions {
  pressEnter?: boolean;
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
  retainSessionTaskCommandLease: (
    request: APIRequestContext,
    page: Page,
    taskId: string,
    action: string,
  ) => Promise<void>;
  retainSessionAgentTaskCommandLease: (
    request: APIRequestContext,
    page: Page,
    agentId: string,
    action: string,
  ) => Promise<string>;
  runInTerminal: (page: Page, text: string, options?: RunInTerminalOptions) => Promise<void>;
  server: BrowserLabServer;
  typeInTerminal: (
    page: Page,
    text: string,
    terminalIndexOrOptions?: number | TypeInTerminalOptions,
  ) => Promise<void>;
  waitForTerminalLogicalReady: (page: Page, terminalIndex?: number) => Promise<void>;
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
  waitForTerminalPaintReady: (
    page: Page,
    terminalIndex?: number,
    options?: { timeoutMs?: number },
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

interface AppShellFailureSnapshot {
  appErrorFallbackVisible: boolean;
  authGateVisible: boolean;
  bodyText: string | null;
  hasAppShell: boolean;
  hasRootElement: boolean;
  readyState: DocumentReadyState | null;
  title: string | null;
  url: string | null;
}

export interface BrowserLabTerminalSnapshot {
  agentId: string | null;
  cursorBlink: boolean;
  liveRenderReady: boolean;
  loadingOverlayVisible: boolean;
  paintReady: boolean;
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
  terminalAttachTrace: unknown | null;
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
  return getTerminalStatusRoot(page, terminalIndex).locator(TERMINAL_INPUT_SELECTOR).first();
}

function getTerminalStatusRoot(page: Page, terminalIndex = 0): Locator {
  return page.locator(TERMINAL_STATUS_SELECTOR).nth(terminalIndex);
}

function getTerminalRoot(page: Page, terminalIndex = 0): Locator {
  return getTerminalStatusRoot(page, terminalIndex);
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

async function readAppShellFailureSnapshot(page: Page): Promise<AppShellFailureSnapshot | null> {
  if (page.isClosed()) {
    return null;
  }

  try {
    return await page.evaluate(() => {
      const bodyText = document.body?.innerText?.trim() ?? null;
      return {
        appErrorFallbackVisible: bodyText?.includes('Something went wrong') ?? false,
        authGateVisible: bodyText?.includes('Parallel Code Sign In') ?? false,
        bodyText: bodyText ? bodyText.slice(0, 500) : null,
        hasAppShell: document.querySelector('.app-shell') instanceof HTMLElement,
        hasRootElement: document.getElementById('root') instanceof HTMLElement,
        readyState: document.readyState,
        title: document.title || null,
        url: window.location.href,
      } satisfies AppShellFailureSnapshot;
    });
  } catch {
    return null;
  }
}

export function readTerminalSnapshots(page: Page): Promise<BrowserLabTerminalSnapshot[]> {
  return page.evaluate(
    ({ loadingOverlaySelector, statusSelector }) => {
      return Array.from(document.querySelectorAll(statusSelector)).map((statusElement) => ({
        agentId: statusElement.getAttribute('data-terminal-agent-id'),
        cursorBlink: statusElement.getAttribute('data-terminal-cursor-blink') === 'true',
        liveRenderReady: statusElement.getAttribute('data-terminal-live-render-ready') === 'true',
        loadingOverlayVisible:
          statusElement.querySelector(loadingOverlaySelector) instanceof HTMLElement,
        paintReady: statusElement.getAttribute('data-terminal-paint-ready') === 'true',
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
  return readTerminalStatusAttribute(input, 'data-terminal-status');
}

async function readTerminalLiveRenderReady(input: Locator): Promise<string | null> {
  return readTerminalStatusAttribute(input, 'data-terminal-live-render-ready');
}

async function readTerminalStatusAttribute(
  input: Locator,
  attributeName: string,
): Promise<string | null> {
  return input.evaluate(
    (element, { attributeName: currentAttributeName, statusSelector }) =>
      element.closest(statusSelector)?.getAttribute(currentAttributeName) ?? null,
    {
      attributeName,
      statusSelector: TERMINAL_STATUS_SELECTOR,
    },
  );
}

async function readTerminalLogicalReady(input: Locator): Promise<boolean> {
  const [status, loadingOverlayVisible] = await Promise.all([
    readTerminalStatus(input),
    readTerminalLoadingOverlayVisible(input),
  ]);
  return status === 'ready' && loadingOverlayVisible === false;
}

async function readTerminalPaintReady(input: Locator): Promise<boolean> {
  const [status, paintReady, loadingOverlayVisible] = await Promise.all([
    readTerminalStatus(input),
    readTerminalStatusAttribute(input, 'data-terminal-paint-ready'),
    readTerminalLoadingOverlayVisible(input),
  ]);
  return status === 'ready' && paintReady === 'true' && loadingOverlayVisible === false;
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
  const restoreBlocked = await readTerminalStatusAttribute(input, 'data-terminal-restore-blocked');
  return restoreBlocked === 'true';
}

async function readTerminalStatusReady(statusRoot: Locator): Promise<boolean> {
  return readStatusRootBooleanAttribute(statusRoot, 'data-terminal-status', 'ready');
}

async function readTerminalPaintReadyFromStatusRoot(statusRoot: Locator): Promise<boolean> {
  return readStatusRootBooleanAttribute(statusRoot, 'data-terminal-paint-ready', 'true');
}

async function readStatusRootBooleanAttribute(
  statusRoot: Locator,
  attributeName: string,
  expectedValue: string,
): Promise<boolean> {
  return statusRoot.evaluate(
    (element, { attributeName: currentAttributeName, expectedValue: currentExpectedValue }) =>
      element.getAttribute(currentAttributeName) === currentExpectedValue,
    {
      attributeName,
      expectedValue,
    },
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

async function waitForTerminalLogicalReady(page: Page, terminalIndex = 0): Promise<void> {
  const input = getTerminalInput(page, terminalIndex);
  await input.waitFor({ state: 'attached' });
  await expect.poll(() => readTerminalLogicalReady(input)).toBe(true);
}

async function waitForTerminalPaintReady(
  page: Page,
  terminalIndex = 0,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const input = getTerminalInput(page, terminalIndex);
  await waitForTerminalLogicalReady(page, terminalIndex);
  await expect.poll(() => readTerminalPaintReady(input), { timeout: options.timeoutMs }).toBe(true);
}

async function readTerminalKeyboardFocusState(
  page: Page,
  terminalIndex: number,
): Promise<{
  activeIndex: number;
  hasFocus: boolean;
  visibilityState: string;
}> {
  return page.evaluate(
    ({ inputSelector, index, statusSelector }) => {
      const statusRoots = Array.from(document.querySelectorAll<HTMLElement>(statusSelector));
      const statusRoot = statusRoots[index];
      const input = statusRoot?.querySelector<HTMLTextAreaElement>(inputSelector);
      if (!input) {
        return {
          activeIndex: -1,
          hasFocus: document.hasFocus(),
          visibilityState: document.visibilityState,
        };
      }

      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement)) {
        return {
          activeIndex: -1,
          hasFocus: document.hasFocus(),
          visibilityState: document.visibilityState,
        };
      }

      const activeIndex = statusRoots.findIndex((root) => root.contains(activeElement));
      return {
        activeIndex,
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
      };
    },
    {
      index: terminalIndex,
      inputSelector: TERMINAL_INPUT_SELECTOR,
      statusSelector: TERMINAL_STATUS_SELECTOR,
    },
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

async function readSessionClientId(page: Page): Promise<string | null> {
  return page.evaluate(
    ([remoteStorageKey, legacyStorageKey]) => {
      try {
        return (
          window.sessionStorage.getItem(remoteStorageKey) ??
          window.sessionStorage.getItem(legacyStorageKey)
        );
      } catch {
        return null;
      }
    },
    [REMOTE_CLIENT_ID_STORAGE_KEY, CLIENT_ID_STORAGE_KEY] as const,
  );
}

function createBrowserLabClientId(): string {
  return `browser-lab-${Math.random().toString(36).slice(2, 10)}`;
}

export async function waitForAppShellVisible(page: Page, timeoutMs = 15_000): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  const appShell = page.locator('.app-shell').first();
  try {
    await appShell.waitFor({ state: 'attached', timeout: timeoutMs });
    await expect(appShell).toBeVisible({ timeout: timeoutMs });
  } catch (error) {
    const failureSnapshot = await readAppShellFailureSnapshot(page);
    console.warn('waitForAppShellVisible failed', {
      failureSnapshot,
      pageClosed: page.isClosed(),
      url: page.url(),
    });
    try {
      await page.screenshot({
        path: '/tmp/wait-for-app-shell-visible-failure.png',
      });
    } catch {
      /* ignore failure diagnostics */
    }
    throw error;
  }
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
      const clientId = options.clientId ?? createBrowserLabClientId();

      await context.addInitScript(
        ([displayNameStorageKey, displayName, clientIdStorageKey, injectedClientId]) => {
          if (displayName) {
            try {
              window.localStorage.setItem(displayNameStorageKey, displayName);
            } catch {
              /* ignore storage bootstrap failures in opaque documents */
            }
          }
          try {
            for (const storageKey of clientIdStorageKey) {
              window.sessionStorage.setItem(storageKey, injectedClientId);
            }
          } catch {
            /* ignore storage bootstrap failures in opaque documents */
          }
        },
        [
          DISPLAY_NAME_STORAGE_KEY,
          options.displayName ?? null,
          [REMOTE_CLIENT_ID_STORAGE_KEY, CLIENT_ID_STORAGE_KEY],
          clientId,
        ] as const,
      );
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
          __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, unknown>;
          [key: string]: BrowserLabPageLifecycleStore | undefined;
        };
        windowWithLifecycle.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ ??= {};
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

        function getFocusEventTargetLabel(target: EventTarget | null): string | null {
          if (!(target instanceof HTMLElement)) {
            return null;
          }

          const terminalInput = target.closest('textarea[aria-label="Terminal input"]');
          if (terminalInput instanceof HTMLTextAreaElement) {
            return 'terminal-input';
          }

          return target.tagName.toLowerCase();
        }

        function getUnhandledRejectionMessage(reason: unknown): string {
          if (reason instanceof Error) {
            return reason.message;
          }

          return String(reason ?? '');
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
          recordWindowEvent('unhandledrejection', getUnhandledRejectionMessage(event.reason));
        });
        document.addEventListener('visibilitychange', () => {
          recordWindowEvent('visibilitychange', document.visibilityState);
        });
        document.addEventListener(
          'focusin',
          (event) => {
            recordWindowEvent('focusin', getFocusEventTargetLabel(event.target));
          },
          true,
        );
        document.addEventListener(
          'focusout',
          (event) => {
            recordWindowEvent('focusout', getFocusEventTargetLabel(event.target));
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
                terminalAttachTrace:
                  windowWithLifecycle.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ ?? null,
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
      if (options.viewportSize) {
        await page.setViewportSize(options.viewportSize);
      }
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
      page.on('console', (message) => {
        if (message.type() !== 'error' && message.type() !== 'warning') {
          return;
        }

        recordBrowserEvent(`console:${message.type()}`, message.text());
      });
      page.on('close', () => {
        recordBrowserEvent('page-close');
      });
      page.on('crash', () => {
        recordBrowserEvent('page-crash');
      });
      page.on('pageerror', (error) => {
        recordBrowserEvent('pageerror', error.message);
      });
      page.on('response', (response) => {
        if (response.ok()) {
          return;
        }

        const responseUrl = response.url();
        if (!responseUrl.includes('/api/ipc/')) {
          return;
        }

        const endpoint = responseUrl.split('/api/ipc/')[1] ?? responseUrl;
        recordBrowserEvent('ipc-response-error', `${response.status()} ${endpoint}`);
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
      options.onBeforeGoto?.();
      await page.goto(getAuthedUrl(options.path ?? '/'), {
        waitUntil: options.gotoWaitUntil,
      });
      options.onAfterGoto?.();
      if (options.expectAppShell === false) {
        return;
      }

      await waitForAppShellVisible(page);
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

      if (!response.ok()) {
        expect(response.ok(), `IPC ${channel} should return 2xx: ${await response.text()}`).toBe(
          true,
        );
      }
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

    async function readRequiredSessionClientId(page: Page): Promise<string> {
      const clientId = await readSessionClientId(page);
      expect(clientId, 'browser session client id should be available').toBeTruthy();
      if (!clientId) {
        throw new Error('Browser session client id was not available');
      }

      return clientId;
    }

    async function retainSessionTaskCommandLease(
      request: APIRequestContext,
      page: Page,
      taskId: string,
      action: string,
    ): Promise<void> {
      const clientId = await readRequiredSessionClientId(page);

      const lease = await invokeIpcWithClientId<{
        acquired: boolean;
        controllerId: string | null;
      }>(
        request,
        IPC.AcquireTaskCommandLease,
        {
          action,
          clientId,
          ownerId: `${clientId}:browser-lab`,
          taskId,
        },
        clientId,
      );
      expect(lease.controllerId).toBe(clientId);
      expect(lease.acquired).toBe(true);
    }

    async function readAgentTaskIdForLease(
      request: APIRequestContext,
      agentId: string,
    ): Promise<string> {
      let taskId: string | null = null;
      await expect
        .poll(
          async () => {
            const snapshots = await invokeIpc<Array<{ agentId: string; taskId: string }>>(
              request,
              IPC.GetAgentSupervision,
            );
            taskId = snapshots.find((snapshot) => snapshot.agentId === agentId)?.taskId ?? null;
            return taskId;
          },
          { timeout: 10_000 },
        )
        .toBeTruthy();

      if (!taskId) {
        throw new Error(`No supervised task id was available for ${agentId}`);
      }
      return taskId;
    }

    async function retainSessionAgentTaskCommandLease(
      request: APIRequestContext,
      page: Page,
      agentId: string,
      action: string,
    ): Promise<string> {
      const taskId = await readAgentTaskIdForLease(request, agentId);
      await retainSessionTaskCommandLease(request, page, taskId, action);
      return taskId;
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
      if (options.requireLiveRenderReady === false) {
        await waitForTerminalLogicalReady(page, terminalIndex);
        return;
      }

      await input.waitFor({ state: 'attached' });
      await expect.poll(() => readTerminalStatus(input)).toBe('ready');
      await expect.poll(() => readTerminalLiveRenderReady(input)).toBe('true');
      await expect.poll(() => readTerminalLoadingOverlayVisible(input)).toBe(false);
    }

    async function waitForTerminalInteractiveReady(
      page: Page,
      terminalIndex = 0,
      options: WaitForTerminalInteractiveReadyOptions = {},
    ): Promise<void> {
      void options;
      const input = getTerminalInput(page, terminalIndex);
      await waitForTerminalPaintReady(page, terminalIndex);
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
      let pageLifecycle: BrowserLabPageLifecycleSnapshot;
      try {
        pageLifecycle = await getBrowserLabPageLifecycle(page);
      } catch (error) {
        pageLifecycle = {
          banner: [],
          events: [
            {
              atMs: Date.now(),
              detail: error instanceof Error ? error.message : String(error),
              kind: 'page-lifecycle-read-failed',
              source: 'browser',
            },
          ],
        };
      }
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
      await waitForTerminalLogicalReady(page, terminalIndex);
      await page.bringToFront();
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const input = getTerminalInput(page, terminalIndex);
          const terminalRoot = getTerminalRoot(page, terminalIndex);
          await terminalRoot.scrollIntoViewIfNeeded({ timeout: 5_000 });
          await terminalRoot.click({ position: { x: 12, y: 12 }, timeout: 5_000 });
          await input.focus({ timeout: 5_000 });
          await waitForTerminalKeyboardFocus(page, terminalIndex);
          return;
        } catch (error) {
          lastError = error;
          await page.waitForTimeout(100);
          await waitForTerminalLogicalReady(page, terminalIndex);
        }
      }

      throw lastError ?? new Error(`Failed to focus terminal ${terminalIndex}`);
    }

    async function typeInTerminal(
      page: Page,
      text: string,
      terminalIndexOrOptions: number | TypeInTerminalOptions = 0,
    ): Promise<void> {
      const terminalOptions =
        typeof terminalIndexOrOptions === 'number'
          ? { terminalIndex: terminalIndexOrOptions }
          : terminalIndexOrOptions;
      const terminalIndex = terminalOptions.terminalIndex ?? 0;

      await focusTerminal(page, terminalIndex);
      if (terminalOptions.requireInteractiveReady !== false) {
        await waitForTerminalInteractiveReady(page, terminalIndex);
      }
      await getTerminalInput(page, terminalIndex).pressSequentially(text, {
        delay: terminalOptions.typeDelayMs ?? DEFAULT_TERMINAL_TYPE_DELAY_MS,
      });
    }

    async function runInTerminal(
      page: Page,
      text: string,
      options: RunInTerminalOptions = {},
    ): Promise<void> {
      const terminalIndex = options.terminalIndex ?? 0;
      await focusTerminal(page, terminalIndex);
      await waitForTerminalInteractiveReady(page, terminalIndex);
      await getTerminalInput(page, terminalIndex).pressSequentially(text, {
        delay: options.typeDelayMs ?? DEFAULT_TERMINAL_TYPE_DELAY_MS,
      });
      if (options.pressEnter !== false) {
        await waitForTerminalKeyboardFocus(page, terminalIndex);
        await page.keyboard.press('Enter');
      }
    }

    async function createShellTerminal(page: Page): Promise<number> {
      const terminalStatusList = page.locator(TERMINAL_STATUS_SELECTOR);
      const terminalCount = await terminalStatusList.count();
      const createTerminalButton = page.getByRole('button', { name: 'New terminal' });
      await waitForShellTerminalCreation({
        clickCreateTerminal: async () => {
          await createTerminalButton.scrollIntoViewIfNeeded();
          await createTerminalButton.click();
        },
        waitForCreationSignal: async (timeoutMs) => {
          try {
            await expect
              .poll(() => terminalStatusList.count(), { timeout: timeoutMs })
              .toBeGreaterThan(terminalCount);
            return true;
          } catch {
            return false;
          }
        },
      });

      const createdTerminalIndex = terminalCount;
      const createdTerminalStatus = getTerminalStatusRoot(page, createdTerminalIndex);
      await createdTerminalStatus.waitFor({ state: 'attached' });
      await expect.poll(() => readTerminalStatusReady(createdTerminalStatus)).toBe(true);
      await expect
        .poll(() => readTerminalPaintReadyFromStatusRoot(createdTerminalStatus))
        .toBe(true);
      await page.waitForTimeout(TERMINAL_CREATE_DEBOUNCE_BUFFER_MS);

      return createdTerminalIndex;
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
        retainSessionAgentTaskCommandLease,
        retainSessionTaskCommandLease,
        runInTerminal,
        server,
        typeInTerminal,
        waitForTerminalLogicalReady,
        waitForTerminalInteractiveReady,
        waitForTerminalReady,
        waitForTerminalPaintReady,
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
            terminalSnapshots.push(await readTerminalSnapshots(page));
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
