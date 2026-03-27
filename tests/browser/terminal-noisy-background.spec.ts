import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

const NOISY_OUTPUT_COMMAND =
  'i=0; while [ "$i" -lt 180 ]; do printf "\\rNOISE_%04d" "$i"; i=$((i+1)); sleep 0.02; done; printf "\\nNOISE_DONE\\n"';

async function waitForNewRunningAgentId(
  browserLab: {
    focusTerminal?: (
      page: import('@playwright/test').Page,
      terminalIndex?: number,
    ) => Promise<void>;
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  initialRunningAgentIds: readonly string[],
  excludedAgentId?: string | null,
): Promise<string> {
  await expect
    .poll(
      async () => {
        const runningAgentIds = await browserLab.invokeIpc<string[]>(
          request,
          IPC.ListRunningAgentIds,
        );
        return (
          runningAgentIds.find(
            (agentId) =>
              !initialRunningAgentIds.includes(agentId) && agentId !== (excludedAgentId ?? null),
          ) ?? null
        );
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();

  const runningAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
  const agentId =
    runningAgentIds.find(
      (currentAgentId) =>
        !initialRunningAgentIds.includes(currentAgentId) &&
        currentAgentId !== (excludedAgentId ?? null),
    ) ?? null;

  expect(agentId).toBeTruthy();
  return agentId ?? '';
}

test.describe('browser-lab noisy background terminals', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps focused foreground command round-trips responsive while a background terminal redraws', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Noise Tester',
    });

    await browserLab.waitForTerminalReady(page);
    const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
      request,
      IPC.ListRunningAgentIds,
    );
    const focusedTerminalIndex = await browserLab.createShellTerminal(page);
    const focusedShellAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
    );
    await browserLab.beginTerminalStatusHistory(page, focusedTerminalIndex);
    const backgroundTerminalIndex = await browserLab.createShellTerminal(page);
    const backgroundAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
      focusedShellAgentId,
    );

    await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
      terminalIndex: backgroundTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, backgroundAgentId, 'NOISE_');

    const focusReadyMarker = `FR${Date.now().toString(36).slice(-4)}`;
    await browserLab.focusTerminal(page, focusedTerminalIndex);
    await browserLab.runInTerminal(page, `echo ${focusReadyMarker}`, {
      terminalIndex: focusedTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, focusedShellAgentId, focusReadyMarker, 8_000);

    const latencyMarker = `FL${Date.now().toString(36).slice(-4)}`;
    const latencyStartedAt = Date.now();
    await browserLab.runInTerminal(page, `echo ${latencyMarker}`, {
      terminalIndex: focusedTerminalIndex,
    });
    await browserLab.waitForAgentScrollback(request, focusedShellAgentId, latencyMarker, 8_000);
    const latencyMs = Date.now() - latencyStartedAt;

    expect(latencyMs).toBeLessThan(2_000);
    await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);

    const terminalStatusHistory = await browserLab.readTerminalStatusHistory(
      page,
      focusedTerminalIndex,
    );
    expect(terminalStatusHistory).not.toContain('restoring');
  });
});
