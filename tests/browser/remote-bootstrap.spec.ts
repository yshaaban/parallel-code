import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

test.describe('browser-lab remote bootstrap', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('renders the remote shell from a tokenized link', async ({
    browser,
    browserLab,
    scenario,
  }) => {
    const seededSession = await browserLab.openSession(browser, {
      displayName: 'Remote Bootstrap Seeder',
    });
    await browserLab.waitForTerminalReady(seededSession.page);

    const remoteContext = await browser.newContext();
    const remotePage = await remoteContext.newPage();
    let sawRemoteWebSocket = false;

    remotePage.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname === '/ws') {
        sawRemoteWebSocket = true;
      }
    });

    await remotePage.goto(browserLab.getAuthedUrl('/remote'), {
      waitUntil: 'networkidle',
    });

    await expect(remotePage).toHaveURL(/\/remote\/$/u);
    await expect(remotePage.getByText(scenario.taskName)).toBeVisible();
    await expect(remotePage.getByText('Not authenticated')).toHaveCount(0);
    await expect.poll(() => sawRemoteWebSocket).toBe(true);

    await remoteContext.close();
    await seededSession.context.close();
  });
});
