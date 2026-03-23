import type { Page } from '@playwright/test';
import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

function getRemoteAgentCardName(taskName: string): RegExp {
  return new RegExp(`^Open ${taskName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
}

async function expectRemoteTerminalViewportToFillShell(remotePage: Page): Promise<void> {
  const metrics = await remotePage.evaluate(() => {
    const shell = document.querySelector('[data-testid="remote-terminal-shell"]');
    const viewport = document.querySelector('.xterm-viewport');
    if (!(shell instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      return null;
    }

    const shellRect = shell.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    return {
      bottomGap: shellRect.bottom - viewportRect.bottom,
      shellHeight: shellRect.height,
      viewportHeight: viewportRect.height,
    };
  });

  expect(metrics).not.toBeNull();
  if (metrics === null) {
    return;
  }

  expect(metrics.viewportHeight / metrics.shellHeight).toBeGreaterThan(0.7);
  expect(metrics.bottomGap).toBeLessThan(72);
}

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

    await remotePage
      .getByRole('button', { name: getRemoteAgentCardName(scenario.taskName) })
      .click();
    const detailHeader = remotePage.getByTestId('remote-agent-detail-header');
    const terminalShell = remotePage.getByTestId('remote-terminal-shell');
    const commandInput = remotePage.getByLabel('Type a command for this agent');
    await expect(detailHeader).toBeVisible();
    await expect(terminalShell).toBeVisible();
    await expect(commandInput).toBeVisible();

    const detailHeaderBox = await detailHeader.boundingBox();
    const terminalShellBox = await terminalShell.boundingBox();
    expect(detailHeaderBox?.height ?? 0).toBeLessThan(160);
    expect(terminalShellBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(220);
    await expectRemoteTerminalViewportToFillShell(remotePage);

    await remotePage.getByRole('button', { name: 'Increase terminal font size' }).click();
    await remotePage.waitForTimeout(150);
    await expectRemoteTerminalViewportToFillShell(remotePage);

    await remotePage.getByRole('button', { name: 'Decrease terminal font size' }).click();
    await remotePage.waitForTimeout(150);
    await expectRemoteTerminalViewportToFillShell(remotePage);

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

    await remotePage
      .getByRole('button', { name: getRemoteAgentCardName(scenario.taskName) })
      .click();
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

    await remotePage
      .getByRole('button', { name: getRemoteAgentCardName(scenario.taskName) })
      .click();
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
