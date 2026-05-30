import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';

import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

import { IPC } from '../../electron/ipc/channels.js';
import type { StartupBreadcrumb } from '../../src/app/startup-breadcrumbs.js';
import type { TaskPortSnapshot } from '../../src/domain/server-state.js';
import { expect, test } from './harness/fixtures.js';
import {
  createScorecardRun,
  recordScorecardMetric,
  type ScorecardRun,
  writeScorecardArtifacts,
} from './harness/performance-scorecard.js';
import { createTerminalInputEchoScenario } from './harness/scenarios.js';
import {
  measureTypedTextTrace,
  warmTerminalInputTracing,
} from './harness/terminal-input-tracing.js';
import { getRendererDiagnostics, getUiFluidityDiagnostics } from './harness/terminal-render.js';

const SELECTED_TERMINAL_BUDGET_MS = 1_500;
const APP_SHELL_VISIBLE_BUDGET_MS = 1_200;
const APP_SHELL_TO_TERMINAL_BUDGET_MS = 600;
const RENDERER_SELECTED_TERMINAL_BUDGET_MS = 500;
const TASK_SWITCH_BUDGET_MS = 400;
const TERMINAL_INPUT_P95_BUDGET_MS = 75;
const PREVIEW_NAVIGABLE_BUDGET_MS = 1_000;
const REVIEW_DIFF_OPEN_BUDGET_MS = 500;
const CLEANUP_VISIBLE_BUDGET_MS = 500;
const RECONNECT_SELECTED_SURFACE_BUDGET_MS = 1_000;
const REMOTE_COMMAND_ACK_BUDGET_MS = 500;
const REMOTE_COMMAND_INPUT_VISIBLE_BUDGET_MS = 1_500;
const REMOTE_TAKEOVER_APPROVAL_BUDGET_MS = 500;
const REMOTE_TAKEOVER_PROMPT_BUDGET_MS = 500;
const SCORECARD_REVIEW_FILE_PATH = 'src/scorecard-review.ts';
const SCORECARD_REVIEW_BASELINE = 'export const scorecardReviewValue = "baseline";\n';
const SCORECARD_REVIEW_CHANGED = 'export const scorecardReviewValue = "changed";\n';
const SCORECARD_REVIEW_EXPECTED_TEXT = 'scorecardReviewValue = "changed"';
const SCORECARD_OWNER_CLIENT_ID = 'performance-scorecard-main-client';
const REMOTE_DISPLAY_NAME_STORAGE_KEY = 'parallel-code-display-name';
const REMOTE_CLIENT_ID_STORAGE_KEY = 'parallel-code-remote-client-id';

interface PreviewTargetServer {
  close: () => Promise<void>;
  port: number;
}

interface BrowserScorecardWindow {
  __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
  __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, TerminalAttachTraceEntry>;
  __PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__?: boolean;
  __TERMINAL_PERF__?: boolean;
  __parallelCodeBrowserTransportForTests__?: BrowserTransportForTests;
  __parallelCodeScorecardReviewDiffProbe?: Promise<number>;
  __parallelCodeScorecardTaskCleanupProbe?: Promise<number>;
  __parallelCodeScorecardTaskSwitchProbe?: Promise<number>;
  __parallelCodeStartupBreadcrumbs?: StartupBreadcrumb[];
}

interface BrowserTransportForTests {
  disconnect: () => void;
  ensureConnected: () => Promise<void> | void;
}

interface TerminalAttachTraceEntry {
  agentId: string;
  attachBoundAtMs: number | null;
  attachFitReadyAtMs: number | null;
  attachQueuedAtMs: number;
  attachStartedAtMs: number | null;
  channelReadyAtMs: number | null;
  key: string;
  paintReadyAtMs: number | null;
  readyAtMs: number | null;
  recoverySettledAtMs: number | null;
  recoveryStartedAtMs: number | null;
  selectedInteractiveAtMs: number | null;
  spawnRequestedAtMs: number | null;
  spawnResolvedAtMs: number | null;
  status: string;
  taskId: string;
}

interface BrowserNavigationTimingSnapshot {
  domContentLoadedEventEnd: number;
  domInteractive: number;
  loadEventEnd: number;
  requestStart: number;
  responseEnd: number;
  responseStart: number;
  startTime: number;
}

interface BrowserStartupTrace {
  breadcrumbs: StartupBreadcrumb[];
  navigation: BrowserNavigationTimingSnapshot | null;
  timeOrigin: number;
}

interface BrowserLaunchTimings {
  appShellPaintedAtMs: number;
  selectedTerminalInteractiveAtMs: number;
}

interface TaskSwitchTiming {
  browserMs: number;
  observerMs: number;
}

interface RemoteCommandSessionTiming {
  ownerApprovalToRemoteControlMs: number;
  sendClickToWriteAckMs: number;
  shellToCommandInputMs: number;
  takeoverRequestToOwnerPromptMs: number;
}

interface TaskCommandLeaseAcquireSnapshot {
  acquired: boolean;
  action: string | null;
  controllerId: string | null;
  leaseGeneration: number;
  taskId: string;
  version: number;
}

const terminalInputEchoScenario = createTerminalInputEchoScenario();

const scorecardScenario = {
  ...terminalInputEchoScenario,
  additionalTaskNames: ['Scorecard Switch Target Fixture'],
  name: 'performance-scorecard-smoke',
  async seedRepo(repoDir: string): Promise<void> {
    await terminalInputEchoScenario.seedRepo?.(repoDir);
    writeRepoFile(repoDir, SCORECARD_REVIEW_FILE_PATH, SCORECARD_REVIEW_BASELINE);
    git(repoDir, 'add', SCORECARD_REVIEW_FILE_PATH);
    git(repoDir, 'commit', '-m', 'seed scorecard review file');
  },
  taskGitIsolation: 'current-branch' as const,
  taskName: 'Scorecard Active Fixture',
};

function git(repoDir: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeRepoFile(repoDir: string, relativePath: string, content: string): void {
  const filePath = path.join(repoDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function getRemoteAgentCardName(taskName: string): RegExp {
  return new RegExp(`^Open ${escapeRegExp(taskName)}`, 'u');
}

function prepareScorecardReviewWorktree(repoDir: string): void {
  writeRepoFile(repoDir, SCORECARD_REVIEW_FILE_PATH, SCORECARD_REVIEW_CHANGED);
}

function writeHtml(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': 'scorecard-preview=ready; Path=/; HttpOnly',
  });
  res.end(
    [
      '<html><head><title>Scorecard Preview</title></head>',
      '<body>',
      `<main id="scorecard-preview-root" data-path="${req.url ?? '/'}">Preview ready</main>`,
      '</body></html>',
    ].join(''),
  );
}

function createPreviewTargetServer(): Promise<PreviewTargetServer> {
  const server = createServer((req, res) => {
    writeHtml(req, res);
  });

  return new Promise<PreviewTargetServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Preview target failed to bind to an ephemeral port'));
        return;
      }

      resolve({
        port: address.port,
        close: () => closeHttpServer(server),
      });
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getNowMs(): number {
  return performance.now();
}

function getTaskPanelSelector(taskId: string): string {
  return `[data-task-id="${taskId}"]`;
}

async function installScorecardDiagnostics(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scorecardWindow = window as BrowserScorecardWindow;
    scorecardWindow.__TERMINAL_PERF__ = true;
    scorecardWindow.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ = {};
    scorecardWindow.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ = true;
    scorecardWindow.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
  });
}

async function waitForTaskTerminalInteractive(page: Page, taskId: string): Promise<void> {
  const taskPanel = page.locator(getTaskPanelSelector(taskId));
  const terminal = taskPanel.locator('[data-terminal-status]').first();

  await expect(taskPanel).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => terminal.getAttribute('data-terminal-status')).toBe('ready');
  await expect.poll(() => terminal.getAttribute('data-terminal-paint-ready')).toBe('true');
  await expect
    .poll(async () => (await terminal.getAttribute('data-terminal-restore-blocked')) === 'true')
    .toBe(false);
}

async function waitForAppShellPainted(page: Page): Promise<number> {
  await page.locator('.app-shell').first().waitFor({ state: 'visible', timeout: 10_000 });
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve(performance.now()));
        });
      }),
  );
}

async function readBrowserNowMs(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

async function readBrowserStartupTrace(page: Page): Promise<BrowserStartupTrace> {
  return page.evaluate(() => {
    const scorecardWindow = window as BrowserScorecardWindow;
    const navigationEntry = performance.getEntriesByType('navigation')[0];
    const navigation =
      navigationEntry instanceof PerformanceNavigationTiming
        ? {
            domContentLoadedEventEnd: navigationEntry.domContentLoadedEventEnd,
            domInteractive: navigationEntry.domInteractive,
            loadEventEnd: navigationEntry.loadEventEnd,
            requestStart: navigationEntry.requestStart,
            responseEnd: navigationEntry.responseEnd,
            responseStart: navigationEntry.responseStart,
            startTime: navigationEntry.startTime,
          }
        : null;

    return {
      breadcrumbs: [...(scorecardWindow.__parallelCodeStartupBreadcrumbs ?? [])],
      navigation,
      timeOrigin: performance.timeOrigin,
    };
  });
}

async function readTerminalAttachTraces(page: Page): Promise<TerminalAttachTraceEntry[]> {
  return page.evaluate(() => {
    const scorecardWindow = window as BrowserScorecardWindow;
    return Object.values(scorecardWindow.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ ?? {});
  });
}

function findStartupBreadcrumbAtMs(trace: BrowserStartupTrace, label: string): number | null {
  return trace.breadcrumbs.find((breadcrumb) => breadcrumb.label === label)?.atMs ?? null;
}

function findTerminalAttachTrace(
  traces: readonly TerminalAttachTraceEntry[],
  agentId: string,
): TerminalAttachTraceEntry | null {
  return traces.find((entry) => entry.agentId === agentId) ?? null;
}

function recordTerminalAttachTraceSpanMetric(
  run: ScorecardRun,
  options: {
    endMs: number | null;
    name: string;
    startMs: number | null;
  },
): void {
  if (options.startMs === null || options.endMs === null || options.endMs < options.startMs) {
    return;
  }

  recordScorecardMetric(run, {
    journey: 'browser startup diagnostics',
    name: options.name,
    value: options.endMs - options.startMs,
  });
}

function recordBrowserStartupSpanMetric(
  run: ScorecardRun,
  trace: BrowserStartupTrace,
  options: {
    endLabel?: string;
    endMs?: number;
    name: string;
    startLabel?: string;
    startMs?: number;
  },
): void {
  const startMs =
    options.startMs ??
    (options.startLabel ? findStartupBreadcrumbAtMs(trace, options.startLabel) : null);
  const endMs =
    options.endMs ?? (options.endLabel ? findStartupBreadcrumbAtMs(trace, options.endLabel) : null);
  if (startMs === null || endMs === null || endMs < startMs) {
    return;
  }

  recordScorecardMetric(run, {
    journey: 'browser startup diagnostics',
    name: options.name,
    value: endMs - startMs,
  });
}

function getBrowserLaunchTimings(
  trace: BrowserStartupTrace,
  observedAppShellPaintedAtMs: number,
  observedSelectedTerminalInteractiveAtMs: number,
): BrowserLaunchTimings {
  const appShellPaintedAtMs =
    findStartupBreadcrumbAtMs(trace, 'app-shell:painted') ?? observedAppShellPaintedAtMs;
  const selectedTerminalInteractiveAtMs =
    findStartupBreadcrumbAtMs(trace, 'terminal:selected-interactive') ??
    observedSelectedTerminalInteractiveAtMs;

  if (selectedTerminalInteractiveAtMs < appShellPaintedAtMs) {
    throw new Error(
      'Startup breadcrumbs reported selected terminal readiness before app-shell paint',
    );
  }

  return {
    appShellPaintedAtMs,
    selectedTerminalInteractiveAtMs,
  };
}

function recordBrowserSessionLaunchMetrics(run: ScorecardRun, timings: BrowserLaunchTimings): void {
  recordScorecardMetric(run, {
    budgetMs: SELECTED_TERMINAL_BUDGET_MS,
    journey: 'browser session launch',
    name: 'navigation to selected terminal interactive',
    value: timings.selectedTerminalInteractiveAtMs,
  });
  recordScorecardMetric(run, {
    budgetMs: APP_SHELL_VISIBLE_BUDGET_MS,
    journey: 'browser session launch',
    name: 'navigation to app shell painted',
    value: timings.appShellPaintedAtMs,
  });
  recordScorecardMetric(run, {
    budgetMs: APP_SHELL_TO_TERMINAL_BUDGET_MS,
    journey: 'browser session launch',
    name: 'app shell painted to selected terminal interactive',
    value: timings.selectedTerminalInteractiveAtMs - timings.appShellPaintedAtMs,
  });
}

function recordBrowserStartupDiagnosticMetrics(
  run: ScorecardRun,
  trace: BrowserStartupTrace,
  timings: BrowserLaunchTimings,
): void {
  recordBrowserStartupSpanMetric(run, trace, {
    endMs: timings.appShellPaintedAtMs,
    name: 'browser navigation start to app shell painted browser clock',
    startMs: 0,
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endLabel: 'index:before-render',
    name: 'browser navigation start to index render call',
    startMs: 0,
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endLabel: 'App:enter',
    name: 'index render call to App entry',
    startLabel: 'index:before-render',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endLabel: 'App:onMount:start',
    name: 'App entry to mount start',
    startLabel: 'App:enter',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endLabel: 'desktop-startup:browser-cold-bootstrap-begin',
    name: 'App mount start to browser cold bootstrap begin',
    startLabel: 'App:onMount:start',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endLabel: 'desktop-startup:browser-selected-task',
    name: 'browser cold bootstrap begin to selected task',
    startLabel: 'desktop-startup:browser-cold-bootstrap-begin',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endMs: timings.appShellPaintedAtMs,
    name: 'index render call to app shell painted',
    startLabel: 'index:before-render',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endMs: timings.selectedTerminalInteractiveAtMs,
    name: 'selected task to terminal interactive',
    startLabel: 'desktop-startup:browser-selected-task',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endMs: timings.selectedTerminalInteractiveAtMs,
    name: 'app shell painted to terminal interactive browser clock',
    startMs: timings.appShellPaintedAtMs,
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endLabel: 'terminal-session:module-load-start',
    name: 'app shell painted to terminal session module load start',
    startMs: timings.appShellPaintedAtMs,
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endMs: timings.appShellPaintedAtMs,
    name: 'terminal session module load start to app shell painted',
    startLabel: 'terminal-session:module-load-start',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endLabel: 'terminal-session:module-loaded',
    name: 'terminal session module load',
    startLabel: 'terminal-session:module-load-start',
  });
  recordBrowserStartupSpanMetric(run, trace, {
    endMs: timings.selectedTerminalInteractiveAtMs,
    name: 'terminal session module loaded to selected interactive',
    startLabel: 'terminal-session:module-loaded',
  });

  const navigation = trace.navigation;
  if (navigation) {
    recordScorecardMetric(run, {
      journey: 'browser startup diagnostics',
      name: 'browser request start to response end',
      value: navigation.responseEnd - navigation.requestStart,
    });
    recordScorecardMetric(run, {
      journey: 'browser startup diagnostics',
      name: 'browser response end to DOM interactive',
      value: navigation.domInteractive - navigation.responseEnd,
    });
  }
}

function recordTerminalAttachTraceMetrics(
  run: ScorecardRun,
  traces: readonly TerminalAttachTraceEntry[],
  agentId: string,
): void {
  const trace = findTerminalAttachTrace(traces, agentId);
  if (!trace) {
    return;
  }

  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.attachStartedAtMs,
    name: 'selected terminal attach queue wait',
    startMs: trace.attachQueuedAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.channelReadyAtMs,
    name: 'selected terminal attach start to channel ready',
    startMs: trace.attachStartedAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.attachFitReadyAtMs,
    name: 'selected terminal channel ready to attach fit ready',
    startMs: trace.channelReadyAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.spawnRequestedAtMs,
    name: 'selected terminal attach fit ready to spawn request',
    startMs: trace.attachFitReadyAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.spawnResolvedAtMs,
    name: 'selected terminal spawn request to resolved',
    startMs: trace.spawnRequestedAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.attachBoundAtMs,
    name: 'selected terminal spawn resolved to attach bound',
    startMs: trace.spawnResolvedAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.recoverySettledAtMs,
    name: 'selected terminal attach recovery',
    startMs: trace.recoveryStartedAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.readyAtMs,
    name: 'selected terminal attach bound to logical ready',
    startMs: trace.attachBoundAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.paintReadyAtMs,
    name: 'selected terminal logical ready to paint ready',
    startMs: trace.readyAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.selectedInteractiveAtMs,
    name: 'selected terminal paint ready to selected interactive',
    startMs: trace.paintReadyAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.readyAtMs,
    name: 'selected terminal attach queued to logical ready',
    startMs: trace.attachQueuedAtMs,
  });
  recordTerminalAttachTraceSpanMetric(run, {
    endMs: trace.selectedInteractiveAtMs,
    name: 'selected terminal attach queued to selected interactive',
    startMs: trace.attachQueuedAtMs,
  });
}

async function installTaskSwitchProbe(page: Page, targetTaskId: string): Promise<void> {
  await page.evaluate((nextTargetTaskId) => {
    const scorecardWindow = window as BrowserScorecardWindow;
    scorecardWindow.__parallelCodeScorecardTaskSwitchProbe = new Promise<number>(
      (resolve, reject) => {
        let startedAtMs: number | null = null;
        let rafId: number | undefined;
        let timeoutId: number | undefined;
        const targetTaskSelector = `[data-task-id="${CSS.escape(nextTargetTaskId)}"]`;
        const targetSidebarSelector = `[data-sidebar-task-id="${CSS.escape(nextTargetTaskId)}"]`;
        const targetSidebar = document.querySelector<HTMLElement>(targetSidebarSelector);
        if (!targetSidebar) {
          reject(new Error(`Could not find sidebar task row for ${nextTargetTaskId}`));
          return;
        }

        function cleanup(): void {
          targetSidebar.removeEventListener('click', handleClick, true);
          mutationObserver.disconnect();
          if (rafId !== undefined) {
            cancelAnimationFrame(rafId);
            rafId = undefined;
          }
          if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId);
            timeoutId = undefined;
          }
        }

        function getTargetTaskPanel(): HTMLElement | null {
          return document.querySelector<HTMLElement>(targetTaskSelector);
        }

        function isElementVisibleInViewport(element: HTMLElement): boolean {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          );
        }

        function isTargetTerminalInteractive(): boolean {
          const panel = getTargetTaskPanel();
          if (
            !panel ||
            !isElementVisibleInViewport(panel) ||
            !panel.querySelector('.task-column.active')
          ) {
            return false;
          }

          const terminal = panel.querySelector<HTMLElement>('[data-terminal-status]');
          return (
            terminal?.getAttribute('data-terminal-status') === 'ready' &&
            terminal.getAttribute('data-terminal-paint-ready') === 'true' &&
            terminal.getAttribute('data-terminal-restore-blocked') !== 'true'
          );
        }

        function completeIfReady(): void {
          if (startedAtMs === null) {
            return;
          }

          if (isTargetTerminalInteractive()) {
            const durationMs = performance.now() - startedAtMs;
            cleanup();
            resolve(durationMs);
            return;
          }

          rafId = requestAnimationFrame(completeIfReady);
        }

        function handleClick(): void {
          startedAtMs = performance.now();
          rafId = requestAnimationFrame(completeIfReady);
        }

        const mutationObserver = new MutationObserver(completeIfReady);
        mutationObserver.observe(document.body, {
          attributeFilter: [
            'data-terminal-paint-ready',
            'data-terminal-restore-blocked',
            'data-terminal-status',
          ],
          attributes: true,
          subtree: true,
        });
        targetSidebar.addEventListener('click', handleClick, {
          capture: true,
          once: true,
        });
        timeoutId = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${nextTargetTaskId} terminal switch readiness`));
        }, 10_000);
      },
    );
  }, targetTaskId);
}

async function readTaskSwitchProbe(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const scorecardWindow = window as BrowserScorecardWindow;
    const probe = scorecardWindow.__parallelCodeScorecardTaskSwitchProbe;
    if (!probe) {
      throw new Error('Task switch scorecard probe was not installed');
    }

    return probe;
  });
}

async function installReviewDiffProbe(
  page: Page,
  taskId: string,
  expected: {
    filePath: string;
    text: string;
  },
): Promise<void> {
  await page.evaluate(
    ({ expectedFilePath, expectedText, targetTaskId }) => {
      const scorecardWindow = window as BrowserScorecardWindow;
      scorecardWindow.__parallelCodeScorecardReviewDiffProbe = new Promise<number>(
        (resolve, reject) => {
          let startedAtMs: number | null = null;
          let rafId: number | undefined;
          let timeoutId: number | undefined;
          let openReviewButton: HTMLElement | null = null;
          const taskPanelSelector = `[data-task-id="${CSS.escape(targetTaskId)}"]`;

          function cleanup(): void {
            openReviewButton?.removeEventListener('click', handleClick, true);
            mutationObserver.disconnect();
            if (rafId !== undefined) {
              cancelAnimationFrame(rafId);
              rafId = undefined;
            }
            if (timeoutId !== undefined) {
              window.clearTimeout(timeoutId);
              timeoutId = undefined;
            }
          }

          function getTaskPanel(): HTMLElement | null {
            return document.querySelector<HTMLElement>(taskPanelSelector);
          }

          function isExpectedDiffUseful(): boolean {
            const panel = getTaskPanel();
            const reviewPanel = panel?.querySelector<HTMLElement>('[data-review-panel="true"]');
            if (!reviewPanel || reviewPanel.getAttribute('data-review-mode') !== 'unstaged') {
              return false;
            }

            const diffPane = reviewPanel.querySelector<HTMLElement>(
              '[data-review-diff-pane="true"]',
            );
            if (!diffPane) {
              return false;
            }

            return (
              diffPane.getAttribute('data-review-diff-ready') === 'true' &&
              diffPane.getAttribute('data-review-diff-file') === expectedFilePath &&
              (diffPane.textContent ?? '').includes(expectedText)
            );
          }

          function completeIfReady(): void {
            if (startedAtMs === null) {
              return;
            }

            if (isExpectedDiffUseful()) {
              const durationMs = performance.now() - startedAtMs;
              cleanup();
              resolve(durationMs);
              return;
            }

            rafId = requestAnimationFrame(completeIfReady);
          }

          function handleClick(): void {
            startedAtMs = performance.now();
            rafId = requestAnimationFrame(completeIfReady);
          }

          const panel = getTaskPanel();
          openReviewButton =
            panel?.querySelector<HTMLElement>('button[title="Open review"]') ?? null;
          if (!openReviewButton) {
            reject(new Error(`Could not find review button for ${targetTaskId}`));
            return;
          }

          const mutationObserver = new MutationObserver(completeIfReady);
          mutationObserver.observe(document.body, {
            attributeFilter: [
              'data-review-diff-file',
              'data-review-diff-pane',
              'data-review-diff-ready',
              'data-review-mode',
              'data-review-panel',
            ],
            attributes: true,
            childList: true,
            subtree: true,
          });
          openReviewButton.addEventListener('click', handleClick, {
            capture: true,
            once: true,
          });
          timeoutId = window.setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${targetTaskId} review diff readiness`));
          }, 15_000);
        },
      );
    },
    {
      expectedFilePath: expected.filePath,
      expectedText: expected.text,
      targetTaskId: taskId,
    },
  );
}

async function readReviewDiffProbe(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const scorecardWindow = window as BrowserScorecardWindow;
    const probe = scorecardWindow.__parallelCodeScorecardReviewDiffProbe;
    if (!probe) {
      throw new Error('Review diff scorecard probe was not installed');
    }

    return probe;
  });
}

async function installTaskCleanupProbe(page: Page, taskId: string): Promise<void> {
  await page.evaluate((targetTaskId) => {
    const scorecardWindow = window as BrowserScorecardWindow;
    scorecardWindow.__parallelCodeScorecardTaskCleanupProbe = new Promise<number>(
      (resolve, reject) => {
        let startedAtMs: number | null = null;
        let rafId: number | undefined;
        let timeoutId: number | undefined;
        let closeButton: HTMLButtonElement | null = null;
        const taskPanelSelector = `[data-task-id="${CSS.escape(targetTaskId)}"]`;
        const sidebarRowSelector = `[data-sidebar-task-id="${CSS.escape(targetTaskId)}"]`;

        function cleanup(): void {
          closeButton?.removeEventListener('click', handleCloseClick, true);
          mutationObserver.disconnect();
          if (rafId !== undefined) {
            cancelAnimationFrame(rafId);
            rafId = undefined;
          }
          if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId);
            timeoutId = undefined;
          }
        }

        function areTaskSurfacesRemoved(): boolean {
          return (
            document.querySelector(taskPanelSelector) === null &&
            document.querySelector(sidebarRowSelector) === null
          );
        }

        function completeIfReady(): void {
          if (startedAtMs === null) {
            return;
          }

          if (areTaskSurfacesRemoved()) {
            const durationMs = performance.now() - startedAtMs;
            cleanup();
            resolve(durationMs);
            return;
          }

          rafId = requestAnimationFrame(completeIfReady);
        }

        function handleCloseClick(): void {
          startedAtMs = performance.now();
          rafId = requestAnimationFrame(completeIfReady);
        }

        closeButton =
          [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
            /^(Close|Delete)$/u.test(button.textContent?.trim() ?? ''),
          ) ?? null;
        if (!closeButton) {
          reject(new Error(`Could not find close confirmation button for ${targetTaskId}`));
          return;
        }

        const mutationObserver = new MutationObserver(completeIfReady);
        mutationObserver.observe(document.body, {
          attributeFilter: ['data-sidebar-task-id', 'data-task-id'],
          attributes: true,
          childList: true,
          subtree: true,
        });
        closeButton.addEventListener('click', handleCloseClick, {
          capture: true,
          once: true,
        });
        timeoutId = window.setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${targetTaskId} cleanup`));
        }, 8_000);
      },
    );
  }, taskId);
}

async function readTaskCleanupProbe(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const scorecardWindow = window as BrowserScorecardWindow;
    const probe = scorecardWindow.__parallelCodeScorecardTaskCleanupProbe;
    if (!probe) {
      throw new Error('Task cleanup scorecard probe was not installed');
    }

    return probe;
  });
}

async function measureTaskSwitchTiming(
  page: Page,
  sourceTaskId: string,
  targetTaskId: string,
): Promise<TaskSwitchTiming> {
  await page.locator(`[data-sidebar-task-id="${sourceTaskId}"]`).click();
  await waitForTaskTerminalInteractive(page, sourceTaskId);

  await installTaskSwitchProbe(page, targetTaskId);
  const observerStartedAt = getNowMs();
  await page.locator(`[data-sidebar-task-id="${targetTaskId}"]`).click();
  const browserMs = await readTaskSwitchProbe(page);
  return {
    browserMs,
    observerMs: getNowMs() - observerStartedAt,
  };
}

async function measureReviewDiffOpenMs(page: Page, taskId: string): Promise<number> {
  const taskPanel = page.locator(getTaskPanelSelector(taskId));
  await installReviewDiffProbe(page, taskId, {
    filePath: SCORECARD_REVIEW_FILE_PATH,
    text: SCORECARD_REVIEW_EXPECTED_TEXT,
  });
  await taskPanel.getByTitle('Open review').click();
  await expect(taskPanel.locator('[data-review-panel="true"]')).toBeVisible();
  await taskPanel.getByRole('combobox').last().selectOption('unstaged');
  return readReviewDiffProbe(page);
}

async function measureTaskCleanupMs(page: Page, taskId: string): Promise<number> {
  const taskPanel = page.locator(getTaskPanelSelector(taskId));
  await taskPanel.getByTitle('Open preview and ports').click();
  await expect(taskPanel.getByLabel('Hide preview manager')).toBeVisible();
  await taskPanel.getByTitle('Close task').click();
  await expect(page.getByRole('heading', { name: 'Close Task' })).toBeVisible();
  await installTaskCleanupProbe(page, taskId);
  await page.getByRole('button', { name: /^(Close|Delete)$/u }).click();
  const browserMs = await readTaskCleanupProbe(page);
  await expect(taskPanel).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator(`[data-sidebar-task-id="${taskId}"]`)).toHaveCount(0);
  return browserMs;
}

async function disconnectBrowserTransport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const transport = (window as BrowserScorecardWindow).__parallelCodeBrowserTransportForTests__;
    if (!transport) {
      throw new Error('Browser transport test hook is not available');
    }

    transport.disconnect();
  });
}

async function reconnectBrowserTransport(page: Page): Promise<number> {
  return page.evaluate(() => {
    const transport = (window as BrowserScorecardWindow).__parallelCodeBrowserTransportForTests__;
    if (!transport) {
      throw new Error('Browser transport test hook is not available');
    }

    const startedAtMs = performance.now();
    void transport.ensureConnected();
    return startedAtMs;
  });
}

async function waitForConnectionBannerState(
  browserLab: {
    readConnectionBannerHistory: (page: Page) => Promise<Array<string | null>>;
  },
  page: Page,
  state: string | null,
): Promise<void> {
  await expect
    .poll(() => browserLab.readConnectionBannerHistory(page), { timeout: 10_000 })
    .toContain(state);
}

async function waitForConnectionBannerSettled(
  browserLab: {
    readConnectionBannerHistory: (page: Page) => Promise<Array<string | null>>;
  },
  page: Page,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const history = await browserLab.readConnectionBannerHistory(page);
        return history.at(-1) ?? null;
      },
      { timeout: 10_000 },
    )
    .toBeNull();
}

async function measureReconnectSelectedSurfaceMs(
  page: Page,
  browserLab: {
    readConnectionBannerHistory: (page: Page) => Promise<Array<string | null>>;
  },
  taskId: string,
): Promise<number> {
  await waitForTaskTerminalInteractive(page, taskId);
  await disconnectBrowserTransport(page);
  await waitForConnectionBannerState(browserLab, page, 'disconnected');

  const reconnectStartedAtMs = await reconnectBrowserTransport(page);
  await waitForConnectionBannerState(browserLab, page, 'restoring');
  await waitForConnectionBannerSettled(browserLab, page);
  await waitForTaskTerminalInteractive(page, taskId);

  return (await readBrowserNowMs(page)) - reconnectStartedAtMs;
}

async function prepareRemoteScorecardContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  });
  await context.addInitScript(
    ([displayNameStorageKey, displayName, clientIdStorageKey, clientId]) => {
      window.localStorage.setItem(displayNameStorageKey, displayName);
      window.sessionStorage.setItem(clientIdStorageKey, clientId);
    },
    [
      REMOTE_DISPLAY_NAME_STORAGE_KEY,
      'Performance Scorecard Remote',
      REMOTE_CLIENT_ID_STORAGE_KEY,
      'performance-scorecard-remote-client',
    ] as const,
  );
  return context;
}

async function retainScorecardOwnerTaskCommandLease(
  browserLab: {
    server: { agentId: string; taskId: string };
    invokeIpc: <TResult>(
      request: APIRequestContext,
      channel: IPC,
      body?: unknown,
    ) => Promise<TResult>;
    invokeSessionIpc: <TResult>(
      request: APIRequestContext,
      page: Page,
      channel: IPC,
      body?: unknown,
    ) => Promise<TResult>;
    typeInTerminal: (
      page: Page,
      text: string,
      terminalIndexOrOptions?:
        | number
        | {
            requireInteractiveReady?: boolean;
            terminalIndex?: number;
          },
    ) => Promise<void>;
    waitForAgentScrollback: (
      request: APIRequestContext,
      agentId: string,
      text: string,
      timeoutMs?: number,
    ) => Promise<void>;
  },
  ownerPage: Page,
  request: APIRequestContext,
): Promise<void> {
  const ownerMarker = `OWNER_SCORECARD_${Date.now()}`;
  await browserLab.typeInTerminal(ownerPage, ownerMarker, {
    requireInteractiveReady: true,
  });
  await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, ownerMarker);
  await refreshScorecardOwnerTaskCommandLease(browserLab, ownerPage, request);
}

async function refreshScorecardOwnerTaskCommandLease(
  browserLab: {
    invokeSessionIpc: <TResult>(
      request: APIRequestContext,
      page: Page,
      channel: IPC,
      body?: unknown,
    ) => Promise<TResult>;
    server: { taskId: string };
  },
  ownerPage: Page,
  request: APIRequestContext,
): Promise<void> {
  const lease = await browserLab.invokeSessionIpc<TaskCommandLeaseAcquireSnapshot>(
    request,
    ownerPage,
    IPC.AcquireTaskCommandLease,
    {
      action: 'type in the terminal',
      clientId: SCORECARD_OWNER_CLIENT_ID,
      ownerId: 'performance-scorecard-owner',
      taskId: browserLab.server.taskId,
    },
  );
  expect(lease.acquired).toBe(true);
  expect(lease.controllerId).toBe(SCORECARD_OWNER_CLIENT_ID);
}

async function measureRemoteCommandSessionTiming(
  browser: Browser,
  browserLab: {
    getAuthedUrl: (path?: string) => string;
    server: {
      agentId: string;
      getLifecycleSnapshot: () => {
        stderrTail: string;
        stdoutTail: string;
      };
      taskId: string;
    };
    invokeSessionIpc: <TResult>(
      request: APIRequestContext,
      page: Page,
      channel: IPC,
      body?: unknown,
    ) => Promise<TResult>;
    typeInTerminal: (
      page: Page,
      text: string,
      terminalIndexOrOptions?:
        | number
        | {
            requireInteractiveReady?: boolean;
            terminalIndex?: number;
          },
    ) => Promise<void>;
    waitForAgentScrollback: (
      request: APIRequestContext,
      agentId: string,
      text: string,
      timeoutMs?: number,
    ) => Promise<void>;
  },
  ownerPage: Page,
  request: APIRequestContext,
): Promise<RemoteCommandSessionTiming> {
  await retainScorecardOwnerTaskCommandLease(browserLab, ownerPage, request);

  const remoteContext = await prepareRemoteScorecardContext(browser);
  const remotePage = await remoteContext.newPage();
  try {
    const shellStartedAt = getNowMs();
    await remotePage.goto(browserLab.getAuthedUrl('/remote'), {
      waitUntil: 'domcontentloaded',
    });

    await remotePage
      .getByRole('button', { name: getRemoteAgentCardName(scorecardScenario.taskName) })
      .click();
    const commandInput = remotePage.getByLabel('Type a command for this agent');
    await expect(commandInput).toBeVisible({ timeout: 10_000 });
    const shellToCommandInputMs = getNowMs() - shellStartedAt;
    await expect(commandInput).toBeDisabled({ timeout: 10_000 });
    await refreshScorecardOwnerTaskCommandLease(browserLab, ownerPage, request);

    const takeOverButton = remotePage.getByRole('button', { name: /^Take Over$/u });
    const takeoverStartedAt = getNowMs();
    await takeOverButton.click();
    const approvalDialog = ownerPage.getByRole('alertdialog', { name: 'Allow takeover?' });
    await expect(approvalDialog).toBeVisible({ timeout: 10_000 });
    const takeoverRequestToOwnerPromptMs = getNowMs() - takeoverStartedAt;

    const approvalStartedAt = getNowMs();
    await ownerPage.bringToFront();
    await approvalDialog.getByRole('button', { name: 'Allow' }).click();
    await expect(approvalDialog).toBeHidden({ timeout: 10_000 });
    await remotePage.bringToFront();
    await expect(commandInput).toBeEnabled({ timeout: 10_000 });
    const ownerApprovalToRemoteControlMs = getNowMs() - approvalStartedAt;

    const marker = `REMOTE_SCORECARD_${Date.now()}`;
    await commandInput.fill(marker);
    const writeAckPromise = remotePage.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/ipc/${IPC.WriteToAgent}` && response.request().method() === 'POST'
        );
      },
      { timeout: 10_000 },
    );
    const writeStartedAt = getNowMs();
    await remotePage.getByRole('button', { name: 'Send command' }).click();
    const writeResponse = await writeAckPromise;
    expect(writeResponse.ok()).toBe(true);
    const sendClickToWriteAckMs = getNowMs() - writeStartedAt;

    await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, marker);
    return {
      ownerApprovalToRemoteControlMs,
      sendClickToWriteAckMs,
      shellToCommandInputMs,
      takeoverRequestToOwnerPromptMs,
    };
  } finally {
    await remoteContext.close();
  }
}

async function measurePreviewOpenMs(
  page: Page,
  browserLab: {
    invokeIpc: <TResult>(
      request: APIRequestContext,
      channel: IPC,
      body?: unknown,
    ) => Promise<TResult>;
    server: { baseUrl: string; taskId: string };
  },
  request: APIRequestContext,
  port: number,
): Promise<number> {
  const startedAt = getNowMs();
  const snapshot = await browserLab.invokeIpc<TaskPortSnapshot>(request, IPC.ExposePort, {
    label: 'Performance scorecard preview',
    port,
    taskId: browserLab.server.taskId,
  });
  expect(snapshot.exposed.map((entry) => entry.port)).toContain(port);

  const previewPath = `/_preview/${encodeURIComponent(browserLab.server.taskId)}/${port}/scorecard`;
  const response = await page.goto(new URL(previewPath, browserLab.server.baseUrl).href);
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#scorecard-preview-root')).toHaveAttribute('data-path', '/scorecard');
  return getNowMs() - startedAt;
}

async function collectScorecardDiagnostics(
  page: Page,
  browserLab: {
    invokeIpc: <TResult>(
      request: APIRequestContext,
      channel: IPC,
      body?: unknown,
    ) => Promise<TResult>;
    readLifecycleSnapshot: (page: Page) => Promise<unknown>;
  },
  request: APIRequestContext,
): Promise<Record<string, unknown>> {
  const [attachTraces, backend, lifecycle, renderer, uiFluidity, startupTrace] = await Promise.all([
    readTerminalAttachTraces(page),
    browserLab.invokeIpc(request, IPC.GetBackendRuntimeDiagnostics),
    browserLab.readLifecycleSnapshot(page),
    getRendererDiagnostics(page),
    getUiFluidityDiagnostics(page),
    readBrowserStartupTrace(page),
  ]);

  return {
    attachTraces,
    backend,
    lifecycle,
    renderer,
    startupTrace,
    uiFluidity,
  };
}

async function finishScorecard(
  testInfo: TestInfo,
  run: ScorecardRun,
  diagnostics: Record<string, unknown>,
): Promise<void> {
  run.diagnostics = diagnostics;
  await writeScorecardArtifacts(testInfo, run);
}

function readRendererSelectedTerminalMs(diagnostics: Record<string, unknown>): number | null {
  const renderer = diagnostics.renderer;
  if (typeof renderer !== 'object' || renderer === null || !('browserStartup' in renderer)) {
    return null;
  }

  const browserStartup = renderer.browserStartup;
  if (
    typeof browserStartup !== 'object' ||
    browserStartup === null ||
    !('tierLastReachedMs' in browserStartup)
  ) {
    return null;
  }

  const tierLastReachedMs = browserStartup.tierLastReachedMs;
  if (typeof tierLastReachedMs !== 'object' || tierLastReachedMs === null) {
    return null;
  }

  const selectedTerminalMs = (tierLastReachedMs as Record<string, unknown>)['selected-terminal'];
  return typeof selectedTerminalMs === 'number' ? selectedTerminalMs : null;
}

test.describe('browser/server performance scorecard smoke', () => {
  test.use({
    scenario: scorecardScenario,
  });

  test('records selected terminal, input, task-switch, review, cleanup, reconnect, remote, and preview product timings', async ({
    browser,
    browserLab,
    browserName,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const run = createScorecardRun({
      browserName,
      profile: 'smoke',
      testInfo,
    });
    const target = await createPreviewTargetServer();
    const harnessOpenStartedAt = getNowMs();
    let navigationStartedAt = harnessOpenStartedAt;
    let navigationCommittedAt = harnessOpenStartedAt;
    const session = await browserLab.openSession(browser, {
      clientId: SCORECARD_OWNER_CLIENT_ID,
      displayName: 'Performance Scorecard Smoke',
      expectAppShell: false,
      gotoWaitUntil: 'commit',
      onAfterGoto() {
        navigationCommittedAt = getNowMs();
      },
      onBeforeGoto() {
        navigationStartedAt = getNowMs();
      },
      prepareContext: installScorecardDiagnostics,
    });
    const { context, page } = session;

    try {
      const observedAppShellPaintedAtBrowserMs = await waitForAppShellPainted(page);
      const appShellPaintedAt = getNowMs();
      await browserLab.waitForTerminalInteractiveReady(page);
      const observedSelectedTerminalInteractiveAtBrowserMs = await readBrowserNowMs(page);
      const selectedTerminalInteractiveAt = getNowMs();
      const startupTrace = await readBrowserStartupTrace(page);
      const launchTimings = getBrowserLaunchTimings(
        startupTrace,
        observedAppShellPaintedAtBrowserMs,
        observedSelectedTerminalInteractiveAtBrowserMs,
      );
      recordBrowserSessionLaunchMetrics(run, launchTimings);
      recordScorecardMetric(run, {
        journey: 'browser lab harness',
        name: 'fresh context setup before navigation',
        value: navigationStartedAt - harnessOpenStartedAt,
      });
      recordScorecardMetric(run, {
        journey: 'browser lab harness',
        name: 'navigation start to commit',
        value: navigationCommittedAt - navigationStartedAt,
      });
      recordScorecardMetric(run, {
        journey: 'browser lab harness',
        name: 'navigation to app shell painted observer',
        value: appShellPaintedAt - navigationStartedAt,
      });
      recordScorecardMetric(run, {
        journey: 'browser lab harness',
        name: 'navigation to selected terminal interactive observer',
        value: selectedTerminalInteractiveAt - navigationStartedAt,
      });
      recordScorecardMetric(run, {
        journey: 'browser lab harness',
        name: 'app shell painted to selected terminal interactive observer',
        value: selectedTerminalInteractiveAt - appShellPaintedAt,
      });
      recordBrowserStartupDiagnosticMetrics(run, startupTrace, launchTimings);
      recordTerminalAttachTraceMetrics(
        run,
        await readTerminalAttachTraces(page),
        browserLab.server.agentId,
      );

      const launchDiagnostics = await collectScorecardDiagnostics(page, browserLab, request);
      await warmTerminalInputTracing(browserLab, page, request, 0, {
        clearLineAfterWarm: true,
      });
      const inputSnapshot = await measureTypedTextTrace(browserLab, page, request, 'scorecard', {
        focusTerminal: false,
        minimumCount: 9,
      });
      recordScorecardMetric(run, {
        budgetMs: TERMINAL_INPUT_P95_BUDGET_MS,
        journey: 'terminal typing under browser/server transport',
        name: 'end-to-end p95',
        value: inputSnapshot.summary.endToEndMs.p95,
      });
      recordScorecardMetric(run, {
        journey: 'terminal typing under browser/server transport',
        name: 'trace count',
        unit: 'count',
        value: inputSnapshot.summary.count,
      });

      const switchTargetTaskId = browserLab.server.taskIds[1];
      if (!switchTargetTaskId) {
        throw new Error('Performance scorecard smoke scenario must seed a switch target task');
      }
      const taskSwitchTiming = await measureTaskSwitchTiming(
        page,
        browserLab.server.taskId,
        switchTargetTaskId,
      );
      recordScorecardMetric(run, {
        budgetMs: TASK_SWITCH_BUDGET_MS,
        journey: 'task switch with terminal continuity',
        name: 'sidebar click to target terminal interactive',
        value: taskSwitchTiming.browserMs,
      });
      recordScorecardMetric(run, {
        journey: 'browser lab harness',
        name: 'sidebar click to target terminal interactive observer',
        value: taskSwitchTiming.observerMs,
      });
      prepareScorecardReviewWorktree(browserLab.server.repoDir);
      recordScorecardMetric(run, {
        budgetMs: REVIEW_DIFF_OPEN_BUDGET_MS,
        journey: 'review diff open',
        name: 'open review and select unstaged to first useful diff',
        value: await measureReviewDiffOpenMs(page, switchTargetTaskId),
      });
      recordScorecardMetric(run, {
        budgetMs: CLEANUP_VISIBLE_BUDGET_MS,
        journey: 'cleanup while surfaces are open',
        name: 'confirm close to task surfaces removed',
        value: await measureTaskCleanupMs(page, switchTargetTaskId),
      });
      recordScorecardMetric(run, {
        budgetMs: RECONNECT_SELECTED_SURFACE_BUDGET_MS,
        journey: 'reconnect and replay',
        name: 'reconnect request to selected terminal interactive',
        value: await measureReconnectSelectedSurfaceMs(page, browserLab, browserLab.server.taskId),
      });
      const remoteTiming = await measureRemoteCommandSessionTiming(
        browser,
        browserLab,
        page,
        request,
      );
      recordScorecardMetric(run, {
        budgetMs: REMOTE_COMMAND_INPUT_VISIBLE_BUDGET_MS,
        journey: 'remote/mobile command session',
        name: 'remote shell navigation to command input visible',
        value: remoteTiming.shellToCommandInputMs,
      });
      recordScorecardMetric(run, {
        budgetMs: REMOTE_TAKEOVER_PROMPT_BUDGET_MS,
        journey: 'remote/mobile command session',
        name: 'takeover request to owner approval prompt',
        value: remoteTiming.takeoverRequestToOwnerPromptMs,
      });
      recordScorecardMetric(run, {
        budgetMs: REMOTE_TAKEOVER_APPROVAL_BUDGET_MS,
        journey: 'remote/mobile command session',
        name: 'owner approval to remote control available',
        value: remoteTiming.ownerApprovalToRemoteControlMs,
      });
      recordScorecardMetric(run, {
        budgetMs: REMOTE_COMMAND_ACK_BUDGET_MS,
        journey: 'remote/mobile command session',
        name: 'send command click to write acknowledgement',
        value: remoteTiming.sendClickToWriteAckMs,
      });

      const diagnosticsBeforePreview = await collectScorecardDiagnostics(page, browserLab, request);
      const rendererSelectedTerminalMs = readRendererSelectedTerminalMs(launchDiagnostics);
      if (rendererSelectedTerminalMs !== null) {
        recordScorecardMetric(run, {
          budgetMs: RENDERER_SELECTED_TERMINAL_BUDGET_MS,
          journey: 'browser session launch',
          name: 'renderer cold-bootstrap selected-terminal tier',
          value: rendererSelectedTerminalMs,
        });
      }
      recordScorecardMetric(run, {
        budgetMs: PREVIEW_NAVIGABLE_BUDGET_MS,
        journey: 'preview through explicit port exposure',
        name: 'expose request to navigable preview',
        value: await measurePreviewOpenMs(page, browserLab, request, target.port),
      });
      await finishScorecard(testInfo, run, {
        afterInteractionBeforePreview: diagnosticsBeforePreview,
        launch: launchDiagnostics,
      });
    } finally {
      await Promise.allSettled([context.close(), target.close()]);
    }
  });
});
