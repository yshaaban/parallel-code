import { IPC } from '../../electron/ipc/channels.js';
import { expect, test } from './harness/fixtures.js';
import {
  createFooterRedrawScenario,
  createPromptReadyScenario,
  createStatuslineScenario,
  createWrapScenario,
} from './harness/scenarios.js';

test.describe('browser-lab prompt-ready fixture', () => {
  test.use({
    scenario: createPromptReadyScenario(320),
  });

  test('mounts the first terminal and completes the prompt-ready fixture', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Mount Tester',
    });

    const currentBranch = await browserLab.invokeIpc<string>(request, IPC.GetCurrentBranch, {
      projectRoot: browserLab.server.repoDir,
    });

    await expect(page.locator('.xterm')).toBeVisible();
    await expect(page.getByRole('button', { name: currentBranch }).first()).toBeVisible();
    await expect(page.getByText('Process exited (0)').first()).toBeVisible();
  });
});

test.describe('browser-lab wrap fixture', () => {
  test.use({
    scenario: createWrapScenario(2, 160),
  });

  test('runs the wrap fixture through a real browser session', async ({ browser, browserLab }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Wrap Smoke',
    });

    await page.locator('.xterm').waitFor({ state: 'visible' });
    await expect(page.getByText('Process exited (0)').first()).toBeVisible();
  });
});

test.describe('browser-lab statusline fixture', () => {
  test.use({
    scenario: createStatuslineScenario(48, 15),
  });

  test('runs the statusline fixture through a real browser session', async ({
    browser,
    browserLab,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Status Smoke',
    });

    await page.locator('.xterm').waitFor({ state: 'visible' });
    await expect(page.getByText('Process exited (0)').first()).toBeVisible();
  });
});

test.describe('browser-lab footer redraw fixture', () => {
  test.use({
    scenario: createFooterRedrawScenario('split', 48, 18, 1),
  });

  test('runs the redraw-heavy footer fixture through a real browser session', async ({
    browser,
    browserLab,
  }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
    });

    try {
      const page = await context.newPage();
      await page.goto(browserLab.getAuthedUrl('/'));
      await page.locator('.app-shell').waitFor({ state: 'visible' });
      await browserLab.beginTerminalStatusHistory(page);
      await page.locator('.xterm').waitFor({ state: 'visible' });
      await browserLab.waitForTerminalReady(page);
      await expect(page.getByText('Process exited (0)').first()).toBeVisible();

      const snapshot = await page.evaluate(() =>
        window.__parallelCodeTerminalOutputDiagnostics?.getSnapshot(),
      );
      const terminal = snapshot?.terminals.find((entry) => entry.control.redrawChunks > 0);

      expect(terminal).toBeTruthy();
      expect(terminal?.routed.queuedChunks ?? 0).toBeGreaterThan(0);
      expect(terminal?.writes.queuedCalls ?? 0).toBeGreaterThan(0);
      expect((terminal?.routed.queuedChunks ?? 0) > (terminal?.writes.queuedCalls ?? 0)).toBe(true);

      const terminalStatusHistory = await browserLab.readTerminalStatusHistory(page);
      expect(terminalStatusHistory).toContain('ready');
      expect(terminalStatusHistory).not.toContain('restoring');
    } finally {
      await context.close();
    }
  });
});
