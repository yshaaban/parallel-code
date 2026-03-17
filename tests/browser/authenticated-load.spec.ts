import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

test.use({
  scenario: createPromptReadyScenario(260),
});

test('requires browser auth and bootstraps into the standalone app shell', async ({
  browser,
  browserLab,
}) => {
  const page = await browser.newPage();

  await page.goto(browserLab.server.baseUrl);
  await expect(page.getByRole('heading', { name: 'Parallel Code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();

  await browserLab.gotoApp(page);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByText('Prompt Ready Fixture').first()).toBeVisible();
});
