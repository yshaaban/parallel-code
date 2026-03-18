import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

test.describe('browser-lab remote mobile session flow', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('prompts for a session name, surfaces it on desktop, and releases input focus after send', async ({
    browser,
    browserLab,
    scenario,
  }) => {
    const desktopSession = await browserLab.openSession(browser, {
      displayName: 'Desktop Seeder',
    });
    await browserLab.waitForTerminalReady(desktopSession.page);

    const remoteContext = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 844, width: 390 },
    });
    const remotePage = await remoteContext.newPage();

    await remotePage.goto(browserLab.getAuthedUrl('/remote'), {
      waitUntil: 'networkidle',
    });

    const sessionDialog = remotePage.getByRole('dialog', { name: 'Name this mobile session' });
    await expect(sessionDialog).toBeVisible();
    await sessionDialog.getByRole('textbox', { name: 'Session name' }).fill('Mina phone');
    await remotePage.getByRole('button', { name: 'Continue' }).click();

    await expect(sessionDialog).toBeHidden();
    await expect(remotePage.getByText('Mina phone')).toBeVisible();
    await expect(desktopSession.page.getByText('Mina phone')).toBeVisible();

    await remotePage.getByText(scenario.taskName).click();
    const commandInput = remotePage.getByLabel('Type a command for this agent');
    await expect(commandInput).toBeVisible();
    await commandInput.fill('console.log("REMOTE_MOBILE_OK")');
    await expect(commandInput).toBeFocused();

    await remotePage.getByRole('button', { name: 'Send command' }).click();

    await expect(commandInput).toHaveValue('');
    await expect(commandInput).not.toBeFocused();

    await remoteContext.close();
    await desktopSession.context.close();
  });
});
