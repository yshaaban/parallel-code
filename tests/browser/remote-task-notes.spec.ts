import { expect, test } from '@playwright/test';
import {
  installRemoteTaskExperienceMock,
  startRemoteStaticServer,
  type RemoteStaticServer,
} from './harness/remote-task-experience.js';

test.describe('remote task-first Notes', () => {
  let staticServer: RemoteStaticServer;

  test.beforeAll(async () => {
    staticServer = await startRemoteStaticServer();
  });

  test.afterAll(async () => {
    await staticServer.stop();
  });

  test('preserves a catalog shell while saving and resolving Notes on a 360px phone', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 360 });
    const remote = await installRemoteTaskExperienceMock(page);

    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page
      .getByRole('button', {
        name: 'Open Mobile shell task. Running. Terminal-only task.',
      })
      .click();
    await page.getByRole('button', { name: 'Open Terminal. Running.' }).click();

    const terminalShell = page.getByTestId('remote-terminal-shell');
    await expect(terminalShell.locator('.xterm-rows')).toContainText('CATALOG_SHELL_ATTACHED');
    await terminalShell.evaluate((element) => element.setAttribute('data-preserved', 'yes'));
    await expect.poll(() => remote.getSubscribeCount(page, 'shell-session-1')).toBe(1);

    await page.getByRole('tab', { name: 'Notes' }).click();
    const editor = page.getByRole('textbox', { name: 'Task notes' });
    await expect(editor).toHaveValue('base note');
    await editor.fill('saved from phone');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await editor.fill('local conflict draft');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Notes changed on another device')).toBeVisible();
    await page.getByRole('button', { name: 'Review latest' }).click();
    await expect(page.getByText('remote note')).toBeVisible();

    await page.getByRole('tab', { name: 'Terminal' }).click();
    await expect(terminalShell).toHaveAttribute('data-preserved', 'yes');
    await expect(terminalShell.locator('.xterm-rows')).toContainText('CATALOG_SHELL_');
    await expect.poll(() => remote.getSubscribeCount(page, 'shell-session-1')).toBe(1);

    await page.getByRole('tab', { name: 'Notes' }).click();
    await expect(editor).toHaveValue('local conflict draft');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await remote.closeSocket(page);
    await expect(page.getByText('Not authenticated')).toBeVisible();
  });

  test('guards a dirty task-detail draft and remains usable at 320px', async ({ page }) => {
    await page.setViewportSize({ height: 720, width: 320 });
    await installRemoteTaskExperienceMock(page);

    await page.goto(`${staticServer.url}/remote?token=browser-test`, {
      waitUntil: 'networkidle',
    });
    await page
      .getByRole('button', {
        name: 'Open Mobile shell task. Running. Terminal-only task.',
      })
      .click();
    await page.getByRole('tab', { name: 'Notes' }).click();
    const editor = page.getByRole('textbox', { name: 'Task notes' });
    await expect(editor).toHaveValue('base note');
    await editor.fill('keep this draft');

    await page.evaluate(() => {
      window.confirm = () => false;
    });
    const backButton = page.getByRole('button', { name: 'Back to tasks' });
    await backButton.click();
    await expect(page.getByRole('heading', { name: 'Mobile shell task' })).toBeVisible();
    await expect(editor).toHaveValue('keep this draft');
    await expect(backButton).toBeEnabled();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await backButton.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  });
});
