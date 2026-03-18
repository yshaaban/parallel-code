import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario, createPromptReadyScenario } from './harness/scenarios.js';

async function waitForNewRunningAgentId(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  initialRunningAgentIds: readonly string[],
): Promise<string> {
  await expect
    .poll(
      async () => {
        const runningAgentIds = await browserLab.invokeIpc<string[]>(
          request,
          IPC.ListRunningAgentIds,
        );
        return runningAgentIds.find((agentId) => !initialRunningAgentIds.includes(agentId)) ?? null;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();

  const runningAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
  const agentId =
    runningAgentIds.find((currentAgentId) => !initialRunningAgentIds.includes(currentAgentId)) ??
    null;

  expect(agentId).toBeTruthy();
  return agentId ?? '';
}

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

test.describe('browser-lab shell repeat input', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps repeated same-key shell input responsive', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Repeat Input Tester',
    });

    await browserLab.waitForTerminalReady(page);
    const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
      request,
      IPC.ListRunningAgentIds,
    );
    const shellTerminalIndex = await browserLab.createShellTerminal(page);
    const shellAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
    );
    const repeatText = 'a'.repeat(80);

    await browserLab.runInTerminal(page, repeatText, {
      terminalIndex: shellTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, shellAgentId, repeatText, 5_000);
  });
});
