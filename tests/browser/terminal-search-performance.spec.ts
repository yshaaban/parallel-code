import type { BrowserContext, Page, Request } from '@playwright/test';

import { IPC } from '../../electron/ipc/channels.js';
import { TERMINAL_SEARCH_QUERY_LIMIT } from '../../src/lib/terminal-search.js';
import { expect, test } from './harness/fixtures.js';
import {
  getBrowserPrimaryFindChord,
  getBrowserPrimaryModifier,
} from './harness/browser-platform.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

const FIXTURE_LINE_COUNT = 5_000;
const FIXTURE_MIN_BYTES = 500 * 1024;
const SAMPLE_COUNT = 100;
const INCREMENTAL_SEARCH_P95_BUDGET_MS = 50;
const NAVIGATION_P95_BUDGET_MS = 16;
const IDLE_LONG_TASK_BUDGET_MS = 50;
const CLEANUP_HEAP_GROWTH_BUDGET_BYTES = 8 * 1024 * 1024;

interface SearchLatencySamples {
  navigationMs: number[];
  searchMs: number[];
}

function createTerminalFleetScenario(terminalCount: number) {
  const scenario = createInteractiveNodeScenario();
  return {
    ...scenario,
    additionalTaskNames: Array.from(
      { length: terminalCount - 1 },
      (_, index) => `Terminal Search Idle Fixture ${index + 2}`,
    ),
    name: `${scenario.name}-terminal-search-idle-${terminalCount}`,
  };
}

function isTerminalSearchAddonRequest(request: Request): boolean {
  return request.url().includes('addon-search');
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

async function measureIdleLongTasks(page: Page, durationMs = 250): Promise<number[]> {
  return page.evaluate(async (measurementDurationMs) => {
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      return [];
    }

    const durations: number[] = [];
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        durations.push(entry.duration);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
    await new Promise<void>((resolve) => window.setTimeout(resolve, measurementDurationMs));
    observer.disconnect();
    return durations;
  }, durationMs);
}

async function measureSearchLatency(page: Page, queries: readonly string[]): Promise<number[]> {
  return page.evaluate(
    async (nextQueries) => {
      const input = document.querySelector<HTMLInputElement>('.terminal-search-input');
      const status = document.querySelector<HTMLElement>('.terminal-search-status');
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!input || !status || !valueSetter) {
        throw new Error('Terminal search controls are unavailable');
      }

      async function measureQuery(query: string): Promise<number> {
        return new Promise<number>((resolve, reject) => {
          let sawStatusMutation = false;
          const startedAtMs = performance.now();
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(
              new Error(`Timed out waiting for terminal search result (${query.length} chars)`),
            );
          }, 2_000);
          const inspect = (): void => {
            const label = status.textContent ?? '';
            if (label === 'Searching…') {
              return;
            }
            if (!sawStatusMutation || label.length === 0) {
              return;
            }

            window.clearTimeout(timeout);
            observer.disconnect();
            resolve(performance.now() - startedAtMs);
          };
          const observer = new MutationObserver(() => {
            sawStatusMutation = true;
            inspect();
          });
          observer.observe(status, { characterData: true, childList: true, subtree: true });
          valueSetter.call(input, query);
          input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
          inspect();
        });
      }

      const samples: number[] = [];
      for (const query of nextQueries) {
        samples.push(await measureQuery(query));
      }
      return samples;
    },
    [...queries],
  );
}

async function measureNavigationLatency(page: Page, count: number): Promise<number[]> {
  return page.evaluate(async (sampleCount) => {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Next terminal match"]',
    );
    const status = document.querySelector<HTMLElement>('.terminal-search-status');
    if (!button || !status) {
      throw new Error('Terminal search navigation controls are unavailable');
    }

    async function measureNext(): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const previousLabel = status.textContent ?? '';
        const startedAtMs = performance.now();
        const timeout = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error('Timed out waiting for terminal search navigation'));
        }, 2_000);
        const inspect = (): void => {
          if ((status.textContent ?? '') === previousLabel) {
            return;
          }
          window.clearTimeout(timeout);
          observer.disconnect();
          resolve(performance.now() - startedAtMs);
        };
        const observer = new MutationObserver(inspect);
        observer.observe(status, { characterData: true, childList: true, subtree: true });
        button.click();
        inspect();
      });
    }

    const samples: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      samples.push(await measureNext());
    }
    return samples;
  }, count);
}

async function runSearchCleanupCycles(page: Page, count: number): Promise<void> {
  const primaryModifier = await getBrowserPrimaryModifier(page);
  await page.evaluate(
    async ({ cycleCount, primaryModifier: browserPrimaryModifier }) => {
      const terminalInput = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Terminal input"]',
      );
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!terminalInput || !valueSetter) {
        throw new Error('Terminal input is unavailable for cleanup cycles');
      }

      async function waitFor(predicate: () => boolean, label: string): Promise<void> {
        const startedAtMs = performance.now();
        while (!predicate()) {
          if (performance.now() - startedAtMs > 2_000) {
            throw new Error(`Timed out waiting for ${label}`);
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }

      const primaryModifier =
        browserPrimaryModifier === 'Meta' ? { metaKey: true } : { ctrlKey: true };
      for (let index = 0; index < cycleCount; index += 1) {
        terminalInput.focus();
        terminalInput.dispatchEvent(
          new KeyboardEvent('keydown', {
            ...primaryModifier,
            bubbles: true,
            cancelable: true,
            key: 'f',
          }),
        );
        await waitFor(
          () => document.querySelector('[data-terminal-search-overlay="true"]') !== null,
          `search overlay in cycle ${index + 1}`,
        );

        const input = document.querySelector<HTMLInputElement>('.terminal-search-input');
        const status = document.querySelector<HTMLElement>('.terminal-search-status');
        if (!input || !status) {
          throw new Error(`Search controls disappeared in cleanup cycle ${index + 1}`);
        }
        valueSetter.call(input, 'CYCLE_NEEDLE');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
        await waitFor(
          () => {
            const label = status.textContent ?? '';
            return label.length > 0 && label !== 'Searching…';
          },
          `search result in cycle ${index + 1}`,
        );
        input.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
        );
        await waitFor(
          () => document.querySelector('[data-terminal-search-overlay="true"]') === null,
          `search cleanup in cycle ${index + 1}`,
        );
        if (document.querySelector('.xterm-find-result-decoration')) {
          throw new Error(`A search decoration survived cleanup cycle ${index + 1}`);
        }
      }
    },
    { cycleCount: count, primaryModifier },
  );
}

for (const terminalCount of [1, 8, 24]) {
  test.describe(`terminal search idle cost / ${terminalCount} terminals`, () => {
    test.use({ scenario: createTerminalFleetScenario(terminalCount) });

    test('does not fetch or create visible search work before first use', async ({
      browser,
      browserLab,
    }) => {
      test.setTimeout(120_000);
      const addonRequests: string[] = [];
      const { context, page } = await browserLab.openSession(browser, {
        displayName: `Terminal Search Idle ${terminalCount}`,
        prepareContext: (browserContext: BrowserContext) => {
          browserContext.on('request', (request) => {
            if (isTerminalSearchAddonRequest(request)) {
              addonRequests.push(request.url());
            }
          });
        },
      });

      try {
        await browserLab.waitForTerminalReady(
          page,
          0,
          terminalCount === 24 ? { timeoutMs: 30_000 } : {},
        );
        await expect(page.locator('[data-terminal-status]')).toHaveCount(terminalCount, {
          timeout: 30_000,
        });
        const longTasks = await measureIdleLongTasks(page);

        expect(addonRequests).toHaveLength(0);
        await expect(page.getByRole('search')).toHaveCount(0);
        await expect(page.locator('.xterm-find-result-decoration')).toHaveCount(0);
        expect(Math.max(0, ...longTasks)).toBeLessThanOrEqual(IDLE_LONG_TASK_BUDGET_MS);
      } finally {
        await context.close();
      }
    });
  });
}

test.describe('terminal search measured cost', () => {
  test.use({ scenario: createInteractiveNodeScenario() });

  test('meets search, navigation, lazy-load, caps, and cleanup budgets', async ({
    browser,
    browserLab,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    const addonRequests: string[] = [];
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'Terminal Search Performance',
      viewportSize: { height: 1_000, width: 3_400 },
      prepareContext: (browserContext: BrowserContext) => {
        browserContext.on('request', (resourceRequest) => {
          if (isTerminalSearchAddonRequest(resourceRequest)) {
            addonRequests.push(resourceRequest.url());
          }
        });
      },
    });

    try {
      await browserLab.waitForTerminalReady(page);
      const unopenedLongTasks = await measureIdleLongTasks(page);
      expect(Math.max(0, ...unopenedLongTasks)).toBeLessThanOrEqual(IDLE_LONG_TASK_BUDGET_MS);
      expect(addonRequests).toHaveLength(0);

      const fixtureCommand =
        `for(let i=0;i<${FIXTURE_LINE_COUNT};i++){` +
        'const t="SEARCH_PERF_"+String(i%100).padStart(2,"0");' +
        'const b=t+":"+"abcdefghijklmnopqrstuvwxyz".repeat(7);' +
        'console.log(i%3===1?"\\x1b[36m"+b+"\\x1b[0m":i%3===2?b+"界".repeat(12):b)' +
        '};console.log("SEARCH_"+"FIXTURE_DONE")';
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        browserLab.server.agentId,
        'seed terminal search performance output',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: browserLab.server.agentId,
        data: `${fixtureCommand}\r`,
      });
      await browserLab.waitForAgentScrollback(
        request,
        browserLab.server.agentId,
        'SEARCH_FIXTURE_DONE',
        30_000,
      );
      const agentTerminal = page.locator('[data-terminal-status]').first();
      await expect(agentTerminal.locator('.xterm-rows')).toContainText('SEARCH_FIXTURE_DONE', {
        timeout: 30_000,
      });
      const encodedScrollback = await browserLab.invokeIpc<string | null>(
        request,
        IPC.GetAgentScrollback,
        { agentId: browserLab.server.agentId },
      );
      const scrollback = Buffer.from(encodedScrollback ?? '', 'base64').toString('utf8');
      expect(Buffer.byteLength(scrollback)).toBeGreaterThanOrEqual(FIXTURE_MIN_BYTES);
      expect(scrollback.match(/SEARCH_PERF_/gu)?.length ?? 0).toBeGreaterThanOrEqual(
        FIXTURE_LINE_COUNT,
      );

      await browserLab.focusTerminal(page);
      await page.keyboard.press(await getBrowserPrimaryFindChord(page));
      const search = page.getByRole('search');
      const input = search.getByLabel('Find in terminal');
      const status = search.getByRole('status');
      await expect(search).toBeVisible();
      expect(addonRequests).toHaveLength(0);

      await input.fill('SEARCH_PERF_00');
      await expect(status).toHaveText(/^\d+\/\d+$/u);
      expect(addonRequests).toHaveLength(1);

      const queries = Array.from(
        { length: SAMPLE_COUNT },
        (_, index) => `SEARCH_PERF_${String((index + 1) % SAMPLE_COUNT).padStart(2, '0')}`,
      );
      const searchMs = await measureSearchLatency(page, queries);
      const navigationMs = await measureNavigationLatency(page, SAMPLE_COUNT);
      const samples = { navigationMs, searchMs } satisfies SearchLatencySamples;
      const searchP95Ms = percentile(searchMs, 0.95);
      const navigationP95Ms = percentile(navigationMs, 0.95);

      await testInfo.attach('terminal-search-latency-samples.json', {
        body: JSON.stringify(
          {
            budgetsMs: {
              incrementalP95: INCREMENTAL_SEARCH_P95_BUDGET_MS,
              navigationP95: NAVIGATION_P95_BUDGET_MS,
            },
            fixture: {
              bytes: Buffer.byteLength(scrollback),
              lines: FIXTURE_LINE_COUNT,
              modes: ['plain', 'ansi', 'wide'],
            },
            p95Ms: { navigation: navigationP95Ms, search: searchP95Ms },
            samples,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      process.stdout.write(
        `terminal-search-performance samples=${SAMPLE_COUNT} fixtureBytes=${Buffer.byteLength(
          scrollback,
        )} searchP95=${searchP95Ms.toFixed(3)}ms navigationP95=${navigationP95Ms.toFixed(3)}ms\n`,
      );
      expect(searchMs).toHaveLength(SAMPLE_COUNT);
      expect(navigationMs).toHaveLength(SAMPLE_COUNT);
      expect(searchP95Ms).toBeLessThanOrEqual(INCREMENTAL_SEARCH_P95_BUDGET_MS);
      expect(navigationP95Ms).toBeLessThanOrEqual(NAVIGATION_P95_BUDGET_MS);

      await input.press('Escape');
      await expect(search).toHaveCount(0);
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: browserLab.server.agentId,
        data: 'for(let i=0;i<1100;i++) console.log("CAP_"+"NEEDLE "+i);console.log("CAP_"+"FIXTURE_DONE");console.log("CYCLE_"+"NEEDLE")\r',
      });
      await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'CYCLE_NEEDLE');

      await browserLab.focusTerminal(page);
      await page.keyboard.press(await getBrowserPrimaryFindChord(page));
      await expect(search).toBeVisible();
      await input.fill('CYCLE_NEEDLE');
      await expect(status).toHaveText('1/1');
      await input.fill('CAP_NEEDLE');
      await expect(status).toHaveText('1,000 matches (display limit)');
      await input.fill('x'.repeat(TERMINAL_SEARCH_QUERY_LIMIT + 904));
      await expect(input).toHaveValue('x'.repeat(TERMINAL_SEARCH_QUERY_LIMIT));
      await input.press('Escape');

      const cdp = await context.newCDPSession(page);
      await cdp.send('HeapProfiler.collectGarbage');
      const heapBefore = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
      await runSearchCleanupCycles(page, SAMPLE_COUNT);
      await cdp.send('HeapProfiler.collectGarbage');
      const heapAfter = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };

      expect(addonRequests).toHaveLength(1);
      await expect(page.getByRole('search')).toHaveCount(0);
      await expect(page.locator('.xterm-find-result-decoration')).toHaveCount(0);
      expect(heapAfter.usedSize - heapBefore.usedSize).toBeLessThanOrEqual(
        CLEANUP_HEAP_GROWTH_BUDGET_BYTES,
      );
    } finally {
      await context.close();
    }
  });
});
