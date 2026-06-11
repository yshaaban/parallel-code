import { IPC } from '../../electron/ipc/channels.js';

import {
  expect,
  getTerminalLoadingOverlay,
  test,
  waitForAppShellVisible,
} from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let searchIndex = 0;
  for (;;) {
    const foundIndex = haystack.indexOf(needle, searchIndex);
    if (foundIndex === -1) {
      return count;
    }

    count += 1;
    searchIndex = foundIndex + needle.length;
  }
}

test.describe('pre-ready terminal input', () => {
  test.use({
    scenario: createInteractiveNodeScenario(),
  });

  test('keystrokes typed from app-shell-visible reach the backend exactly once', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Preready Input Tester',
    });
    await browserLab.waitForTerminalReady(page);
    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      browserLab.server.agentId,
      'write preready input fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: browserLab.server.agentId,
      data: 'for (let i = 0; i < 80; i += 1) console.log(`PREREADY_WARMUP_${i}`)\n',
    });
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'PREREADY_WARMUP_79',
    );

    const marker = 'PREREADY_TYPED_MARKER';

    await page.reload();
    await waitForAppShellVisible(page);

    // Type the moment the shell is interactive for the user, while the
    // selected terminal is still loading whenever the reload is slow enough
    // to expose that window. Delivery must not depend on the session object
    // existing yet.
    const overlayVisibleWhenTypingStarted = await getTerminalLoadingOverlay(page)
      .isVisible()
      .catch(() => false);
    // A call expression: the REPL's eager-eval preview never executes it, so
    // the full marker reaches scrollback only when the typed line runs.
    await page.keyboard.type('console.log("PREREADY_TYPED_" + "MARKER")', { delay: 15 });
    await page.keyboard.press('Enter');

    await browserLab.waitForTerminalReady(page);
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker, 20_000);

    const scrollbackBase64 = await browserLab.invokeIpc<string>(request, IPC.GetAgentScrollback, {
      agentId: browserLab.server.agentId,
    });
    const scrollback = Buffer.from(scrollbackBase64, 'base64').toString('utf8');
    // The typed expression is split so only the evaluated REPL result carries
    // the full marker: exactly-once proves no drop and no double delivery.
    expect(countOccurrences(scrollback, marker)).toBe(1);

    // Diagnostic context only: the loading-overlay window shrinks as attach
    // gets faster, so its visibility is recorded but not asserted.
    test.info().annotations.push({
      description: String(overlayVisibleWhenTypingStarted),
      type: 'overlay-visible-when-typing-started',
    });
  });
});
