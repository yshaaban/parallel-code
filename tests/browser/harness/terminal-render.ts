import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';

import { IPC } from '../../../electron/ipc/channels.js';
import type { UiFluidityDiagnosticsSnapshot } from '../../../src/app/ui-fluidity-diagnostics.js';
import type { TerminalAnomalyMonitorSnapshot } from '../../../src/app/terminal-anomaly-monitor.js';
import type { BackendRuntimeDiagnosticsSnapshot } from '../../../electron/ipc/runtime-diagnostics.js';
import type { RendererRuntimeDiagnosticsSnapshot } from '../../../src/app/runtime-diagnostics.js';
import type { TerminalOutputDiagnosticsSnapshot } from '../../../src/lib/terminal-output-diagnostics.js';
import {
  expect,
  getTerminalLoadingOverlay,
  type BrowserLabLifecycleSnapshot,
  type BrowserLabTerminalDiagnosticsSnapshot,
  type BrowserLabTerminalSnapshot,
} from './fixtures.js';

export interface BrowserLabRenderHarness {
  openSession: (
    browser: Browser,
    options?: {
      displayName?: string;
      path?: string;
      prepareContext?: (context: BrowserContext) => Promise<void> | void;
    },
  ) => Promise<{
    context: BrowserContext;
    page: Page;
  }>;
  readLifecycleSnapshot: (page: Page) => Promise<BrowserLabLifecycleSnapshot>;
  readTerminalStatusHistory: (page: Page, terminalIndex?: number) => Promise<string[]>;
  invokeIpc: <TResult>(
    request: APIRequestContext,
    channel: IPC,
    body?: unknown,
  ) => Promise<TResult>;
}

interface DiagnosticSessionOptions {
  displayName?: string;
  path?: string;
}

export interface BrowserLabTerminalDiagnosticsExportSnapshot {
  browserLifecycleSnapshot: BrowserLabLifecycleSnapshot;
  pageDiagnostics: BrowserLabTerminalDiagnosticsSnapshot;
}

export interface CapturedTerminalDiagnostics {
  backendDiagnostics: BackendRuntimeDiagnosticsSnapshot;
  browserSnapshot: BrowserLabTerminalDiagnosticsExportSnapshot;
}

export interface TerminalDiagnosticsBudget {
  maxBackendSnapshotResponses?: number;
  maxFocusedQueueAgeP95Ms?: number;
  maxOverBudget50Frames?: number;
  maxQueuedQueueAgeP95Ms?: number;
  maxRenderRefreshes?: number;
  maxSuppressedBytesP95?: number;
  maxTerminalsWithAnomalies?: number;
  maxTotalAnomalies?: number;
  maxVisibleSteadyStateSnapshots?: number;
}

export async function openDiagnosticSession(
  browser: Browser,
  browserLab: BrowserLabRenderHarness,
  options: DiagnosticSessionOptions = {},
): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const displayName = options.displayName ?? 'Browser Lab Terminal Stress Tester';
  return browserLab.openSession(browser, {
    displayName,
    path: options.path,
    prepareContext: async (context) => {
      await context.addInitScript((currentDisplayName) => {
        window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
        window.__PARALLEL_CODE_TERMINAL_ANOMALY_MONITOR__ = true;
        window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ = true;
        window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
        if (currentDisplayName) {
          window.localStorage.setItem('parallel-code-display-name', currentDisplayName);
        }
      }, displayName);
    },
  });
}

export async function getRendererDiagnostics(
  page: Page,
): Promise<RendererRuntimeDiagnosticsSnapshot | null> {
  return page.evaluate(() => {
    return window.__parallelCodeRendererRuntimeDiagnostics?.getSnapshot() ?? null;
  });
}

export async function getUiFluidityDiagnostics(
  page: Page,
): Promise<UiFluidityDiagnosticsSnapshot | null> {
  return page.evaluate(() => {
    return window.__parallelCodeUiFluidityDiagnostics?.getSnapshot() ?? null;
  });
}

export async function getOutputDiagnostics(
  page: Page,
): Promise<TerminalOutputDiagnosticsSnapshot | null> {
  return page.evaluate(() => {
    return window.__parallelCodeTerminalOutputDiagnostics?.getSnapshot() ?? null;
  });
}

export async function getTerminalAnomalySnapshot(
  page: Page,
): Promise<TerminalAnomalyMonitorSnapshot | null> {
  return page.evaluate(() => {
    return window.__parallelCodeTerminalAnomalyMonitor?.getSnapshot() ?? null;
  });
}

export async function getTerminalDiagnosticsSnapshot(
  page: Page,
): Promise<BrowserLabTerminalDiagnosticsSnapshot | null> {
  return page.evaluate(() => {
    return window.__parallelCodeTerminalDiagnostics?.getSnapshot() ?? null;
  });
}

export async function captureTerminalDiagnosticsSnapshot(
  page: Page,
  browserLab: Pick<BrowserLabRenderHarness, 'readLifecycleSnapshot'>,
): Promise<BrowserLabTerminalDiagnosticsExportSnapshot> {
  const pageDiagnostics =
    (await getTerminalDiagnosticsSnapshot(page)) ?? (await buildTerminalDiagnosticsSnapshot(page));
  return {
    browserLifecycleSnapshot: await browserLab.readLifecycleSnapshot(page),
    pageDiagnostics,
  };
}

export async function captureTerminalDiagnostics(
  page: Page,
  browserLab: Pick<BrowserLabRenderHarness, 'invokeIpc' | 'readLifecycleSnapshot'>,
  request: APIRequestContext,
): Promise<CapturedTerminalDiagnostics> {
  const [backendDiagnostics, browserSnapshot] = await Promise.all([
    getBackendDiagnostics(browserLab, request),
    captureTerminalDiagnosticsSnapshot(page, browserLab),
  ]);

  return {
    backendDiagnostics,
    browserSnapshot,
  };
}

export async function captureTerminalDiagnosticsSnapshotJson(
  page: Page,
  browserLab: Pick<BrowserLabRenderHarness, 'readLifecycleSnapshot'>,
): Promise<string> {
  return formatTerminalDiagnosticsSnapshot(
    await captureTerminalDiagnosticsSnapshot(page, browserLab),
  );
}

export function formatTerminalDiagnosticsSnapshot(
  snapshot: BrowserLabTerminalDiagnosticsExportSnapshot,
): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

async function buildTerminalDiagnosticsSnapshot(
  page: Page,
): Promise<BrowserLabTerminalDiagnosticsSnapshot> {
  const [anomalySnapshot, outputDiagnostics, rendererDiagnostics, terminalSnapshots, uiFluidity] =
    await Promise.all([
      getTerminalAnomalySnapshot(page),
      getOutputDiagnostics(page),
      getRendererDiagnostics(page),
      readTerminalSnapshots(page),
      getUiFluidityDiagnostics(page),
    ]);

  return {
    anomalySnapshot,
    capturedAtMs: Date.now(),
    outputDiagnostics,
    pageLifecycle: {
      banner: [],
      events: [],
    },
    rendererDiagnostics,
    terminalSnapshots,
    uiFluidityDiagnostics: uiFluidity,
  };
}

async function readTerminalSnapshots(page: Page): Promise<BrowserLabTerminalSnapshot[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-terminal-status]')).map((statusElement) => ({
      agentId: statusElement.getAttribute('data-terminal-agent-id'),
      cursorBlink: statusElement.getAttribute('data-terminal-cursor-blink') === 'true',
      liveRenderReady: statusElement.getAttribute('data-terminal-live-render-ready') === 'true',
      loadingOverlayVisible:
        statusElement.querySelector('[data-terminal-loading-overlay="true"]') instanceof
        HTMLElement,
      presentationMode: statusElement.getAttribute('data-terminal-presentation-mode'),
      renderHibernating: statusElement.getAttribute('data-terminal-render-hibernating') === 'true',
      restoreBlocked: statusElement.getAttribute('data-terminal-restore-blocked') === 'true',
      status: statusElement.getAttribute('data-terminal-status'),
      surfaceTier: statusElement.getAttribute('data-terminal-surface-tier'),
    }));
  });
}

export async function getBackendDiagnostics(
  browserLab: Pick<BrowserLabRenderHarness, 'invokeIpc'>,
  request: APIRequestContext,
): Promise<BackendRuntimeDiagnosticsSnapshot> {
  return browserLab.invokeIpc<BackendRuntimeDiagnosticsSnapshot>(
    request,
    IPC.GetBackendRuntimeDiagnostics,
  );
}

export async function assertNoVisibleRecoveryChurn(
  page: Page,
  browserLab: Pick<BrowserLabRenderHarness, 'readTerminalStatusHistory'>,
  terminalIndex = 0,
): Promise<void> {
  await expect(getTerminalLoadingOverlay(page, terminalIndex)).toHaveCount(0);

  const terminalStatusHistory = await browserLab.readTerminalStatusHistory(page, terminalIndex);
  expect(terminalStatusHistory).not.toContain('restoring');
}

export function listTerminalAnomalies(snapshot: TerminalAnomalyMonitorSnapshot | null): string[] {
  if (snapshot === null) {
    return ['terminal-anomaly-monitor:missing'];
  }

  const anomalies: string[] = [];
  if (snapshot.summary.totalAnomalies > 0) {
    anomalies.push(`summary-total-anomalies:${snapshot.summary.totalAnomalies}`);
  }
  if (snapshot.summary.terminalsWithAnomalies > 0) {
    anomalies.push(`summary-terminals-with-anomalies:${snapshot.summary.terminalsWithAnomalies}`);
  }

  for (const terminal of snapshot.terminals) {
    for (const anomaly of terminal.anomalies) {
      anomalies.push(`${terminal.agentId}:${anomaly.key}:${anomaly.severity}`);
    }
  }

  return anomalies;
}

function getVisibleSteadyStateSnapshotCount(
  rendererDiagnostics: RendererRuntimeDiagnosticsSnapshot,
): number {
  const counts = rendererDiagnostics.terminalRecovery.visibleSteadyStateSnapshotCounts;
  return counts.attach + counts.backpressure + counts.hibernate + counts.reconnect;
}

export async function assertNoTerminalAnomalies(
  page: Page,
): Promise<TerminalAnomalyMonitorSnapshot> {
  const snapshot = await getTerminalAnomalySnapshot(page);
  expect(listTerminalAnomalies(snapshot)).toEqual([]);
  return snapshot as TerminalAnomalyMonitorSnapshot;
}

export function assertTerminalDiagnosticsWithinBudget(
  diagnostics: CapturedTerminalDiagnostics,
  budget: TerminalDiagnosticsBudget,
): void {
  const { backendDiagnostics, browserSnapshot } = diagnostics;
  const anomalySnapshot = browserSnapshot.pageDiagnostics
    .anomalySnapshot as TerminalAnomalyMonitorSnapshot | null;
  const rendererDiagnostics = browserSnapshot.pageDiagnostics
    .rendererDiagnostics as RendererRuntimeDiagnosticsSnapshot | null;
  const uiFluidityDiagnostics = browserSnapshot.pageDiagnostics.uiFluidityDiagnostics as
    | UiFluidityDiagnosticsSnapshot
    | null
    | undefined;

  expect(anomalySnapshot).not.toBeNull();
  expect(rendererDiagnostics).not.toBeNull();
  expect(uiFluidityDiagnostics).not.toBeNull();
  if (!anomalySnapshot || !rendererDiagnostics || !uiFluidityDiagnostics) {
    return;
  }

  if (budget.maxTotalAnomalies !== undefined) {
    expect(anomalySnapshot.summary.totalAnomalies).toBeLessThanOrEqual(budget.maxTotalAnomalies);
  }
  if (budget.maxTerminalsWithAnomalies !== undefined) {
    expect(anomalySnapshot.summary.terminalsWithAnomalies).toBeLessThanOrEqual(
      budget.maxTerminalsWithAnomalies,
    );
  }
  if (budget.maxRenderRefreshes !== undefined) {
    expect(rendererDiagnostics.terminalRecovery.renderRefreshes).toBeLessThanOrEqual(
      budget.maxRenderRefreshes,
    );
  }
  if (budget.maxVisibleSteadyStateSnapshots !== undefined) {
    expect(getVisibleSteadyStateSnapshotCount(rendererDiagnostics)).toBeLessThanOrEqual(
      budget.maxVisibleSteadyStateSnapshots,
    );
  }
  if (budget.maxBackendSnapshotResponses !== undefined) {
    expect(backendDiagnostics.terminalRecovery.snapshotResponses).toBeLessThanOrEqual(
      budget.maxBackendSnapshotResponses,
    );
  }
  if (budget.maxFocusedQueueAgeP95Ms !== undefined) {
    expect(uiFluidityDiagnostics.terminalOutputPerFrame.focusedQueueAgeMs.p95).toBeLessThanOrEqual(
      budget.maxFocusedQueueAgeP95Ms,
    );
  }
  if (budget.maxQueuedQueueAgeP95Ms !== undefined) {
    expect(uiFluidityDiagnostics.terminalOutputPerFrame.queuedQueueAgeMs.p95).toBeLessThanOrEqual(
      budget.maxQueuedQueueAgeP95Ms,
    );
  }
  if (budget.maxSuppressedBytesP95 !== undefined) {
    expect(uiFluidityDiagnostics.terminalOutputPerFrame.suppressedBytes.p95).toBeLessThanOrEqual(
      budget.maxSuppressedBytesP95,
    );
  }
  if (budget.maxOverBudget50Frames !== undefined) {
    expect(uiFluidityDiagnostics.frames.overBudget50ms).toBeLessThanOrEqual(
      budget.maxOverBudget50Frames,
    );
  }
}

export async function getTerminalPresentationMode(
  page: Page,
  terminalIndex = 0,
): Promise<string | null> {
  return page
    .locator('[data-terminal-status]')
    .nth(terminalIndex)
    .getAttribute('data-terminal-presentation-mode');
}

export async function getTerminalSurfaceTier(
  page: Page,
  terminalIndex = 0,
): Promise<string | null> {
  return page
    .locator('[data-terminal-status]')
    .nth(terminalIndex)
    .getAttribute('data-terminal-surface-tier');
}

export async function beginTerminalPresentationModeHistory(
  page: Page,
  terminalIndex = 0,
): Promise<void> {
  await page.evaluate((index) => {
    const win = window as typeof window & {
      __parallelCodeTerminalPresentationModeHistory__?: Array<string | null>;
      __parallelCodeTerminalPresentationModeObserver__?: MutationObserver;
    };
    win.__parallelCodeTerminalPresentationModeObserver__?.disconnect();
    const terminal = document.querySelectorAll('[data-terminal-status]')[index] as
      | HTMLElement
      | undefined;
    if (!terminal) {
      win.__parallelCodeTerminalPresentationModeHistory__ = [];
      return;
    }

    const history: Array<string | null> = [
      terminal.getAttribute('data-terminal-presentation-mode'),
    ];
    const observer = new MutationObserver(() => {
      history.push(terminal.getAttribute('data-terminal-presentation-mode'));
    });
    observer.observe(terminal, {
      attributeFilter: ['data-terminal-presentation-mode'],
      attributes: true,
    });
    win.__parallelCodeTerminalPresentationModeHistory__ = history;
    win.__parallelCodeTerminalPresentationModeObserver__ = observer;
  }, terminalIndex);
}

export async function readTerminalPresentationModeHistory(
  page: Page,
): Promise<Array<string | null>> {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __parallelCodeTerminalPresentationModeHistory__?: Array<string | null>;
      __parallelCodeTerminalPresentationModeObserver__?: MutationObserver;
    };
    win.__parallelCodeTerminalPresentationModeObserver__?.disconnect();
    return [...(win.__parallelCodeTerminalPresentationModeHistory__ ?? [])];
  });
}

export async function beginTerminalAttributeHistory(
  page: Page,
  attributeName: string,
  terminalIndex = 0,
): Promise<void> {
  await page.evaluate(
    ({ attributeName: nextAttributeName, index }) => {
      const win = window as typeof window & {
        __parallelCodeTerminalAttributeHistory__?: Record<string, Array<string | null>>;
        __parallelCodeTerminalAttributeObservers__?: Record<string, MutationObserver>;
      };
      const key = `${nextAttributeName}:${index}`;
      win.__parallelCodeTerminalAttributeObservers__ ??= {};
      win.__parallelCodeTerminalAttributeHistory__ ??= {};
      win.__parallelCodeTerminalAttributeObservers__[key]?.disconnect();
      const terminal = document.querySelectorAll('[data-terminal-status]')[index] as
        | HTMLElement
        | undefined;
      if (!terminal) {
        win.__parallelCodeTerminalAttributeHistory__[key] = [];
        return;
      }

      const history: Array<string | null> = [terminal.getAttribute(nextAttributeName)];
      const observer = new MutationObserver(() => {
        history.push(terminal.getAttribute(nextAttributeName));
      });
      observer.observe(terminal, {
        attributeFilter: [nextAttributeName],
        attributes: true,
      });
      win.__parallelCodeTerminalAttributeHistory__[key] = history;
      win.__parallelCodeTerminalAttributeObservers__[key] = observer;
    },
    { attributeName, index: terminalIndex },
  );
}

export async function readTerminalAttributeHistory(
  page: Page,
  attributeName: string,
  terminalIndex = 0,
): Promise<Array<string | null>> {
  return page.evaluate(
    ({ attributeName: nextAttributeName, index }) => {
      const win = window as typeof window & {
        __parallelCodeTerminalAttributeHistory__?: Record<string, Array<string | null>>;
        __parallelCodeTerminalAttributeObservers__?: Record<string, MutationObserver>;
      };
      const key = `${nextAttributeName}:${index}`;
      win.__parallelCodeTerminalAttributeObservers__?.[key]?.disconnect();
      return [...(win.__parallelCodeTerminalAttributeHistory__?.[key] ?? [])];
    },
    { attributeName, index: terminalIndex },
  );
}

export async function dragTerminalPanelResizeHandle(
  page: Page,
  terminalIndex = 0,
  deltaPx = 120,
): Promise<void> {
  const dragTargets = await page.evaluate(
    ({ index }) => {
      const terminal = document.querySelectorAll('[data-terminal-status]')[index] as
        | HTMLElement
        | undefined;
      if (!terminal) {
        return [];
      }

      const terminalRect = terminal.getBoundingClientRect();
      const handles = [...document.querySelectorAll('.resize-handle')].map((handle) => {
        const rect = handle.getBoundingClientRect();
        return {
          axis: handle.classList.contains('resize-handle-v') ? 'vertical' : 'horizontal',
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      });
      const overlappingVerticalHandles = handles.filter((handle) => {
        if (handle.axis !== 'vertical') {
          return false;
        }

        return handle.x < terminalRect.right && handle.x + handle.width > terminalRect.left;
      });
      if (overlappingVerticalHandles.length > 0) {
        return overlappingVerticalHandles
          .sort((leftHandle, rightHandle) => {
            const leftDistance = Math.min(
              Math.abs(leftHandle.y - terminalRect.top),
              Math.abs(leftHandle.y - terminalRect.bottom),
            );
            const rightDistance = Math.min(
              Math.abs(rightHandle.y - terminalRect.top),
              Math.abs(rightHandle.y - terminalRect.bottom),
            );
            return leftDistance - rightDistance;
          })
          .map((handle) => ({
            axis: 'vertical',
            endX: handle.x + handle.width / 2,
            endY: handle.y + handle.height / 2,
            startX: handle.x + handle.width / 2,
            startY: handle.y + handle.height / 2,
          }));
      }

      const overlappingHorizontalHandles = handles
        .filter((handle) => {
          if (handle.axis !== 'horizontal') {
            return false;
          }

          return handle.y < terminalRect.bottom && handle.y + handle.height > terminalRect.top;
        })
        .sort((leftHandle, rightHandle) => {
          const leftDistance = Math.min(
            Math.abs(leftHandle.x - terminalRect.left),
            Math.abs(leftHandle.x - terminalRect.right),
          );
          const rightDistance = Math.min(
            Math.abs(rightHandle.x - terminalRect.left),
            Math.abs(rightHandle.x - terminalRect.right),
          );
          return leftDistance - rightDistance;
        });

      return overlappingHorizontalHandles.map((handle) => ({
        axis: 'horizontal',
        endX: handle.x + handle.width / 2,
        endY: handle.y + handle.height / 2,
        startX: handle.x + handle.width / 2,
        startY: handle.y + handle.height / 2,
      }));
    },
    { index: terminalIndex },
  );

  expect(dragTargets.length).toBeGreaterThan(0);
  for (const dragTarget of dragTargets) {
    const beforeBox = await page.locator('[data-terminal-status]').nth(terminalIndex).boundingBox();
    if (!beforeBox) {
      continue;
    }

    const endX = dragTarget.axis === 'horizontal' ? dragTarget.endX + deltaPx : dragTarget.endX;
    const endY = dragTarget.axis === 'vertical' ? dragTarget.endY + deltaPx : dragTarget.endY;

    await page.mouse.move(dragTarget.startX, dragTarget.startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(90);

    const afterBox = await page.locator('[data-terminal-status]').nth(terminalIndex).boundingBox();
    if (!afterBox) {
      continue;
    }

    const widthChanged = Math.abs(afterBox.width - beforeBox.width) >= 8;
    const heightChanged = Math.abs(afterBox.height - beforeBox.height) >= 8;
    if (widthChanged || heightChanged) {
      return;
    }
  }

  throw new Error(
    `Failed to resize terminal panel ${terminalIndex} with any visible resize handle.`,
  );
}
