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
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Mount Tester',
    });

    await expect(page.locator('.xterm')).toBeVisible();
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
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Footer Redraw Smoke',
    });

    await page.locator('.xterm').waitFor({ state: 'visible' });
    await expect(page.getByText('Process exited (0)').first()).toBeVisible();
  });
});
