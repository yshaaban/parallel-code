import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

interface RuntimeDiagnosticsSnapshot {
  terminalRecovery: {
    cursorDeltaResponses: number;
    deltaResponses: number;
    lastDurationMs: number | null;
    maxDurationMs: number;
    noopResponses: number;
    requests: number;
    returnedBytes: number;
    snapshotResponses: number;
    tailDeltaResponses: number;
  };
}

async function waitForNewRunningAgentId(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  initialRunningAgentIds: readonly string[],
  excludedAgentIds: readonly string[] = [],
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
              !initialRunningAgentIds.includes(agentId) && !excludedAgentIds.includes(agentId),
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
        !excludedAgentIds.includes(currentAgentId),
    ) ?? null;

  expect(agentId).toBeTruthy();
  return agentId ?? '';
}

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

  test('flushes input typed while reload restore is still completing', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Reload Restore Input Tester',
    });

    await browserLab.waitForTerminalReady(page);
    await browserLab.typeInTerminal(
      page,
      'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_RACE_LINE_${i}`)',
    );
    await page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'RESTORE_RACE_LINE_119',
    );

    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    const terminalInput = page.locator('textarea[aria-label="Terminal input"]').first();
    await terminalInput.waitFor({ state: 'attached' });
    await terminalInput.focus();

    const marker = 'RESTORE_TYPED_DURING_RECOVERY';
    await page.keyboard.type(`console.log("${marker}")`);
    await page.keyboard.press('Enter');

    await browserLab.waitForTerminalReady(page);
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);
  });
});

test.describe('browser-lab large scrollback restore', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps a large-history shell interactive after reload', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Large Scrollback Restore Tester',
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

    await browserLab.runInTerminal(
      page,
      'yes 12345678901234567890 | head -n 150000; printf "__BIG_SCROLLBACK_DONE__\\n"',
      {
        terminalIndex: shellTerminalIndex,
      },
    );
    await browserLab.waitForAgentScrollback(
      request,
      shellAgentId,
      '__BIG_SCROLLBACK_DONE__',
      20_000,
    );

    for (const cycle of [1, 2, 3]) {
      await page.reload();
      await page.locator('.app-shell').waitFor({ state: 'visible' });
      await browserLab.waitForTerminalReady(page, shellTerminalIndex);
      await browserLab.focusTerminal(page, shellTerminalIndex);

      const marker = `__AFTER_BIG_SCROLLBACK_RELOAD_${cycle}__`;
      await page.keyboard.type(`printf "${marker}\\n"`);
      await page.keyboard.press('Enter');
      await browserLab.waitForAgentScrollback(request, shellAgentId, marker, 10_000);

      await expect
        .poll(
          async () => {
            const supervision = await browserLab.invokeIpc<
              Array<{ agentId: string; state: string }>
            >(request, IPC.GetAgentSupervision);
            return supervision.find((entry) => entry.agentId === shellAgentId)?.state ?? null;
          },
          { timeout: 5_000 },
        )
        .not.toBe('flow-controlled');
    }

    await expect(
      page.getByText(/Connecting to terminal…|Attaching terminal…|Restoring terminal output…/u),
    ).toHaveCount(0);
  });

  test('does not steal focus from the restored shell while later shell terminals finish loading', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Reload Focus Stability Tester',
    });

    await browserLab.waitForTerminalReady(page);
    const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
      request,
      IPC.ListRunningAgentIds,
    );
    const focusedShellIndex = await browserLab.createShellTerminal(page);
    const focusedShellAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
    );
    await browserLab.createShellTerminal(page);
    const secondShellAgentId = await waitForNewRunningAgentId(
      browserLab,
      request,
      initialRunningAgentIds,
      [focusedShellAgentId],
    );
    const backgroundShellIndex = await browserLab.createShellTerminal(page);
    await waitForNewRunningAgentId(browserLab, request, initialRunningAgentIds, [
      focusedShellAgentId,
      secondShellAgentId,
    ]);

    await browserLab.focusTerminal(page, focusedShellIndex);
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    await browserLab.waitForTerminalReady(page, focusedShellIndex);
    await browserLab.focusTerminal(page, focusedShellIndex);
    await browserLab.waitForTerminalReady(page, backgroundShellIndex);

    const marker = '__RELOAD_FOCUS_STABLE__';
    await page.keyboard.type(`printf "${marker}\\n"`);
    await page.keyboard.press('Enter');
    await browserLab.waitForAgentScrollback(request, focusedShellAgentId, marker, 10_000);

    await expect
      .poll(
        async () => {
          const activeIndex = await page.evaluate((selector) => {
            const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>(selector));
            return inputs.findIndex((element) => element === document.activeElement);
          }, 'textarea[aria-label="Terminal input"]');
          return activeIndex;
        },
        { timeout: 5_000 },
      )
      .toBe(focusedShellIndex);
  });

  test('keeps a large-history shell responsive across background tab switches', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'Large Scrollback Switch Tester',
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

    await browserLab.runInTerminal(
      page,
      'yes 12345678901234567890 | head -n 150000; printf "__BIG_SWITCH_READY__\\n"',
      {
        terminalIndex: shellTerminalIndex,
      },
    );
    await browserLab.waitForAgentScrollback(request, shellAgentId, '__BIG_SWITCH_READY__', 20_000);

    const standbyPage = await context.newPage();
    await standbyPage.goto('about:blank');
    await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
    await browserLab.beginTerminalStatusHistory(page, shellTerminalIndex);

    for (const cycle of [1, 2, 3, 4, 5]) {
      await standbyPage.bringToFront();

      const backgroundDoneMarker = `__BACKGROUND_SWITCH_DONE_${cycle}__`;
      await browserLab.invokeIpc(request, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `yes "SWITCH_${cycle}" | head -n 20000; printf "${backgroundDoneMarker}\\n"\n`,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, backgroundDoneMarker, 20_000);

      await page.bringToFront();
      await browserLab.focusTerminal(page, shellTerminalIndex);

      const foregroundMarker = `__AFTER_BACKGROUND_SWITCH_${cycle}__`;
      await page.keyboard.type(`printf "${foregroundMarker}\\n"`);
      await page.keyboard.press('Enter');
      await browserLab.waitForAgentScrollback(request, shellAgentId, foregroundMarker, 5_000);
      await expect(
        page.getByText(/Connecting to terminal…|Attaching terminal…|Restoring terminal output…/u),
      ).toHaveCount(0);
    }

    const diagnostics = await browserLab.invokeIpc<RuntimeDiagnosticsSnapshot>(
      request,
      IPC.GetBackendRuntimeDiagnostics,
    );
    const terminalStatusHistory = await browserLab.readTerminalStatusHistory(
      page,
      shellTerminalIndex,
    );
    expect(diagnostics.terminalRecovery.snapshotResponses).toBe(0);
    if (diagnostics.terminalRecovery.deltaResponses > 0) {
      expect(diagnostics.terminalRecovery.cursorDeltaResponses).toBe(
        diagnostics.terminalRecovery.deltaResponses,
      );
      expect(diagnostics.terminalRecovery.tailDeltaResponses).toBe(0);
    }
    expect(terminalStatusHistory).not.toContain('restoring');
  });
});
