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

  test('syncs mobile ownership with desktop and supports takeover approval', async ({
    browser,
    browserLab,
    request,
    scenario,
  }) => {
    const desktopSession = await browserLab.openSession(browser, {
      clientId: 'desktop-observer',
      displayName: 'Desktop Observer',
    });
    await browserLab.waitForTerminalReady(desktopSession.page);

    const remoteContext = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 844, width: 390 },
    });
    await remoteContext.addInitScript(() => {
      window.localStorage.setItem('parallel-code-display-name', 'Mina phone');
      window.sessionStorage.setItem('parallel-code-remote-client-id', 'remote-mobile-client');
    });
    const remotePage = await remoteContext.newPage();

    await remotePage.goto(browserLab.getAuthedUrl('/remote'), {
      waitUntil: 'networkidle',
    });

    await remotePage.getByText(scenario.taskName).click();
    const commandInput = remotePage.getByLabel('Type a command for this agent');
    await expect(commandInput).toBeVisible();
    await commandInput.fill('console.log("REMOTE_OWNER_MARKER")');
    await remotePage.getByRole('button', { name: 'Send command' }).click();
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'REMOTE_OWNER_MARKER',
    );

    await expect(desktopSession.page.getByText('Mina phone typing').first()).toBeVisible();
    await desktopSession.page.getByRole('button', { name: /^Take Over$/u }).click();

    const takeoverDialog = remotePage.getByRole('dialog', { name: 'Allow mobile takeover' });
    await expect(takeoverDialog).toBeVisible();
    await expect(remotePage.getByText(/Desktop Observer wants to take control/u)).toBeVisible();
    await remotePage.getByRole('button', { name: 'Allow' }).click();

    await expect(desktopSession.page.getByText('You typing').first()).toBeVisible();
    await expect(remotePage.getByText('Desktop Observer typing').first()).toBeVisible();

    await remoteContext.close();
    await desktopSession.context.close();
  });

  test('recovers remote typing and ownership after a mobile reconnect', async ({
    browser,
    browserLab,
    request,
    scenario,
  }) => {
    const desktopSession = await browserLab.openSession(browser, {
      clientId: 'desktop-observer',
      displayName: 'Desktop Observer',
    });
    await browserLab.waitForTerminalReady(desktopSession.page);

    const remoteContext = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 844, width: 390 },
    });
    await remoteContext.addInitScript(() => {
      window.localStorage.setItem('parallel-code-display-name', 'Mina phone');
      window.sessionStorage.setItem('parallel-code-remote-client-id', 'remote-mobile-client');
    });
    const remotePage = await remoteContext.newPage();

    await remotePage.goto(browserLab.getAuthedUrl('/remote'), {
      waitUntil: 'networkidle',
    });

    await remotePage.getByText(scenario.taskName).click();
    const commandInput = remotePage.getByLabel('Type a command for this agent');
    await expect(commandInput).toBeVisible();

    await remoteContext.setOffline(true);
    await remotePage.waitForTimeout(250);
    await remoteContext.setOffline(false);
    await remotePage.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get() {
          return false;
        },
      });
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(remotePage.getByText('Connected', { exact: true })).toBeVisible();

    await commandInput.fill('console.log("REMOTE_RECONNECT_OK")');
    await remotePage.getByRole('button', { name: 'Send command' }).click();

    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'REMOTE_RECONNECT_OK',
    );
    await expect(desktopSession.page.getByText('Mina phone typing').first()).toBeVisible();

    await remoteContext.close();
    await desktopSession.context.close();
  });
});
