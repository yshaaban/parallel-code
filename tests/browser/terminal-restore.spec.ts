import { IPC } from '../../electron/ipc/channels.js';

import {
  expect,
  getTerminalLoadingOverlay,
  test,
  waitForAppShellVisible,
} from './harness/fixtures.js';
import { assertInteractiveTerminalLifecycleInvariants } from './harness/lifecycle-invariants.js';
import {
  assertNoTerminalAnomalies,
  assertNoVisibleRecoveryChurn,
  assertTerminalDiagnosticsWithinBudget,
  assertTerminalRenderWithinBudget,
  beginTerminalAttributeHistory,
  beginTerminalPresentationModeHistory,
  captureTerminalDiagnostics,
  dragTerminalPanelResizeHandle,
  getOutputDiagnostics,
  getTerminalOutputEntry,
  getRendererDiagnostics,
  openDiagnosticSession,
  readTerminalAttributeHistory,
} from './harness/terminal-render.js';
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
    terminalStateFallbacks: number;
    terminalStateResponses: number;
  };
}

function normalizeWidthChurnVisibleLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/__WIDTH_CHURN_[A-Z0-9_]+__/g, '__WIDTH_CHURN_MARKER__'));
}

interface TerminalRenderStateSnapshot {
  currentCursorX: number;
  currentCursorY: number;
  currentViewportY: number;
  currentVisibleLines: string[];
}

interface TerminalReplayTraceEntry {
  agentId: string;
  requestStateBytes?: number;
  reason: 'attach' | 'backpressure' | 'hibernate' | 'reconnect' | 'renderer-loss';
  waitForOutputIdleMs: number;
}

async function installTerminalReplayTracing(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = [];
  });
}

async function readTerminalReplayTrace(
  page: import('@playwright/test').Page,
): Promise<TerminalReplayTraceEntry[]> {
  return page.evaluate(() => {
    return [...(window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ ?? [])];
  });
}

async function readTerminalStatuses(
  page: import('@playwright/test').Page,
): Promise<Array<string | null>> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-terminal-status]')).map((statusElement) =>
      statusElement.getAttribute('data-terminal-status'),
    );
  });
}

async function readReloadFailurePageState(page: import('@playwright/test').Page): Promise<{
  bodyText: string | null;
  pageClosed: boolean;
  readyState: DocumentReadyState | null;
  title: string | null;
  url: string | null;
}> {
  if (page.isClosed()) {
    return {
      bodyText: null,
      pageClosed: true,
      readyState: null,
      title: null,
      url: null,
    };
  }

  try {
    return await page.evaluate(() => ({
      bodyText: document.body?.innerText?.trim()?.slice(0, 500) ?? null,
      pageClosed: false,
      readyState: document.readyState,
      title: document.title || null,
      url: window.location.href,
    }));
  } catch {
    return {
      bodyText: null,
      pageClosed: page.isClosed(),
      readyState: null,
      title: null,
      url: page.url(),
    };
  }
}

async function readRendererDiagnosticsSafely(
  page: import('@playwright/test').Page,
): Promise<unknown | null> {
  if (page.isClosed()) {
    return null;
  }

  try {
    return await getRendererDiagnostics(page);
  } catch {
    return null;
  }
}

async function readTerminalLifecycleAt(
  page: import('@playwright/test').Page,
  terminalIndex: number,
): Promise<{
  liveRenderReady: boolean;
  renderHibernating: boolean;
  restoreBlocked: boolean;
  status: string | null;
  surfaceTier: string | null;
}> {
  return page.evaluate((index) => {
    const statusElements = Array.from(document.querySelectorAll('[data-terminal-status]'));
    const statusElement = statusElements[index];
    return {
      liveRenderReady: statusElement?.getAttribute('data-terminal-live-render-ready') === 'true',
      renderHibernating: statusElement?.getAttribute('data-terminal-render-hibernating') === 'true',
      restoreBlocked: statusElement?.getAttribute('data-terminal-restore-blocked') === 'true',
      status: statusElement?.getAttribute('data-terminal-status') ?? null,
      surfaceTier: statusElement?.getAttribute('data-terminal-surface-tier') ?? null,
    };
  }, terminalIndex);
}

async function getAgentSupervisionState(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  agentId: string,
): Promise<string | null> {
  const supervision = await browserLab.invokeIpc<Array<{ agentId: string; state: string }>>(
    request,
    IPC.GetAgentSupervision,
  );
  return supervision.find((entry) => entry.agentId === agentId)?.state ?? null;
}

async function waitForAgentNotFlowControlled(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
  },
  request: unknown,
  agentId: string,
  timeoutMs = 10_000,
): Promise<void> {
  await expect
    .poll(() => getAgentSupervisionState(browserLab, request, agentId), { timeout: timeoutMs })
    .not.toBe('flow-controlled');
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

function getTerminalRenderStateSnapshot(
  agentId: string,
  snapshot: Awaited<ReturnType<typeof getOutputDiagnostics>>,
): TerminalRenderStateSnapshot | null {
  const terminal = snapshot?.terminals.find((entry) => entry.agentId === agentId) ?? null;
  if (
    !terminal ||
    terminal.render.currentCursorX === null ||
    terminal.render.currentCursorY === null ||
    terminal.render.currentViewportY === null ||
    terminal.render.currentVisibleLines === null
  ) {
    return null;
  }

  return {
    currentCursorX: terminal.render.currentCursorX,
    currentCursorY: terminal.render.currentCursorY,
    currentViewportY: terminal.render.currentViewportY,
    currentVisibleLines: terminal.render.currentVisibleLines,
  };
}

async function waitForTerminalRenderStateSnapshot(
  page: Parameters<typeof getOutputDiagnostics>[0],
  agentId: string,
  expectedLines: {
    firstVisibleLine?: string;
    minViewportY?: number;
    targetLineIncludes: string;
  },
): Promise<TerminalRenderStateSnapshot> {
  await expect
    .poll(async () => {
      const snapshot = getTerminalRenderStateSnapshot(agentId, await getOutputDiagnostics(page));
      if (!snapshot) {
        return null;
      }

      const firstVisibleLineMatches =
        expectedLines.firstVisibleLine === undefined ||
        snapshot.currentVisibleLines[0] === expectedLines.firstVisibleLine;
      const viewportMatches =
        expectedLines.minViewportY === undefined ||
        snapshot.currentViewportY >= expectedLines.minViewportY;

      return firstVisibleLineMatches &&
        viewportMatches &&
        snapshot.currentVisibleLines.some((line) => line.includes(expectedLines.targetLineIncludes))
        ? snapshot
        : null;
    })
    .not.toBeNull();

  const snapshot = getTerminalRenderStateSnapshot(agentId, await getOutputDiagnostics(page));
  expect(snapshot).not.toBeNull();
  return snapshot as TerminalRenderStateSnapshot;
}

function createCursorAddressedFixtureCommand(options: {
  lineCount: number;
  targetColumn: number;
  targetLabel: string;
  targetRow: number;
}): string {
  return [
    `node -e '`,
    `process.stdout.write("\\x1b[2J\\x1b[H");`,
    `for (let i = 1; i <= ${options.lineCount}; i += 1) {`,
    `  process.stdout.write("\\x1b[" + i + ";1HROW_" + String(i).padStart(2, "0"));`,
    `}`,
    `process.stdout.write("\\x1b[${options.targetRow};${options.targetColumn}H${options.targetLabel}");`,
    `setTimeout(() => {}, 30000);`,
    `'`,
  ].join('');
}

function createWrappedHistoryFixtureCommand(options: {
  completionMarker: string;
  lineCount: number;
  lineWidth: number;
}): string {
  return [
    `node -e '`,
    `process.stdout.write("\\x1b[2J\\x1b[H");`,
    `for (let i = 1; i <= ${options.lineCount}; i += 1) {`,
    `  const prefix = "WRAP_ROW_" + String(i).padStart(3, "0") + "_";`,
    `  process.stdout.write(prefix + String(i % 10).repeat(${options.lineWidth}) + "\\n");`,
    `}`,
    `process.stdout.write("${options.completionMarker}\\n");`,
    `'`,
  ].join('');
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
    page.on('close', () => {
      console.warn('reload warm scrollback page close');
    });
    page.on('crash', () => {
      console.warn('reload warm scrollback page crash');
    });
    page.on('pageerror', (error) => {
      console.warn('reload warm scrollback pageerror', error);
    });
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        console.warn('reload warm scrollback console', message.type(), message.text());
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        console.warn('reload warm scrollback navigated', frame.url());
      }
    });
    page.on('requestfailed', (request) => {
      if (request.frame() !== page.mainFrame()) {
        return;
      }

      const resourceType = request.resourceType();
      if (
        resourceType !== 'document' &&
        resourceType !== 'script' &&
        resourceType !== 'stylesheet'
      ) {
        return;
      }

      console.warn('reload warm scrollback request failed', {
        errorText: request.failure()?.errorText ?? null,
        resourceType,
        url: request.url(),
      });
    });
    page.on('response', (response) => {
      if (response.ok()) {
        return;
      }

      const request = response.request();
      if (request.frame() !== page.mainFrame()) {
        return;
      }

      const resourceType = request.resourceType();
      if (
        resourceType !== 'document' &&
        resourceType !== 'script' &&
        resourceType !== 'stylesheet'
      ) {
        return;
      }

      console.warn('reload warm scrollback response error', {
        resourceType,
        status: response.status(),
        url: response.url(),
      });
    });
    await browserLab.waitForTerminalReady(page);
    await browserLab.runInTerminal(
      page,
      'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_LINE_${i}`)',
      {
        pressEnter: true,
      },
    );
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'RESTORE_LINE_119');

    await page.reload();
    try {
      await waitForAppShellVisible(page);
    } catch (error) {
      console.warn(
        'reload warm scrollback page shell state',
        await readReloadFailurePageState(page),
      );
      throw error;
    }
    try {
      await page
        .locator('textarea[aria-label="Terminal input"]')
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 });
      await browserLab.waitForTerminalReady(page);
    } catch (error) {
      console.warn(
        'reload warm scrollback snapshot',
        await page.evaluate(() => ({
          appStartupDetail:
            document.querySelector('[data-app-startup-status-detail]')?.textContent ?? null,
          appStartupLabel:
            document.querySelector('[data-app-startup-status-label]')?.textContent ?? null,
          noProjectsLinked: document.body.textContent?.includes('No projects linked yet.') ?? false,
          taskPanels: document.querySelectorAll('[data-task-id]').length,
          terminalInputCount: document.querySelectorAll('textarea[aria-label="Terminal input"]')
            .length,
          terminalStatuses: Array.from(document.querySelectorAll('[data-terminal-status]')).map(
            (element) => ({
              agentId: element.getAttribute('data-terminal-agent-id'),
              blocked: element.getAttribute('data-terminal-restore-blocked'),
              dormant: element.getAttribute('data-terminal-dormant'),
              status: element.getAttribute('data-terminal-status'),
              tier: element.getAttribute('data-terminal-surface-tier'),
            }),
          ),
        })),
      );
      console.warn(
        'reload warm scrollback lifecycle snapshot',
        await browserLab.readLifecycleSnapshot(page),
      );
      console.warn(
        'reload warm scrollback renderer diagnostics',
        await readRendererDiagnosticsSafely(page),
      );
      console.warn(
        'reload warm scrollback workspace state file',
        await browserLab.invokeIpc(request, IPC.LoadWorkspaceState),
      );
      console.warn(
        'reload warm scrollback backend cold bootstrap',
        await browserLab.invokeIpc(request, IPC.GetBrowserColdBootstrap),
      );
      console.warn(
        'reload warm scrollback backend diagnostics',
        await browserLab.invokeIpc(request, IPC.GetBackendRuntimeDiagnostics),
      );
      throw error;
    }

    await browserLab.runInTerminal(page, 'console.log("RESTORE_AFTER_RELOAD")');
    try {
      await browserLab.waitForAgentScrollback(
        request,
        browserLab.server.agentId,
        'RESTORE_AFTER_RELOAD',
        15_000,
      );
    } catch (error) {
      console.warn(
        'reload post-command lifecycle snapshot',
        await browserLab.readLifecycleSnapshot(page),
      );
      console.warn(
        'reload post-command renderer diagnostics',
        await readRendererDiagnosticsSafely(page),
      );
      console.warn(
        'reload post-command backend diagnostics',
        await browserLab.invokeIpc(request, IPC.GetBackendRuntimeDiagnostics),
      );
      console.warn(
        'reload post-command agent scrollback',
        await browserLab.invokeIpc(request, IPC.GetAgentScrollback, {
          agentId: browserLab.server.agentId,
        }),
      );
      throw error;
    }

    await expect(getTerminalLoadingOverlay(page)).toHaveCount(0);
    await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
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
    await browserLab.runInTerminal(
      page,
      'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_RACE_LINE_${i}`)',
      {
        pressEnter: true,
      },
    );
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'RESTORE_RACE_LINE_119',
    );

    await page.reload();
    await waitForAppShellVisible(page);
    const terminalInput = page.locator('textarea[aria-label="Terminal input"]').first();
    await terminalInput.waitFor({ state: 'attached' });
    await terminalInput.focus();

    const marker = 'RESTORE_TYPED_DURING_RECOVERY';
    await page.keyboard.type(`console.log("${marker}")`);
    await page.keyboard.press('Enter');

    await browserLab.waitForTerminalReady(page);
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);
    await expect(page.locator('[data-terminal-resize-overlay="true"]')).toHaveCount(0);
  });

  test('reconnects through browser transport churn without skipping restore ownership or losing queued input', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Offline Restore Churn Tester',
      prepareContext: async (browserContext) => {
        await browserContext.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
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
      [browserLab.server.agentId],
    );
    await browserLab.waitForShellPromptReady(request, shellAgentId);
    await browserLab.beginTerminalStatusHistory(page);
    await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
    await page.evaluate(() => {
      window.__parallelCodeRendererRuntimeDiagnostics?.reset();
    });

    await page.evaluate(() => {
      window.__parallelCodeBrowserTransportForTests__?.disconnect();
    });
    await expect
      .poll(() => browserLab.readConnectionBannerHistory(page), { timeout: 10_000 })
      .toContain('disconnected');

    const offlineMarker = '__OFFLINE_RESTORE_INPUT__';
    await browserLab.runInTerminal(page, `printf "${offlineMarker}\\n"`, {
      terminalIndex: shellTerminalIndex,
    });
    await page.evaluate(() => {
      return window.__parallelCodeBrowserTransportForTests__?.ensureConnected();
    });
    await expect
      .poll(() => browserLab.readConnectionBannerHistory(page), {
        timeout: 10_000,
      })
      .toContain('restoring');
    await dragTerminalPanelResizeHandle(page, 0, 120);

    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
    await browserLab.waitForAgentScrollback(request, shellAgentId, offlineMarker);

    const bannerHistory = await browserLab.readConnectionBannerHistory(page);
    expect(bannerHistory).toContain('disconnected');
    expect(bannerHistory).toContain('reconnecting');
    expect(bannerHistory).toContain('restoring');
    expect(bannerHistory[bannerHistory.length - 1]).toBeNull();

    const rendererDiagnostics = await getRendererDiagnostics(page);
    expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
    expect(rendererDiagnostics?.terminalRecovery.renderRefreshes ?? 0).toBe(0);
    expect(
      rendererDiagnostics?.terminalRecovery.visibleSteadyStateSnapshotCounts.reconnect ?? 0,
    ).toBe(0);
    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      page,
      browserLab.server.taskId,
      {
        requireDocumentFocus: true,
        terminalIndex: shellTerminalIndex,
      },
    );
  });

  test('defers resize commits during reload restore and commits them once the terminal is ready again', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Restore Blocked Resize Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
    });

    await browserLab.waitForTerminalReady(page);
    await browserLab.runInTerminal(
      page,
      'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_RESIZE_${i}`)',
      {
        pressEnter: true,
      },
    );
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'RESTORE_RESIZE_119',
    );

    await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
    await page.evaluate(() => {
      window.__parallelCodeRendererRuntimeDiagnostics?.reset();
    });

    await page.reload();
    await waitForAppShellVisible(page);
    await page
      .locator('textarea[aria-label="Terminal input"]')
      .first()
      .waitFor({ state: 'attached' });
    await dragTerminalPanelResizeHandle(page, 0, 140);
    await browserLab.waitForTerminalReady(page);

    const marker = '__RESTORE_BLOCKED_RESIZE_DONE__';
    await browserLab.runInTerminal(page, `console.log("${marker}")`);
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);

    const rendererDiagnostics = await getRendererDiagnostics(page);
    expect(rendererDiagnostics?.terminalResize.queuedUpdates ?? 0).toBeGreaterThan(0);
    expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      page,
      browserLab.server.taskId,
      {
        requireDocumentFocus: true,
      },
    );
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
    await installTerminalReplayTracing(page);

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
      await waitForAppShellVisible(page);
      await browserLab.waitForTerminalReady(page, shellTerminalIndex);
      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
      await browserLab.waitForShellPromptReady(request, shellAgentId, 20_000);
      const replayTraceEntries = await readTerminalReplayTrace(page);
      const shellAttachReplay = replayTraceEntries.find(
        (entry) => entry.agentId === shellAgentId && entry.reason === 'attach',
      );
      expect(shellAttachReplay).toBeTruthy();
      expect(shellAttachReplay?.waitForOutputIdleMs ?? Infinity).toBeLessThan(250);

      const marker = `__AFTER_BIG_SCROLLBACK_RELOAD_${cycle}__`;
      await browserLab.runInTerminal(page, `printf "${marker}\\n"`, {
        terminalIndex: shellTerminalIndex,
      });
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
      await assertInteractiveTerminalLifecycleInvariants(
        browserLab,
        request,
        page,
        browserLab.server.taskId,
        {
          requireDocumentFocus: true,
          terminalIndex: shellTerminalIndex,
        },
      );
    }

    await expect(getTerminalLoadingOverlay(page)).toHaveCount(0);
  });

  test('keeps large-history attach catch-up structurally stable while panel resize churn overlaps reload', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Large Scrollback Resize Catchup Tester',
    });
    await installTerminalReplayTracing(page);
    try {
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
        'yes 12345678901234567890 | head -n 180000; printf "__BIG_SCROLLBACK_RESIZE_DONE__\\n"',
        {
          terminalIndex: shellTerminalIndex,
        },
      );
      await browserLab.waitForAgentScrollback(
        request,
        shellAgentId,
        '__BIG_SCROLLBACK_RESIZE_DONE__',
        20_000,
      );

      await browserLab.beginTerminalStatusHistory(page, shellTerminalIndex);
      await beginTerminalPresentationModeHistory(page, shellTerminalIndex);
      await beginTerminalAttributeHistory(
        page,
        'data-terminal-restore-blocked',
        shellTerminalIndex,
      );
      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await page.evaluate(() => {
        window.__parallelCodeRendererRuntimeDiagnostics?.reset();
        window.__parallelCodeTerminalOutputDiagnostics?.reset();
        window.__parallelCodeTerminalAnomalyMonitor?.reset();
        window.__parallelCodeUiFluidityDiagnostics?.reset();
      });

      await page.reload();
      await waitForAppShellVisible(page);

      const resizeDeltas = [140, -110, 120, -90];
      for (const resizeDelta of resizeDeltas) {
        await dragTerminalPanelResizeHandle(page, shellTerminalIndex, resizeDelta);
        await page.waitForTimeout(90);
      }

      await browserLab.waitForTerminalReady(page, shellTerminalIndex);

      const replayTraceEntries = await readTerminalReplayTrace(page);
      const shellAttachReplay = replayTraceEntries.find(
        (entry) => entry.agentId === shellAgentId && entry.reason === 'attach',
      );
      const outputDiagnostics = await getOutputDiagnostics(page);
      const rendererDiagnostics = await getRendererDiagnostics(page);
      const terminal = getTerminalOutputEntry(outputDiagnostics, shellAgentId);
      expect(shellAttachReplay).toBeTruthy();
      expect(shellAttachReplay?.waitForOutputIdleMs ?? Infinity).toBeLessThanOrEqual(50);
      expect(shellAttachReplay?.requestStateBytes ?? Infinity).toBeLessThanOrEqual(131_072);
      expect(rendererDiagnostics?.terminalResize.commitSuccesses ?? 0).toBeGreaterThan(0);
      expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
      await assertNoVisibleRecoveryChurn(page, browserLab, shellTerminalIndex);
      await assertNoTerminalAnomalies(page);
      assertTerminalRenderWithinBudget(terminal, {
        maxChangedVisibleLinesP95: 1,
        maxCursorRowJumpP95: 1,
        maxResizeEvents: 8,
        maxViewportJumpRowsP95: 0,
      });
      assertTerminalDiagnosticsWithinBudget(
        await captureTerminalDiagnostics(page, browserLab, request),
        {
          maxBackendSnapshotResponses: 0,
          maxQueuedQueueAgeP95Ms: 48,
          maxRenderRefreshes: 0,
          maxTerminalsWithAnomalies: 0,
          maxTotalAnomalies: 0,
          maxVisibleSteadyStateSnapshots: 0,
        },
      );
    } finally {
      await context.close();
    }
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
    await waitForAppShellVisible(page);
    await browserLab.waitForTerminalReady(page, focusedShellIndex);
    await browserLab.focusTerminal(page, focusedShellIndex);
    await browserLab.waitForTerminalReady(page, backgroundShellIndex, {
      requireLiveRenderReady: false,
    });

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

  test('keeps cold-hidden shell terminals dormant across reload until they become visible', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(180_000);

    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Cold Hidden Shell Reload Tester',
      viewportSize: { width: 1440, height: 220 },
    });

    try {
      await browserLab.waitForTerminalReady(page);
      const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
        request,
        IPC.ListRunningAgentIds,
      );

      const additionalShellCount = 3;
      for (let index = 0; index < additionalShellCount; index += 1) {
        await browserLab.createShellTerminal(page);
        await waitForNewRunningAgentId(browserLab, request, initialRunningAgentIds);
      }

      await browserLab.focusTerminal(page, 0);
      await page.evaluate(() => {
        window.__parallelCodeRendererRuntimeDiagnostics?.reset();
      });

      await page.reload();
      await waitForAppShellVisible(page);
      await browserLab.waitForTerminalReady(page, 0);
      await page.waitForTimeout(1_500);

      const statusesAfterReload = await readTerminalStatuses(page);
      const diagnosticsAfterReload = await captureTerminalDiagnostics(page, browserLab, request);
      const totalTerminalCount = statusesAfterReload.length;
      const lastTerminalIndex = totalTerminalCount - 1;
      const lastTerminalLifecycleAfterReload = await readTerminalLifecycleAt(
        page,
        lastTerminalIndex,
      );
      const attachRequestsAfterReload =
        diagnosticsAfterReload.browserSnapshot.pageDiagnostics.rendererDiagnostics?.terminalRecovery
          .requestCounts.attach ?? 0;

      expect(totalTerminalCount).toBeGreaterThan(additionalShellCount);
      expect(attachRequestsAfterReload).toBeLessThan(totalTerminalCount);
      expect(lastTerminalLifecycleAfterReload.surfaceTier).toBe('cold-hidden');
      expect(lastTerminalLifecycleAfterReload.liveRenderReady).toBe(false);
      await assertNoTerminalAnomalies(page);

      await page.locator('[data-terminal-status]').nth(lastTerminalIndex).scrollIntoViewIfNeeded();

      await expect
        .poll(() => readTerminalLifecycleAt(page, lastTerminalIndex), { timeout: 15_000 })
        .toEqual({
          liveRenderReady: true,
          renderHibernating: false,
          restoreBlocked: false,
          status: 'ready',
          surfaceTier: 'passive-visible',
        });

      const diagnosticsAfterReveal = await captureTerminalDiagnostics(page, browserLab, request);
      const attachRequestsAfterReveal =
        diagnosticsAfterReveal.browserSnapshot.pageDiagnostics.rendererDiagnostics?.terminalRecovery
          .requestCounts.attach ?? 0;

      expect(attachRequestsAfterReveal).toBeGreaterThanOrEqual(attachRequestsAfterReload);
      await assertNoTerminalAnomalies(page);
    } finally {
      await context.close();
    }
  });

  test('keeps a reserved hot-hidden shell dormant across reload until it becomes visible', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(180_000);

    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Hot Hidden Shell Reload Tester',
      terminalExperiments: {
        hiddenTerminalHibernationDelayMs: 75,
        hiddenTerminalHotCount: 1,
        label: 'restore-hot-hidden-shell',
      },
      viewportSize: { width: 1440, height: 220 },
    });

    try {
      await browserLab.waitForTerminalReady(page);
      const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
        request,
        IPC.ListRunningAgentIds,
      );

      const additionalShellCount = 3;
      for (let index = 0; index < additionalShellCount; index += 1) {
        await browserLab.createShellTerminal(page);
        await waitForNewRunningAgentId(browserLab, request, initialRunningAgentIds);
      }

      await browserLab.focusTerminal(page, 0);
      await page.evaluate(() => {
        window.__parallelCodeRendererRuntimeDiagnostics?.reset();
      });

      await page.reload();
      await waitForAppShellVisible(page);
      await browserLab.waitForTerminalReady(page, 0);
      await page.waitForTimeout(1_500);

      const statusesAfterReload = await readTerminalStatuses(page);
      const totalTerminalCount = statusesAfterReload.length;
      const lastTerminalIndex = totalTerminalCount - 1;
      const lastTerminalLifecycleAfterReload = await readTerminalLifecycleAt(
        page,
        lastTerminalIndex,
      );
      const diagnosticsAfterReload = await captureTerminalDiagnostics(page, browserLab, request);
      const attachRequestsAfterReload =
        diagnosticsAfterReload.browserSnapshot.pageDiagnostics.rendererDiagnostics?.terminalRecovery
          .requestCounts.attach ?? 0;

      expect(totalTerminalCount).toBeGreaterThan(additionalShellCount);
      expect(attachRequestsAfterReload).toBeLessThan(totalTerminalCount);
      expect(lastTerminalLifecycleAfterReload.surfaceTier).toBe('hot-hidden-live');
      expect(lastTerminalLifecycleAfterReload.liveRenderReady).toBe(false);
      await assertNoTerminalAnomalies(page);

      await page.locator('[data-terminal-status]').nth(lastTerminalIndex).scrollIntoViewIfNeeded();

      await expect
        .poll(() => readTerminalLifecycleAt(page, lastTerminalIndex), { timeout: 15_000 })
        .toEqual({
          liveRenderReady: true,
          renderHibernating: false,
          restoreBlocked: false,
          status: 'ready',
          surfaceTier: 'passive-visible',
        });

      const diagnosticsAfterReveal = await captureTerminalDiagnostics(page, browserLab, request);
      const attachRequestsAfterReveal =
        diagnosticsAfterReveal.browserSnapshot.pageDiagnostics.rendererDiagnostics?.terminalRecovery
          .requestCounts.attach ?? 0;

      expect(attachRequestsAfterReveal).toBeGreaterThanOrEqual(attachRequestsAfterReload);
      await assertNoTerminalAnomalies(page);
    } finally {
      await context.close();
    }
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
    await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);

    const standbyPage = await context.newPage();
    await standbyPage.goto('about:blank');
    await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
    await browserLab.beginTerminalStatusHistory(page, shellTerminalIndex);
    await beginTerminalAttributeHistory(
      page,
      'data-terminal-render-hibernating',
      shellTerminalIndex,
    );
    await beginTerminalAttributeHistory(page, 'data-terminal-surface-tier', shellTerminalIndex);

    for (const cycle of [1, 2, 3, 4, 5]) {
      await standbyPage.bringToFront();

      const backgroundDoneMarker = `__BACKGROUND_SWITCH_DONE_${cycle}__`;
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `yes "SWITCH_${cycle}" | head -n 20000; printf "${backgroundDoneMarker}\\n"\n`,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, backgroundDoneMarker, 20_000);
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);

      await page.bringToFront();
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);
      await assertInteractiveTerminalLifecycleInvariants(
        browserLab,
        request,
        page,
        browserLab.server.taskId,
        {
          terminalIndex: shellTerminalIndex,
        },
      );
      const foregroundMarker = `__AFTER_BACKGROUND_SWITCH_${cycle}__`;
      await browserLab.runInTerminal(page, `printf "${foregroundMarker}\\n"`, {
        terminalIndex: shellTerminalIndex,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, foregroundMarker, 15_000);
      await expect(getTerminalLoadingOverlay(page)).toHaveCount(0);
      await assertInteractiveTerminalLifecycleInvariants(
        browserLab,
        request,
        page,
        browserLab.server.taskId,
        {
          requireDocumentFocus: true,
          terminalIndex: shellTerminalIndex,
        },
      );
    }

    const diagnostics = await browserLab.invokeIpc<RuntimeDiagnosticsSnapshot>(
      request,
      IPC.GetBackendRuntimeDiagnostics,
    );
    const renderHibernatingHistory = await readTerminalAttributeHistory(
      page,
      'data-terminal-render-hibernating',
      shellTerminalIndex,
    );
    const surfaceTierHistory = await readTerminalAttributeHistory(
      page,
      'data-terminal-surface-tier',
      shellTerminalIndex,
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
    expect(renderHibernatingHistory[renderHibernatingHistory.length - 1]).not.toBe('true');
    expect(surfaceTierHistory[surfaceTierHistory.length - 1]).toBe('interactive-live');
  });

  test('keeps width-sensitive wrapped output visually stable while resize churn overlaps reconnect', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Reconnect Width Churn Restore Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
          window.__TERMINAL_OUTPUT_VISIBLE_LINE_DIAGNOSTICS__ = true;
          window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        });
      },
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
    await browserLab.waitForShellPromptReady(request, shellAgentId);
    await browserLab.focusTerminal(page, shellTerminalIndex);

    const targetVisibleLine = 'WRAP_ROW_090_';
    const baselineMarker = '__WIDTH_CHURN_BASELINE__';
    const reconnectMarker = '__WIDTH_CHURN_RECONNECT__';
    const fixtureLineCount = 96;
    const fixtureLineWidth = 160;

    await browserLab.runInTerminal(
      page,
      createWrappedHistoryFixtureCommand({
        completionMarker: baselineMarker,
        lineCount: fixtureLineCount,
        lineWidth: fixtureLineWidth,
      }),
      {
        terminalIndex: shellTerminalIndex,
      },
    );
    await browserLab.waitForAgentScrollback(request, shellAgentId, baselineMarker, 20_000);
    await browserLab.waitForShellPromptReady(request, shellAgentId, 20_000);

    await dragTerminalPanelResizeHandle(page, shellTerminalIndex, -160);
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);

    const baselineSnapshot = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      targetLineIncludes: targetVisibleLine,
    });

    await dragTerminalPanelResizeHandle(page, shellTerminalIndex, 160);
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);
    await browserLab.waitForShellPromptReady(request, shellAgentId, 20_000);

    await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
    await page.evaluate(() => {
      window.__parallelCodeRendererRuntimeDiagnostics?.reset();
      window.__parallelCodeBrowserTransportForTests__?.disconnect();
    });
    await expect
      .poll(() => browserLab.readConnectionBannerHistory(page), { timeout: 10_000 })
      .toContain('disconnected');

    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: `${createWrappedHistoryFixtureCommand({
        completionMarker: reconnectMarker,
        lineCount: fixtureLineCount,
        lineWidth: fixtureLineWidth,
      })}\n`,
    });
    await browserLab.waitForAgentScrollback(request, shellAgentId, reconnectMarker, 20_000);

    const reconnectPromise = page.evaluate(() => {
      return window.__parallelCodeBrowserTransportForTests__?.ensureConnected();
    });
    for (const resizeDelta of [-120, 80, -90, 70, -100]) {
      await dragTerminalPanelResizeHandle(page, shellTerminalIndex, resizeDelta);
      await page.waitForTimeout(180);
    }
    await reconnectPromise;

    await expect
      .poll(() => browserLab.readConnectionBannerHistory(page), { timeout: 10_000 })
      .toContain('restoring');
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

    const restoredSnapshot = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      targetLineIncludes: targetVisibleLine,
    });

    expect(normalizeWidthChurnVisibleLines(restoredSnapshot.currentVisibleLines)).toEqual(
      normalizeWidthChurnVisibleLines(baselineSnapshot.currentVisibleLines),
    );

    await assertInteractiveTerminalLifecycleInvariants(
      browserLab,
      request,
      page,
      browserLab.server.taskId,
      {
        requireDocumentFocus: true,
        terminalIndex: shellTerminalIndex,
      },
    );
  });

  test('keeps width-sensitive wrapped output visually stable while resize churn overlaps reload attach', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { context, page } = await openDiagnosticSession(browser, browserLab, {
      displayName: 'Reload Width Churn Restore Tester',
    });

    await installTerminalReplayTracing(page);
    try {
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
      await browserLab.waitForShellPromptReady(request, shellAgentId);
      await browserLab.focusTerminal(page, shellTerminalIndex);

      const targetVisibleLine = 'WRAP_ROW_090_';
      const baselineMarker = '__WIDTH_CHURN_RELOAD_BASELINE__';
      const fixtureLineCount = 96;
      const fixtureLineWidth = 160;

      await browserLab.runInTerminal(
        page,
        createWrappedHistoryFixtureCommand({
          completionMarker: baselineMarker,
          lineCount: fixtureLineCount,
          lineWidth: fixtureLineWidth,
        }),
        {
          terminalIndex: shellTerminalIndex,
        },
      );
      await browserLab.waitForAgentScrollback(request, shellAgentId, baselineMarker, 20_000);
      await browserLab.waitForShellPromptReady(request, shellAgentId, 20_000);

      await dragTerminalPanelResizeHandle(page, shellTerminalIndex, -160);
      await browserLab.waitForTerminalReady(page, shellTerminalIndex);

      const baselineSnapshot = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
        targetLineIncludes: targetVisibleLine,
      });

      await dragTerminalPanelResizeHandle(page, shellTerminalIndex, 160);
      await browserLab.waitForTerminalReady(page, shellTerminalIndex);
      await browserLab.waitForShellPromptReady(request, shellAgentId, 20_000);

      await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
      await page.evaluate(() => {
        window.__parallelCodeRendererRuntimeDiagnostics?.reset();
        window.__parallelCodeTerminalOutputDiagnostics?.reset();
        window.__parallelCodeTerminalAnomalyMonitor?.reset();
        window.__parallelCodeUiFluidityDiagnostics?.reset();
      });

      await page.reload();
      await waitForAppShellVisible(page);
      await beginTerminalAttributeHistory(page, 'data-terminal-resize-overlay', shellTerminalIndex);

      for (const resizeDelta of [-120, 80, -90, 70, -100]) {
        await dragTerminalPanelResizeHandle(page, shellTerminalIndex, resizeDelta);
        await page.waitForTimeout(180);
      }

      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
      await browserLab.waitForShellPromptReady(request, shellAgentId, 20_000);

      const restoredSnapshot = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
        targetLineIncludes: targetVisibleLine,
      });

      expect(normalizeWidthChurnVisibleLines(restoredSnapshot.currentVisibleLines)).toEqual(
        normalizeWidthChurnVisibleLines(baselineSnapshot.currentVisibleLines),
      );

      const replayTraceEntries = await readTerminalReplayTrace(page);
      const shellAttachReplay = replayTraceEntries.find(
        (entry) => entry.agentId === shellAgentId && entry.reason === 'attach',
      );
      const outputDiagnostics = await getOutputDiagnostics(page);
      const rendererDiagnostics = await getRendererDiagnostics(page);
      const terminal = getTerminalOutputEntry(outputDiagnostics, shellAgentId);
      const resizeOverlayHistory = await readTerminalAttributeHistory(
        page,
        'data-terminal-resize-overlay',
        shellTerminalIndex,
      );

      expect(shellAttachReplay).toBeTruthy();
      expect(shellAttachReplay?.requestStateBytes ?? Infinity).toBe(0);
      expect(rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0).toBe(0);
      expect(rendererDiagnostics?.terminalRecovery.geometryAlignmentFallbacks ?? 0).toBe(0);
      expect(rendererDiagnostics?.terminalRecovery.renderRefreshes ?? 0).toBe(0);
      expect(resizeOverlayHistory).not.toContain('true');
      await assertNoVisibleRecoveryChurn(page, browserLab, shellTerminalIndex);
      await assertNoTerminalAnomalies(page);
      assertTerminalRenderWithinBudget(terminal, {
        maxRenderCalls: 16,
        maxResizeEvents: 8,
      });
      assertTerminalDiagnosticsWithinBudget(
        await captureTerminalDiagnostics(page, browserLab, request),
        {
          maxBackendSnapshotResponses: 0,
          maxQueuedQueueAgeP95Ms: 48,
          maxRenderRefreshes: 0,
          maxTerminalsWithAnomalies: 0,
          maxTotalAnomalies: 0,
          maxVisibleSteadyStateSnapshots: 0,
        },
      );
    } finally {
      await context.close();
    }
  });

  test('preserves cursor-addressed viewport state across reload restore', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Cursor Addressed Restore Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
          window.__TERMINAL_OUTPUT_VISIBLE_LINE_DIAGNOSTICS__ = true;
        });
      },
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
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);
    await browserLab.focusTerminal(page, shellTerminalIndex);

    await browserLab.runInTerminal(
      page,
      createCursorAddressedFixtureCommand({
        lineCount: 30,
        targetColumn: 10,
        targetLabel: 'CURSOR_TARGET',
        targetRow: 5,
      }),
      {
        terminalIndex: shellTerminalIndex,
      },
    );

    const beforeReload = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      firstVisibleLine: 'ROW_01',
      targetLineIncludes: 'CURSOR_TARGET',
    });

    await page.reload();
    await waitForAppShellVisible(page);
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);

    const afterReload = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      firstVisibleLine: 'ROW_01',
      targetLineIncludes: 'CURSOR_TARGET',
    });

    expect(afterReload.currentCursorX).toBe(beforeReload.currentCursorX);
    expect(afterReload.currentCursorY).toBe(beforeReload.currentCursorY);
    expect(afterReload.currentViewportY).toBe(beforeReload.currentViewportY);
    expect(afterReload.currentVisibleLines).toEqual(beforeReload.currentVisibleLines);
  });

  test('preserves a non-top cursor-addressed viewport across reload restore', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Scrolled Cursor Restore Tester',
      prepareContext: async (context) => {
        await context.addInitScript(() => {
          window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
          window.__TERMINAL_OUTPUT_VISIBLE_LINE_DIAGNOSTICS__ = true;
        });
      },
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
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);
    await browserLab.focusTerminal(page, shellTerminalIndex);

    await browserLab.runInTerminal(
      page,
      [
        `node -e '`,
        `for (let i = 1; i <= 80; i += 1) {`,
        `  process.stdout.write("SCROLL_ROW_" + String(i).padStart(2, "0") + "\\n");`,
        `}`,
        `setTimeout(() => {}, 30000);`,
        `'`,
      ].join(''),
      {
        terminalIndex: shellTerminalIndex,
      },
    );

    const beforeReload = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      minViewportY: 1,
      targetLineIncludes: 'SCROLL_ROW_80',
    });

    await page.reload();
    await waitForAppShellVisible(page);
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);

    const afterReload = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      minViewportY: 1,
      targetLineIncludes: 'SCROLL_ROW_80',
    });

    expect(afterReload.currentCursorX).toBe(beforeReload.currentCursorX);
    expect(afterReload.currentCursorY).toBe(beforeReload.currentCursorY);
    expect(afterReload.currentViewportY).toBe(beforeReload.currentViewportY);
    expect(afterReload.currentVisibleLines).toEqual(beforeReload.currentVisibleLines);
  });
});
