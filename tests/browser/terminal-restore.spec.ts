import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

test.describe('browser-lab terminal restore', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('keeps the terminal interactive after reload with warm scrollback', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Restore Tester',
    });

    await browserLab.waitForTerminalReady(page);
    await browserLab.typeInTerminal(
      page,
      'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_LINE_${i}`)',
    );
    await page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'RESTORE_LINE_119');

    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    await browserLab.waitForTerminalReady(page);

    await browserLab.typeInTerminal(page, 'console.log("RESTORE_AFTER_RELOAD")');
    await page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'RESTORE_AFTER_RELOAD',
    );

    await expect(
      page.getByText(/Connecting to terminal…|Attaching terminal…|Restoring terminal output…/u),
    ).toHaveCount(0);
  });
});
