import type { BrowserContext, Page, Request } from '@playwright/test';

import { IPC } from '../../electron/ipc/channels.js';
import { expect, test } from './harness/fixtures.js';
import { getBrowserPrimaryFindChord } from './harness/browser-platform.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

const SEARCH_PREFIX = 'SEARCH_NEEDLE_';
const SEARCH_LAST_MARKER = `${SEARCH_PREFIX}0119`;

function isTerminalSearchAddonRequest(request: Request): boolean {
  return request.url().includes('addon-search');
}

async function disableWebgl(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContextWithoutWebgl(
      contextId: string,
      ...args: unknown[]
    ): RenderingContext | null {
      if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
        return null;
      }
      return originalGetContext.call(this, contextId, ...args);
    };
  });
}

async function readScrollback(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  agentId: string,
): Promise<string | null> {
  return browserLab.invokeIpc<string | null>(request, IPC.GetAgentScrollback, { agentId });
}

async function openTerminalSearch(page: Page): Promise<void> {
  await page.keyboard.press(await getBrowserPrimaryFindChord(page));
  await expect(page.getByRole('search')).toBeVisible();
  await expect(page.getByLabel('Find in terminal')).toBeFocused();
}

test.describe('browser-lab terminal search', () => {
  test.use({
    scenario: {
      ...createInteractiveNodeScenario(),
      additionalTaskNames: ['Terminal Search Remount Fixture'],
    },
  });

  test('searches real xterm output locally, navigates, and resets on remount', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(120_000);
    const addonRequests: string[] = [];
    const leaseRequests: string[] = [];
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'Terminal Search Tester',
      prepareContext: async (browserContext) => {
        browserContext.on('request', (resourceRequest) => {
          if (isTerminalSearchAddonRequest(resourceRequest)) {
            addonRequests.push(resourceRequest.url());
          }
          if (resourceRequest.url().includes(IPC.AcquireTaskCommandLease)) {
            leaseRequests.push(resourceRequest.url());
          }
        });
        await disableWebgl(browserContext);
      },
    });

    try {
      await browserLab.waitForTerminalReady(page);
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        browserLab.server.agentId,
        'seed terminal search output',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: browserLab.server.agentId,
        data: `for(let i=0;i<120;i++) console.log("${SEARCH_PREFIX}"+String(i).padStart(4,"0"))\r`,
      });
      await browserLab.waitForAgentScrollback(
        request,
        browserLab.server.agentId,
        SEARCH_LAST_MARKER,
      );
      const scrollbackBeforeSearch = await readScrollback(
        browserLab,
        request,
        browserLab.server.agentId,
      );
      expect(scrollbackBeforeSearch).toBeTruthy();
      leaseRequests.length = 0;

      await browserLab.focusTerminal(page);
      await openTerminalSearch(page);
      expect(addonRequests).toHaveLength(0);
      expect(leaseRequests).toHaveLength(0);

      const search = page.getByRole('search');
      const input = search.getByLabel('Find in terminal');
      const status = search.getByRole('status');
      const agentTerminal = page.locator('[data-terminal-status]').first();
      await input.fill(`${SEARCH_PREFIX}0000`);
      await expect(status).toHaveText('1/1');
      await expect(agentTerminal.locator('.xterm-rows')).toContainText(`${SEARCH_PREFIX}0000`);
      await expect(page.locator('.xterm-find-result-decoration').first()).toBeVisible();
      expect(addonRequests).toHaveLength(1);

      await input.fill(SEARCH_PREFIX);
      await expect(status).toHaveText(/^\d+\/\d+$/u);
      const firstResult = (await status.textContent()) ?? '';
      await input.press('Enter');
      await expect(status).not.toHaveText(firstResult);
      const nextResult = (await status.textContent()) ?? '';
      await input.press('Shift+Enter');
      await expect(status).not.toHaveText(nextResult);
      await expect(status).toHaveText(firstResult);

      expect(await readScrollback(browserLab, request, browserLab.server.agentId)).toBe(
        scrollbackBeforeSearch,
      );
      expect(leaseRequests).toHaveLength(0);
      expect(addonRequests).toHaveLength(1);

      await input.press('Escape');
      await expect(search).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Terminal input' }).first()).toBeFocused();
      await expect(page.locator('.xterm-find-result-decoration')).toHaveCount(0);

      await browserLab.focusTerminal(page);
      await openTerminalSearch(page);
      await input.fill(SEARCH_PREFIX);
      await expect(status).toHaveText(/^1\/\d+$/u);
      await page.reload();
      await browserLab.waitForTerminalReady(page);
      await expect(page.getByRole('search')).toHaveCount(0);
      await expect(page.locator('.xterm-find-result-decoration')).toHaveCount(0);

      const secondTaskId = browserLab.server.taskIds[1];
      expect(secondTaskId).toBeTruthy();
      await page.locator(`[data-sidebar-task-id="${secondTaskId}"]`).click();
      await expect(page.locator(`[data-task-id="${secondTaskId}"]`)).toBeVisible();
      await page.keyboard.press(await getBrowserPrimaryFindChord(page));
      await expect(page.getByRole('search')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('keeps peer-controlled terminals searchable without making them writable', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(120_000);
    const ownerSession = await browserLab.openSession(browser, {
      clientId: 'terminal-search-owner',
      displayName: 'Ivan',
    });
    const observerSession = await browserLab.openSession(browser, {
      clientId: 'terminal-search-observer',
      displayName: 'Sara',
    });

    try {
      await browserLab.waitForTerminalReady(ownerSession.page);
      await browserLab.waitForTerminalReady(observerSession.page);
      await browserLab.invokeSessionIpc(request, ownerSession.page, IPC.AcquireTaskCommandLease, {
        action: 'type in the terminal',
        clientId: 'terminal-search-owner',
        ownerId: 'terminal-search-owner-runtime',
        taskId: browserLab.server.taskId,
      });
      await browserLab.invokeSessionIpc(request, ownerSession.page, IPC.WriteToAgent, {
        agentId: browserLab.server.agentId,
        data: `console.log("${SEARCH_PREFIX}READ_ONLY")\r`,
      });
      await browserLab.waitForAgentScrollback(
        request,
        browserLab.server.agentId,
        `${SEARCH_PREFIX}READ_ONLY`,
      );
      await expect(observerSession.page.getByText('Ivan typing').first()).toBeVisible();
      const scrollbackBeforeSearch = await readScrollback(
        browserLab,
        request,
        browserLab.server.agentId,
      );

      await browserLab.focusTerminal(observerSession.page);
      await openTerminalSearch(observerSession.page);
      const search = observerSession.page.getByRole('search');
      await search.getByLabel('Find in terminal').fill(`${SEARCH_PREFIX}READ_ONLY`);
      await expect(search.getByRole('status')).toHaveText(/^(?:1\/\d+|\d+ matches?)$/u);
      await expect(observerSession.page.getByText('Ivan typing').first()).toBeVisible();
      await expect(
        observerSession.page.getByRole('button', { name: 'Take Over', exact: true }),
      ).toBeVisible();
      expect(await readScrollback(browserLab, request, browserLab.server.agentId)).toBe(
        scrollbackBeforeSearch,
      );

      await search.getByLabel('Find in terminal').press('Escape');
      await expect(search).toHaveCount(0);
      await expect(observerSession.page.getByText('Ivan typing').first()).toBeVisible();
    } finally {
      await Promise.all([ownerSession.context.close(), observerSession.context.close()]);
    }
  });
});
