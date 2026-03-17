import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

test.describe('browser-lab terminal input', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('keeps burst typing intact through the real browser terminal input path', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Input Tester',
    });

    await browserLab.waitForTerminalReady(page);

    const marker = `BROWSER_INPUT_BURST_${'XYZ123'.repeat(12)}`;
    await browserLab.typeInTerminal(page, `console.log("${marker}")`);
    await page.keyboard.press('Enter');

    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);

    const followUpMarker = 'BROWSER_INPUT_FOLLOW_UP_MARKER';
    await browserLab.typeInTerminal(page, `console.log("${followUpMarker}")`);
    await page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, followUpMarker);

    await expect(
      page.getByText(/Connecting to terminal…|Attaching terminal…|Restoring terminal output…/u),
    ).toHaveCount(0);
  });
});
