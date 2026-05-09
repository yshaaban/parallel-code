import type { Page } from '@playwright/test';

import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

const taskDeletionLifecycleScenario = {
  ...createInteractiveNodeScenario(),
  name: 'task-deletion-lifecycle',
  taskGitIsolation: 'current-branch' as const,
  taskName: 'Deletion Lifecycle Fixture',
};

async function openReviewPanel(page: Page): Promise<void> {
  await page.getByTitle('Open review').click();
  await expect(page.getByTitle('Show changed files')).toBeVisible();
}

async function openPreviewManager(page: Page): Promise<void> {
  await page.getByTitle('Open preview and ports').click();
  await expect(page.getByLabel('Hide preview manager')).toBeVisible();
}

async function closeActiveTask(page: Page): Promise<void> {
  await page.getByTitle('Close task').click();
  await expect(page.getByRole('heading', { name: 'Close Task' })).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Close' }).click();
}

test.describe('browser-lab task deletion lifecycle', () => {
  test.use({
    scenario: taskDeletionLifecycleScenario,
  });

  test('removes a task cleanly while review and preview are open', async ({
    browser,
    browserLab,
  }) => {
    const session = await browserLab.openSession(browser, {
      displayName: 'Task Deletion Lifecycle',
    });
    const { context, page } = session;

    try {
      await browserLab.waitForTerminalReady(page);
      const taskPanel = page.locator(`[data-task-id="${browserLab.server.taskId}"]`);
      await expect(taskPanel).toBeVisible();

      await openReviewPanel(page);
      await openPreviewManager(page);
      await closeActiveTask(page);

      await expect(taskPanel).toHaveCount(0, { timeout: 8_000 });
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      await expect(page.getByText('Deletion Lifecycle Fixture')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
