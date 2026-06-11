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

const LARGE_SCROLLBACK_FIXTURE_WAIT_TIMEOUT_MS = 45_000;

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

function normalizeWidthChurnLogicalRows(lines: readonly string[]): string[] {
  const normalizedRows: string[] = [];
  let currentRow: string | null = null;

  function flushCurrentRow(): void {
    if (currentRow === null) {
      return;
    }

    normalizedRows.push(currentRow);
    currentRow = null;
  }

  for (const line of normalizeWidthChurnVisibleLines(lines)) {
    if (line.startsWith('WRAP_ROW_')) {
      flushCurrentRow();
      currentRow = line;
      continue;
    }

    if (currentRow !== null && /^[0-9]+$/u.test(line)) {
      currentRow += line;
      continue;
    }

    flushCurrentRow();
    if (line.includes('__WIDTH_CHURN_MARKER__') || line.includes('yrsh@')) {
      normalizedRows.push(line);
    }
  }

  flushCurrentRow();
  return normalizedRows;
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

async function installStartupRecoveryFetchHold(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.addInitScript((channel) => {
    type StartupRecoveryFetchHoldWindow = Window & {
      __parallelCodeReleaseStartupRecovery?: () => void;
      __parallelCodeStartupRecoveryHeld?: boolean;
      __parallelCodeStartupRecoveryRequested?: boolean;
    };

    const win = window as StartupRecoveryFetchHoldWindow;
    const originalFetch = window.fetch.bind(window);

    function getFetchUrl(input: RequestInfo | URL): string {
      if (typeof input === 'string') {
        return input;
      }

      if (input instanceof Request) {
        return input.url;
      }

      return input.toString();
    }

    window.fetch = async (input, init) => {
      const url = getFetchUrl(input);
      if (!win.__parallelCodeStartupRecoveryHeld && url.includes(`/api/ipc/${channel}`)) {
        win.__parallelCodeStartupRecoveryHeld = true;
        win.__parallelCodeStartupRecoveryRequested = true;
        await new Promise<void>((resolve) => {
          win.__parallelCodeReleaseStartupRecovery = resolve;
        });
      }

      return originalFetch(input, init);
    };
    // Reload reattach carries its initial recovery inside the pipelined
    // AttachTerminalSession RPC, so the restore hold targets that channel.
  }, IPC.AttachTerminalSession);
}

async function waitForStartupRecoveryFetchHold(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.waitForFunction(() => {
    return (
      (window as Window & { __parallelCodeStartupRecoveryRequested?: boolean })
        .__parallelCodeStartupRecoveryRequested === true
    );
  });
}

async function releaseStartupRecoveryFetchHold(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page
    .evaluate(() => {
      (
        window as Window & { __parallelCodeReleaseStartupRecovery?: () => void }
      ).__parallelCodeReleaseStartupRecovery?.();
    })
    .catch(() => undefined);
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

async function readHasPendingTerminalStartupRecovery(
  page: import('@playwright/test').Page,
): Promise<boolean> {
  const statuses = await readTerminalStatuses(page);
  return statuses.some((status) => status === 'attaching' || status === 'restoring');
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

async function waitForWidthChurnLogicalRows(
  page: Parameters<typeof getOutputDiagnostics>[0],
  agentId: string,
  expectedRows: readonly string[],
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = getTerminalRenderStateSnapshot(agentId, await getOutputDiagnostics(page));
      if (!snapshot) {
        return null;
      }

      const actualRows = normalizeWidthChurnLogicalRows(snapshot.currentVisibleLines);
      if (hasExpectedWidthChurnRows(actualRows, expectedRows)) {
        return expectedRows;
      }
      return actualRows;
    })
    .toEqual(expectedRows);
}

function hasExpectedWidthChurnRows(
  actualRows: readonly string[],
  expectedRows: readonly string[],
): boolean {
  if (actualRows.length === expectedRows.length) {
    return actualRows.every((row, index) => row === expectedRows[index]);
  }

  if (actualRows.length < expectedRows.length) {
    return false;
  }

  const suffixStart = actualRows.length - expectedRows.length;
  return expectedRows.every((row, index) => actualRows[suffixStart + index] === row);
}

async function readTerminalPanelWidth(
  page: Parameters<typeof getOutputDiagnostics>[0],
  terminalIndex: number,
): Promise<number> {
  const box = await page.locator('[data-terminal-status]').nth(terminalIndex).boundingBox();
  expect(box).not.toBeNull();
  return box?.width ?? 0;
}

async function getVisibleHardwareCursorCount(
  page: import('@playwright/test').Page,
  agentId: string,
): Promise<number> {
  return page.evaluate((currentAgentId) => {
    function isVisibleElement(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') !== 0
      );
    }

    const terminal =
      Array.from(document.querySelectorAll('[data-terminal-agent-id]')).find(
        (element) => element.getAttribute('data-terminal-agent-id') === currentAgentId,
      ) ?? null;
    if (!terminal) {
      return -1;
    }

    return Array.from(
      terminal.querySelectorAll('.xterm-cursor, .xterm-cursor-block, .xterm-cursor-outline'),
    ).filter(isVisibleElement).length;
  }, agentId);
}

async function waitForVisibleHardwareCursorCount(
  page: import('@playwright/test').Page,
  agentId: string,
  expectedCount: number,
): Promise<void> {
  await expect.poll(() => getVisibleHardwareCursorCount(page, agentId)).toBe(expectedCount);
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

function createHiddenCursorTuiFixtureCommand(): string {
  return [
    `node -e '`,
    `process.stdout.write("\\x1b[?1049h\\x1b[?25l\\x1b[2J\\x1b[H");`,
    `process.stdout.write("TUI_HIDE_CURSOR_READY\\n");`,
    `process.stdout.write("\\x1b[10;1Hinput> TUI cursor \\x1b[7m \\x1b[27m");`,
    `setInterval(() => {}, 1000);`,
    `'`,
  ].join('');
}

function createWrappedHistoryFixtureCommand(options: {
  completionMarker: string;
  lineCount: number;
  lineWidth: number;
}): string {
  const markerExpression = createShellEchoSafeJavaScriptStringExpression(options.completionMarker);
  return [
    `node -e '`,
    `process.stdout.write("\\x1b[2J\\x1b[H");`,
    `for (let i = 1; i <= ${options.lineCount}; i += 1) {`,
    `  const prefix = "WRAP_ROW_" + String(i).padStart(3, "0") + "_";`,
    `  process.stdout.write(prefix + String(i % 10).repeat(${options.lineWidth}) + "\\n");`,
    `}`,
    `process.stdout.write(${markerExpression} + "\\n");`,
    `'`,
  ].join('');
}

function createLargeScrollbackFixtureCommand(options: {
  completionMarker: string;
  line: string;
  lineCount: number;
}): string {
  const markerExpression = createShellEchoSafeJavaScriptStringExpression(options.completionMarker);
  return [
    `node -e '`,
    `const line = ${JSON.stringify(`${options.line}\n`)};`,
    `const chunkSize = 1000;`,
    `for (let i = 0; i < ${options.lineCount}; i += chunkSize) {`,
    `  process.stdout.write(line.repeat(Math.min(chunkSize, ${options.lineCount} - i)));`,
    `}`,
    `process.stdout.write(${markerExpression} + "\\n");`,
    `'`,
  ].join('');
}

function createShellEchoSafeJavaScriptStringExpression(value: string): string {
  const splitIndex = Math.max(1, Math.floor(value.length / 2));
  const firstHalf = value.slice(0, splitIndex);
  const secondHalf = value.slice(splitIndex);
  return `${JSON.stringify(firstHalf)} + ${JSON.stringify(secondHalf)}`;
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
    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      browserLab.server.agentId,
      'write warm reload restore fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: browserLab.server.agentId,
      data: 'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_LINE_${i}`)\n',
    });
    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, 'RESTORE_LINE_119');

    await page.reload();
    await waitForAppShellVisible(page);
    await page
      .locator('textarea[aria-label="Terminal input"]')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 });
    await browserLab.waitForTerminalReady(page);

    await browserLab.runInTerminal(page, 'console.log("RESTORE_AFTER_RELOAD")');
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'RESTORE_AFTER_RELOAD',
      15_000,
    );

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
    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      browserLab.server.agentId,
      'write reload restore input race fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: browserLab.server.agentId,
      data: 'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_RACE_LINE_${i}`)\n',
    });
    await browserLab.waitForAgentScrollback(
      request,
      browserLab.server.agentId,
      'RESTORE_RACE_LINE_119',
    );

    await installStartupRecoveryFetchHold(page);
    const marker = 'RESTORE_TYPED_DURING_RECOVERY';
    try {
      await page.reload();
      await waitForAppShellVisible(page);
      await waitForStartupRecoveryFetchHold(page);
      await expect
        .poll(() => readHasPendingTerminalStartupRecovery(page), { timeout: 5_000 })
        .toBe(true);
      const terminalInput = page.locator('textarea[aria-label="Terminal input"]').first();
      await terminalInput.waitFor({ state: 'attached' });
      await terminalInput.focus();

      await page.keyboard.type('"RESTORE_TYPED_" + "DURING_RECOVERY"', {
        delay: 20,
      });
      await page.keyboard.press('Enter');
    } finally {
      await releaseStartupRecoveryFetchHold(page);
    }

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
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
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
      typeDelayMs: 60,
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
    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      browserLab.server.agentId,
      'write reload resize restore fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: browserLab.server.agentId,
      data: 'for (let i = 0; i < 120; i += 1) console.log(`RESTORE_RESIZE_${i}`)\n',
    });
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

    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      shellAgentId,
      'write large scrollback fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: `${createLargeScrollbackFixtureCommand({
        completionMarker: '__BIG_SCROLLBACK_DONE__',
        line: '12345678901234567890',
        lineCount: 150000,
      })}\r`,
    });
    await browserLab.waitForAgentScrollback(
      request,
      shellAgentId,
      '__BIG_SCROLLBACK_DONE__',
      LARGE_SCROLLBACK_FIXTURE_WAIT_TIMEOUT_MS,
    );
    await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 20_000);
    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      shellAgentId,
      'verify large scrollback shell prompt readiness',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: 'printf "__BIG_SCROLLBACK_%s__\\n" "READY"\r',
    });
    await browserLab.waitForAgentScrollback(
      request,
      shellAgentId,
      '__BIG_SCROLLBACK_READY__',
      20_000,
    );
    await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 20_000);

    for (const cycle of [1, 2, 3]) {
      await page.reload();
      await waitForAppShellVisible(page);
      await browserLab.waitForTerminalReady(page, shellTerminalIndex);
      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 20_000);
      const replayTraceEntries = await readTerminalReplayTrace(page);
      const shellAttachReplay = replayTraceEntries.find(
        (entry) => entry.agentId === shellAgentId && entry.reason === 'attach',
      );
      expect(shellAttachReplay).toBeTruthy();
      expect(shellAttachReplay?.waitForOutputIdleMs ?? Infinity).toBeLessThan(250);

      const marker = `__AFTER_BIG_SCROLLBACK_RELOAD_${cycle}__`;
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'write large scrollback reload marker',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `printf "${marker}\\n"\r`,
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

      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'write large scrollback resize fixture',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `${createLargeScrollbackFixtureCommand({
          completionMarker: '__BIG_SCROLLBACK_RESIZE_DONE__',
          line: '12345678901234567890',
          lineCount: 100000,
        })}\r`,
      });
      await browserLab.waitForAgentScrollback(
        request,
        shellAgentId,
        '__BIG_SCROLLBACK_RESIZE_DONE__',
        LARGE_SCROLLBACK_FIXTURE_WAIT_TIMEOUT_MS,
      );
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 20_000);
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'verify large scrollback resize shell prompt readiness',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: 'printf "__BIG_SCROLLBACK_RESIZE_%s__\\n" "READY"\r',
      });
      await browserLab.waitForAgentScrollback(
        request,
        shellAgentId,
        '__BIG_SCROLLBACK_RESIZE_READY__',
        20_000,
      );
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 20_000);

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

      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
      const postRestoreMarker = '__BIG_SCROLLBACK_RESIZE_POST_RESTORE__';
      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'write large scrollback post-restore resize marker',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `printf "${postRestoreMarker}\\n"\r`,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, postRestoreMarker, 10_000);
      await dragTerminalPanelResizeHandle(page, shellTerminalIndex, 80);
      await expect
        .poll(
          async () => {
            const diagnostics = await getOutputDiagnostics(page);
            return getTerminalOutputEntry(diagnostics, shellAgentId)?.render.resizeEvents ?? 0;
          },
          {
            message: 'restored terminal should record a resize after it is interactive',
            timeout: 5_000,
          },
        )
        .toBeGreaterThan(0);

      const replayTraceEntries = await readTerminalReplayTrace(page);
      const shellAttachReplay = replayTraceEntries.find(
        (entry) => entry.agentId === shellAgentId && entry.reason === 'attach',
      );
      const outputDiagnostics = await getOutputDiagnostics(page);
      const rendererDiagnostics = await getRendererDiagnostics(page);
      const terminal = getTerminalOutputEntry(outputDiagnostics, shellAgentId);
      const snapshotFallbackCount = rendererDiagnostics?.terminalRecovery.kindCounts.snapshot ?? 0;
      expect(shellAttachReplay).toBeTruthy();
      expect(shellAttachReplay?.waitForOutputIdleMs ?? Infinity).toBeLessThanOrEqual(50);
      expect(shellAttachReplay?.requestStateBytes ?? Infinity).toBeLessThanOrEqual(131_072);
      expect(terminal?.render.resizeEvents ?? 0).toBeGreaterThan(0);
      expect(rendererDiagnostics?.terminalResize.commitDeferredCounts['peer-controlled'] ?? 0).toBe(
        0,
      );
      expect(snapshotFallbackCount).toBeLessThanOrEqual(1);
      expect(
        rendererDiagnostics?.terminalRecovery.geometryAlignmentFallbacks ?? 0,
      ).toBeLessThanOrEqual(1);
      await assertNoVisibleRecoveryChurn(page, browserLab, shellTerminalIndex);
      await assertNoTerminalAnomalies(page);
      assertTerminalRenderWithinBudget(terminal, {
        maxChangedVisibleLinesP95: snapshotFallbackCount > 0 ? 80 : 6,
        ...(snapshotFallbackCount > 0 ? {} : { maxCursorRowJumpP95: 4 }),
        maxResizeEvents: 8,
        ...(snapshotFallbackCount > 0 ? {} : { maxViewportJumpRowsP95: 0 }),
      });
      assertTerminalDiagnosticsWithinBudget(
        await captureTerminalDiagnostics(page, browserLab, request),
        {
          maxBackendSnapshotResponses: snapshotFallbackCount > 0 ? 1 : 0,
          maxQueuedQueueAgeP95Ms: 48,
          maxRenderRefreshes: 0,
          maxTerminalsWithAnomalies: 0,
          maxTotalAnomalies: 0,
          maxVisibleSteadyStateSnapshots: 1,
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
    await page.locator('[data-terminal-status]').nth(backgroundShellIndex).scrollIntoViewIfNeeded();
    await browserLab.waitForTerminalReady(page, backgroundShellIndex, {
      requireLiveRenderReady: false,
    });

    const marker = '__RELOAD_FOCUS_STABLE__';
    await browserLab.typeInTerminal(page, `printf "${marker}\\n"`, {
      terminalIndex: focusedShellIndex,
    });
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

    let shellTaskId = browserLab.server.taskId;
    for (const cycle of [1, 2, 3, 4, 5]) {
      await standbyPage.bringToFront();

      const backgroundDoneMarker = `__BACKGROUND_SWITCH_DONE_${cycle}__`;
      shellTaskId = await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'write background switch stress output',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `yes "SWITCH_${cycle}" | head -n 20000; printf "${backgroundDoneMarker}\\n"\n`,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, backgroundDoneMarker, 20_000);
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);

      await page.bringToFront();
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);
      await assertInteractiveTerminalLifecycleInvariants(browserLab, request, page, shellTaskId, {
        terminalIndex: shellTerminalIndex,
      });
      const foregroundMarker = `__AFTER_BACKGROUND_SWITCH_${cycle}__`;
      await browserLab.runInTerminal(page, `printf "${foregroundMarker}\\n"`, {
        terminalIndex: shellTerminalIndex,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, foregroundMarker, 15_000);
      await expect(getTerminalLoadingOverlay(page)).toHaveCount(0);
      await assertInteractiveTerminalLifecycleInvariants(browserLab, request, page, shellTaskId, {
        requireDocumentFocus: true,
        terminalIndex: shellTerminalIndex,
      });
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
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
    await browserLab.focusTerminal(page, shellTerminalIndex);

    const targetVisibleLine = 'WRAP_ROW_090_';
    const baselineMarker = '__WIDTH_CHURN_BASELINE__';
    const reconnectMarker = '__WIDTH_CHURN_RECONNECT__';
    const fixtureLineCount = 96;
    const fixtureLineWidth = 160;

    const shellTaskId = await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      shellAgentId,
      'write width churn baseline fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: `${createWrappedHistoryFixtureCommand({
        completionMarker: baselineMarker,
        lineCount: fixtureLineCount,
        lineWidth: fixtureLineWidth,
      })}\n`,
    });
    await browserLab.waitForAgentScrollback(request, shellAgentId, baselineMarker, 20_000);
    await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

    await dragTerminalPanelResizeHandle(page, shellTerminalIndex, -160);
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);

    const baselineSnapshot = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      targetLineIncludes: targetVisibleLine,
    });
    const baselinePanelWidth = await readTerminalPanelWidth(page, shellTerminalIndex);

    await dragTerminalPanelResizeHandle(page, shellTerminalIndex, 160);
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

    await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);
    await page.evaluate(() => {
      window.__parallelCodeRendererRuntimeDiagnostics?.reset();
      window.__parallelCodeBrowserTransportForTests__?.disconnect();
    });
    await expect
      .poll(() => browserLab.readConnectionBannerHistory(page), { timeout: 10_000 })
      .toContain('disconnected');

    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      shellAgentId,
      'write width churn reconnect stress output',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: `${createWrappedHistoryFixtureCommand({
        completionMarker: reconnectMarker,
        lineCount: fixtureLineCount,
        lineWidth: fixtureLineWidth,
      })}\n`,
    });
    await browserLab.waitForAgentScrollback(request, shellAgentId, reconnectMarker, 20_000);
    await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);

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
    const postChurnPanelWidth = await readTerminalPanelWidth(page, shellTerminalIndex);
    const baselineWidthCorrection = baselinePanelWidth - postChurnPanelWidth;
    if (Math.abs(baselineWidthCorrection) >= 8) {
      await dragTerminalPanelResizeHandle(page, shellTerminalIndex, baselineWidthCorrection);
      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
    }
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

    await waitForWidthChurnLogicalRows(
      page,
      shellAgentId,
      normalizeWidthChurnLogicalRows(baselineSnapshot.currentVisibleLines),
    );

    await assertInteractiveTerminalLifecycleInvariants(browserLab, request, page, shellTaskId, {
      requireDocumentFocus: true,
      terminalIndex: shellTerminalIndex,
    });
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
      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
      await browserLab.focusTerminal(page, shellTerminalIndex);

      const targetVisibleLine = 'WRAP_ROW_090_';
      const baselineMarker = '__WIDTH_CHURN_RELOAD_BASELINE__';
      const fixtureLineCount = 96;
      const fixtureLineWidth = 160;

      await browserLab.retainSessionAgentTaskCommandLease(
        request,
        page,
        shellAgentId,
        'write width churn reload baseline fixture',
      );
      await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
        agentId: shellAgentId,
        data: `${createWrappedHistoryFixtureCommand({
          completionMarker: baselineMarker,
          lineCount: fixtureLineCount,
          lineWidth: fixtureLineWidth,
        })}\n`,
      });
      await browserLab.waitForAgentScrollback(request, shellAgentId, baselineMarker, 20_000);
      await waitForAgentNotFlowControlled(browserLab, request, shellAgentId, 10_000);
      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

      await dragTerminalPanelResizeHandle(page, shellTerminalIndex, -160);
      await browserLab.waitForTerminalReady(page, shellTerminalIndex);

      const baselineSnapshot = await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
        targetLineIncludes: targetVisibleLine,
      });
      const baselinePanelWidth = await readTerminalPanelWidth(page, shellTerminalIndex);

      await dragTerminalPanelResizeHandle(page, shellTerminalIndex, 160);
      await browserLab.waitForTerminalReady(page, shellTerminalIndex);
      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

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
      const postChurnPanelWidth = await readTerminalPanelWidth(page, shellTerminalIndex);
      const baselineWidthCorrection = baselinePanelWidth - postChurnPanelWidth;
      if (Math.abs(baselineWidthCorrection) >= 8) {
        await dragTerminalPanelResizeHandle(page, shellTerminalIndex, baselineWidthCorrection);
        await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);
      }
      await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

      await waitForWidthChurnLogicalRows(
        page,
        shellAgentId,
        normalizeWidthChurnLogicalRows(baselineSnapshot.currentVisibleLines),
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
      expect(
        rendererDiagnostics?.terminalRecovery.geometryAlignmentFallbacks ?? 0,
      ).toBeLessThanOrEqual(2);
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
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      shellAgentId,
      'write cursor-addressed restore fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: `${createCursorAddressedFixtureCommand({
        lineCount: 30,
        targetColumn: 10,
        targetLabel: 'CURSOR_TARGET',
        targetRow: 5,
      })}\n`,
    });

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

  test('preserves hidden hardware cursor state across reload restore', async ({
    browser,
    browserLab,
    request,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Hidden Cursor Restore Tester',
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
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      shellAgentId,
      'write hidden cursor restore fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: `${createHiddenCursorTuiFixtureCommand()}\n`,
    });

    await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      firstVisibleLine: 'TUI_HIDE_CURSOR_READY',
      targetLineIncludes: 'input> TUI cursor',
    });
    await waitForVisibleHardwareCursorCount(page, shellAgentId, 0);

    await page.reload();
    await waitForAppShellVisible(page);
    await browserLab.waitForTerminalReady(page, shellTerminalIndex);

    await waitForTerminalRenderStateSnapshot(page, shellAgentId, {
      firstVisibleLine: 'TUI_HIDE_CURSOR_READY',
      targetLineIncludes: 'input> TUI cursor',
    });
    await waitForVisibleHardwareCursorCount(page, shellAgentId, 0);
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
    await browserLab.waitForTerminalInteractiveReady(page, shellTerminalIndex);

    await browserLab.retainSessionAgentTaskCommandLease(
      request,
      page,
      shellAgentId,
      'write scrolled cursor restore fixture',
    );
    await browserLab.invokeSessionIpc(request, page, IPC.WriteToAgent, {
      agentId: shellAgentId,
      data: `${[
        `node -e '`,
        `for (let i = 1; i <= 80; i += 1) {`,
        `  process.stdout.write("SCROLL_ROW_" + String(i).padStart(2, "0") + "\\n");`,
        `}`,
        `setTimeout(() => {}, 30000);`,
        `'`,
      ].join('')}\n`,
    });

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
