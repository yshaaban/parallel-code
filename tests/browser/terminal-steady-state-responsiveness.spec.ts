import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';
import {
  assertNoVisibleRecoveryChurn,
  dragTerminalPanelResizeHandle,
  getBackendDiagnostics,
  getOutputDiagnostics,
  getRendererDiagnostics,
  getTerminalSurfaceTier,
  getUiFluidityDiagnostics,
  openDiagnosticSession,
  resetTerminalDiagnostics,
} from './harness/terminal-render.js';
import {
  measureHeldKeyTrace,
  measureSingleKeyTrace,
  warmTerminalInputTracing,
} from './harness/terminal-input-tracing.js';

const NOISY_OUTPUT_COMMAND =
  'i=0; while [ "$i" -lt 240 ]; do printf "\\rNOISE_%04d" "$i"; i=$((i+1)); sleep 0.02; done; printf "\\nNOISE_DONE\\n"';

async function isTerminalRenderHibernating(
  page: import('@playwright/test').Page,
  terminalIndex: number,
): Promise<boolean> {
  return (
    (await page
      .locator('[data-terminal-status]:has(textarea[aria-label="Terminal input"])')
      .nth(terminalIndex)
      .getAttribute('data-terminal-render-hibernating')) === 'true'
  );
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

async function createShellTerminalWithAgent(
  browserLab: {
    createShellTerminal: (page: import('@playwright/test').Page) => Promise<number>;
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
    waitForShellPromptReady: (
      request: unknown,
      agentId: string,
      timeoutMs?: number,
    ) => Promise<void>;
  },
  page: import('@playwright/test').Page,
  request: unknown,
  knownAgentIds: string[],
): Promise<{ agentId: string; terminalIndex: number }> {
  const terminalIndex = await browserLab.createShellTerminal(page);
  const agentId = await waitForNewRunningAgentId(browserLab, request, knownAgentIds);
  knownAgentIds.push(agentId);
  await browserLab.waitForShellPromptReady(request, agentId);
  return { agentId, terminalIndex };
}

test.describe('browser-lab steady-state responsiveness', () => {
  test.use({
    scenario: createPromptReadyScenario(),
  });

  test('keeps active typing responsive while a visible sibling streams output', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Steady State Visible Sibling Typing Tester',
    });
    try {
      await browserLab.waitForTerminalReady(page);
      const knownAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
      const focusedShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );
      const noisyShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );

      await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
        terminalIndex: noisyShell.terminalIndex,
      });
      await browserLab.waitForAgentScrollback(request, noisyShell.agentId, 'NOISE_');

      await browserLab.focusTerminal(page, focusedShell.terminalIndex);
      await warmTerminalInputTracing(browserLab, page, request, focusedShell.terminalIndex, {
        clearLineAfterWarm: true,
      });
      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await resetTerminalDiagnostics(page);

      const snapshot = await measureHeldKeyTrace(browserLab, page, request, 'x', 12, {
        delayMs: 16,
        focusTerminal: false,
        minimumCount: 6,
        terminalIndex: focusedShell.terminalIndex,
      });
      const [outputDiagnostics, rendererDiagnostics, uiFluidityDiagnostics] = await Promise.all([
        getOutputDiagnostics(page),
        getRendererDiagnostics(page),
        getUiFluidityDiagnostics(page),
      ]);

      expect(snapshot.summary.count).toBeGreaterThanOrEqual(6);
      expect(snapshot.droppedTraces).toBe(0);
      expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(32);
      expect(snapshot.summary.endToEndMs.p95).toBeLessThan(36);
      expect(
        outputDiagnostics?.summary.writes.byPriority['visible-background'].calls ?? 0,
      ).toBeGreaterThan(0);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.visibleBackgroundBytes.p95 ?? 0,
      ).toBeGreaterThan(0);
      expect(
        rendererDiagnostics?.terminalInput.inFlightBatchesCurrent ?? Number.POSITIVE_INFINITY,
      ).toBe(0);
      expect(
        rendererDiagnostics?.terminalInput.queuedChunksCurrent ?? Number.POSITIVE_INFINITY,
      ).toBe(0);
      expect(
        uiFluidityDiagnostics?.frames.overBudget50ms ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  });

  test('keeps active typing responsive while a hidden sibling accumulates backlog', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Steady State Hidden Backlog Typing Tester',
      viewportSize: { width: 1440, height: 900 },
    });
    try {
      await browserLab.waitForTerminalReady(page);
      const knownAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
      const focusedShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );
      await createShellTerminalWithAgent(browserLab, page, request, knownAgentIds);
      await createShellTerminalWithAgent(browserLab, page, request, knownAgentIds);
      const noisyShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );

      await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
        terminalIndex: noisyShell.terminalIndex,
      });
      await browserLab.waitForAgentScrollback(request, noisyShell.agentId, 'NOISE_');

      await page.setViewportSize({ width: 1440, height: 220 });
      await browserLab.focusTerminal(page, focusedShell.terminalIndex);
      await expect
        .poll(async () => getTerminalSurfaceTier(page, noisyShell.terminalIndex), {
          timeout: 10_000,
        })
        .toMatch(/hidden/);

      await warmTerminalInputTracing(browserLab, page, request, focusedShell.terminalIndex, {
        clearLineAfterWarm: true,
      });
      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await resetTerminalDiagnostics(page);

      const snapshot = await measureSingleKeyTrace(browserLab, page, request, 'x', {
        focusTerminal: false,
        terminalIndex: focusedShell.terminalIndex,
      });
      const [backendDiagnostics, outputDiagnostics, rendererDiagnostics, uiFluidityDiagnostics] =
        await Promise.all([
          getBackendDiagnostics(browserLab, request),
          getOutputDiagnostics(page),
          getRendererDiagnostics(page),
          getUiFluidityDiagnostics(page),
        ]);

      expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
      expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(24);
      expect(snapshot.summary.endToEndMs.p95).toBeLessThan(28);
      expect(outputDiagnostics?.summary.writes.byPriority.hidden.calls ?? 0).toBeGreaterThan(0);
      expect(uiFluidityDiagnostics?.terminalOutputPerFrame.hiddenBytes.p95 ?? 0).toBeGreaterThan(0);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.hiddenQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(96);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.focusedQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(32);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.queuedQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(48);
      expect(
        uiFluidityDiagnostics?.frames.overBudget50ms ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(2);
      expect(
        rendererDiagnostics?.terminalRecovery.renderRefreshes ?? Number.POSITIVE_INFINITY,
      ).toBe(0);
      expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
      expect(
        rendererDiagnostics?.terminalInput.inFlightBatchesCurrent ?? Number.POSITIVE_INFINITY,
      ).toBe(0);
      expect(
        rendererDiagnostics?.terminalInput.queuedChunksCurrent ?? Number.POSITIVE_INFINITY,
      ).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('hibernates a reserved hidden shell renderer and reveals it without visible recovery churn', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Steady State Hidden Render Hibernation Tester',
      terminalExperiments: {
        hiddenTerminalHibernationDelayMs: 75,
        hiddenTerminalHotCount: 1,
      },
      viewportSize: { width: 1440, height: 900 },
    });
    try {
      await browserLab.waitForTerminalReady(page);
      const knownAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
      const focusedShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );
      await browserLab.createShellTerminal(page);
      knownAgentIds.push(await waitForNewRunningAgentId(browserLab, request, knownAgentIds));
      await browserLab.createShellTerminal(page);
      knownAgentIds.push(await waitForNewRunningAgentId(browserLab, request, knownAgentIds));
      const hiddenShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );

      await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
        terminalIndex: hiddenShell.terminalIndex,
      });
      await browserLab.waitForAgentScrollback(request, hiddenShell.agentId, 'NOISE_');

      await page.setViewportSize({ width: 1440, height: 220 });
      await browserLab.focusTerminal(page, focusedShell.terminalIndex);
      await expect
        .poll(async () => getTerminalSurfaceTier(page, hiddenShell.terminalIndex), {
          timeout: 10_000,
        })
        .toMatch(/hidden/);
      await expect
        .poll(() => isTerminalRenderHibernating(page, hiddenShell.terminalIndex), {
          timeout: 10_000,
        })
        .toBe(true);

      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await resetTerminalDiagnostics(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await browserLab.focusTerminal(page, hiddenShell.terminalIndex);
      await browserLab.waitForTerminalPaintReady(page, hiddenShell.terminalIndex, {
        timeoutMs: 10_000,
      });
      const [backendDiagnostics, rendererDiagnostics, uiFluidityDiagnostics] = await Promise.all([
        getBackendDiagnostics(browserLab, request),
        getRendererDiagnostics(page),
        getUiFluidityDiagnostics(page),
      ]);
      await expect
        .poll(() => isTerminalRenderHibernating(page, hiddenShell.terminalIndex), {
          timeout: 10_000,
        })
        .toBe(false);
      await assertNoVisibleRecoveryChurn(page, browserLab, hiddenShell.terminalIndex);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.switchTargetVisibleQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(32);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.visibleBackgroundQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(48);
      expect(
        uiFluidityDiagnostics?.frames.overBudget50ms ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(2);
      expect(
        rendererDiagnostics?.terminalRecovery.renderRefreshes ?? Number.POSITIVE_INFINITY,
      ).toBe(0);
      expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('keeps terminal switching responsive while a sibling is noisy', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Steady State Switch Tester',
    });
    try {
      await browserLab.waitForTerminalReady(page);
      const knownAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
      const firstShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );
      const secondShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );
      const noisyShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );

      await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
        terminalIndex: noisyShell.terminalIndex,
      });
      await browserLab.waitForAgentScrollback(request, noisyShell.agentId, 'NOISE_');
      await warmTerminalInputTracing(browserLab, page, request, secondShell.terminalIndex, {
        clearLineAfterWarm: true,
      });
      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await resetTerminalDiagnostics(page);

      await browserLab.focusTerminal(page, secondShell.terminalIndex);
      const snapshot = await measureSingleKeyTrace(browserLab, page, request, 'x', {
        focusTerminal: false,
        terminalIndex: secondShell.terminalIndex,
      });
      const [backendDiagnostics, outputDiagnostics, rendererDiagnostics, uiFluidityDiagnostics] =
        await Promise.all([
          getBackendDiagnostics(browserLab, request),
          getOutputDiagnostics(page),
          getRendererDiagnostics(page),
          getUiFluidityDiagnostics(page),
        ]);

      expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
      expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(26);
      expect(snapshot.summary.endToEndMs.p95).toBeLessThan(32);
      expect(await getTerminalSurfaceTier(page, secondShell.terminalIndex)).toBe(
        'interactive-live',
      );
      expect(await getTerminalSurfaceTier(page, firstShell.terminalIndex)).toBe('passive-visible');
      expect(
        outputDiagnostics?.summary.writes.byPriority['visible-background'].calls ?? 0,
      ).toBeGreaterThan(0);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.visibleBackgroundBytes.p95 ?? 0,
      ).toBeGreaterThan(0);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.focusedQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(32);
      expect(
        uiFluidityDiagnostics?.frames.overBudget50ms ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(2);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.switchTargetVisibleQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(24);
      expect(
        uiFluidityDiagnostics?.terminalOutputPerFrame.visibleBackgroundQueueAgeMs.p95 ??
          Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(48);
      expect(
        rendererDiagnostics?.terminalRecovery.renderRefreshes ?? Number.POSITIVE_INFINITY,
      ).toBe(0);
      expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('keeps focused input responsive after panel resize while a sibling is noisy', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Steady State Resize Tester',
    });
    try {
      await browserLab.waitForTerminalReady(page);
      const knownAgentIds = await browserLab.invokeIpc<string[]>(request, IPC.ListRunningAgentIds);
      const focusedShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );
      const noisyShell = await createShellTerminalWithAgent(
        browserLab,
        page,
        request,
        knownAgentIds,
      );

      await browserLab.runInTerminal(page, NOISY_OUTPUT_COMMAND, {
        terminalIndex: noisyShell.terminalIndex,
      });
      await browserLab.waitForAgentScrollback(request, noisyShell.agentId, 'NOISE_');
      await browserLab.focusTerminal(page, focusedShell.terminalIndex);
      await warmTerminalInputTracing(browserLab, page, request, focusedShell.terminalIndex, {
        clearLineAfterWarm: true,
      });
      await resetTerminalDiagnostics(page);

      for (const resizeDelta of [120, -90, 80]) {
        await dragTerminalPanelResizeHandle(page, focusedShell.terminalIndex, resizeDelta);
      }

      await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);

      const snapshot = await measureSingleKeyTrace(browserLab, page, request, 'x', {
        focusTerminal: false,
        terminalIndex: focusedShell.terminalIndex,
      });
      const rendererDiagnostics = await getRendererDiagnostics(page);

      expect(snapshot.summary.count).toBeGreaterThanOrEqual(1);
      expect(snapshot.summary.sendToEchoMs.p95).toBeLessThan(28);
      expect(snapshot.summary.endToEndMs.p95).toBeLessThan(34);
      expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
      expect(
        rendererDiagnostics?.terminalFit.executionCounts['session-raf'] ?? Number.POSITIVE_INFINITY,
      ).toBeLessThanOrEqual(3);
    } finally {
      await context.close();
    }
  });
});
