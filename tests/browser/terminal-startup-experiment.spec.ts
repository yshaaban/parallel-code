import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

const RUN_TERMINAL_STARTUP_EXPERIMENT = process.env.RUN_TERMINAL_STARTUP_EXPERIMENT === '1';
const TERMINAL_STARTUP_SHELL_COUNTS = parseTerminalStartupShellCounts(
  process.env.TERMINAL_STARTUP_SHELL_COUNTS,
);

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

interface BackendRuntimeDiagnosticsSnapshot {
  browserChannels: {
    coalescedBytesSaved: number;
    coalescedMessages: number;
    degradedClientChannels: number;
    droppedDataMessages: number;
    maxQueueAgeMs: number;
    maxQueuedBytes: number;
    recoveredClientChannels: number;
    resetBindings: number;
    transportBusyDeferrals: number;
  };
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

interface ReloadExperimentResult {
  attachTraceEntries: TerminalAttachTraceEntry[];
  fetchDurationsByChannelMs: Record<string, number[]>;
  heavyShellReadyTimesMs: number[];
  longTaskCount: number;
  longTaskMaxMs: number;
  longTaskTotalMs: number;
  replayTraceEntries: TerminalReplayTraceEntry[];
  recoveryRequestCounts: Record<string, number>;
  shellVisibleMs: number;
  statusHistories: Array<
    Array<{
      atMs: number;
      status: string;
    }>
  >;
  totalReadyMs: number;
  visibleTerminalCountAtShellVisible: number;
  visibilityAtShellVisible: TerminalVisibilitySnapshot[];
}

interface TerminalReplayTraceEntry {
  agentId: string;
  applyMs: number;
  chunkCount: number;
  outputPriority: 'focused' | 'active-visible' | 'visible-background' | 'hidden';
  pauseMs: number;
  reason: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss';
  recoveryFetchMs: number;
  recoveryKind: 'noop' | 'delta' | 'snapshot';
  requestStateBytes: number;
  requestedAtMs: number;
  restoreTotalMs: number;
  resumeMs: number;
  waitForOutputIdleMs: number;
  writtenBytes: number;
}

interface TerminalAttachTraceEntry {
  agentId: string;
  attachBoundAtMs: number | null;
  attachQueuedAtMs: number;
  attachStartedAtMs: number | null;
  key: string;
  readyAtMs: number | null;
  status: 'binding' | 'attaching' | 'restoring' | 'ready' | 'error' | 'queued';
  taskId: string;
}

interface TerminalVisibilitySnapshot {
  agentId: string | null;
  index: number;
  isVisibleInViewport: boolean;
  status: string | null;
}

const STARTUP_TRACE_STORAGE_KEY = '__parallelCodeStartupTrace';
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';

async function installReloadStartupTracing(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(
    ({ startupTraceStorageKey, terminalStatusSelector }) => {
      type StartupFetchTrace = {
        channel: string;
        durationMs: number;
        ok: boolean;
      };

      type StartupLongTaskTrace = {
        durationMs: number;
        startMs: number;
      };

      type StartupStatusTrace = {
        atMs: number;
        status: string;
      };

      type StartupTraceStore = {
        fetches: StartupFetchTrace[];
        longTasks: StartupLongTaskTrace[];
        statusesByAgentId: Record<string, StartupStatusTrace[]>;
      };

      const windowWithTraceStore = window as typeof window & {
        [key: string]: StartupTraceStore | undefined;
        __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, TerminalAttachTraceEntry>;
        __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: TerminalReplayTraceEntry[];
      };
      const traceStore: StartupTraceStore = {
        fetches: [],
        longTasks: [],
        statusesByAgentId: {},
      };
      windowWithTraceStore[startupTraceStorageKey] = traceStore;
      windowWithTraceStore.__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__ = {};
      windowWithTraceStore.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = [];

      if (typeof PerformanceObserver === 'function') {
        const longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            traceStore.longTasks.push({
              durationMs: entry.duration,
              startMs: entry.startTime,
            });
          }
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url =
          typeof args[0] === 'string'
            ? args[0]
            : args[0] instanceof URL
              ? args[0].toString()
              : args[0].url;
        const fetchStartedAt = performance.now();
        try {
          const response = await originalFetch(...args);
          if (url.includes('/api/ipc/')) {
            traceStore.fetches.push({
              channel: url.slice(url.lastIndexOf('/') + 1),
              durationMs: performance.now() - fetchStartedAt,
              ok: response.ok,
            });
          }
          return response;
        } catch (error) {
          if (url.includes('/api/ipc/')) {
            traceStore.fetches.push({
              channel: url.slice(url.lastIndexOf('/') + 1),
              durationMs: performance.now() - fetchStartedAt,
              ok: false,
            });
          }
          throw error;
        }
      };

      const statusObservers = new WeakMap<HTMLElement, MutationObserver>();

      function recordStatus(statusElement: HTMLElement): void {
        const agentId = statusElement.getAttribute('data-terminal-agent-id');
        if (!agentId) {
          return;
        }

        const status = statusElement.getAttribute('data-terminal-status') ?? 'unknown';
        const history = traceStore.statusesByAgentId[agentId] ?? [];
        const lastEntry = history[history.length - 1];
        if (lastEntry?.status === status) {
          return;
        }

        history.push({
          atMs: performance.now(),
          status,
        });
        traceStore.statusesByAgentId[agentId] = history;
      }

      function observeStatusElement(statusElement: Element): void {
        if (!(statusElement instanceof HTMLElement)) {
          return;
        }

        if (statusObservers.has(statusElement)) {
          return;
        }

        recordStatus(statusElement);
        const observer = new MutationObserver(() => {
          recordStatus(statusElement);
        });
        observer.observe(statusElement, {
          attributeFilter: ['data-terminal-status'],
          attributes: true,
        });
        statusObservers.set(statusElement, observer);
      }

      function scanStatusElements(root: ParentNode): void {
        if (root instanceof Element && root.matches(terminalStatusSelector)) {
          observeStatusElement(root);
        }

        for (const statusElement of root.querySelectorAll(terminalStatusSelector)) {
          observeStatusElement(statusElement);
        }
      }

      scanStatusElements(document);
      const rootObserver = new MutationObserver((entries) => {
        for (const entry of entries) {
          for (const addedNode of entry.addedNodes) {
            if (!(addedNode instanceof Element)) {
              continue;
            }

            scanStatusElements(addedNode);
          }
        }
      });
      rootObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    },
    {
      startupTraceStorageKey: STARTUP_TRACE_STORAGE_KEY,
      terminalStatusSelector: TERMINAL_STATUS_SELECTOR,
    },
  );
}

function summarizeDurationsByChannel(durationsByChannelMs: Record<string, number[]>): Record<
  string,
  {
    avgMs: number;
    count: number;
    maxMs: number;
  }
> {
  const summaryEntries = Object.entries(durationsByChannelMs).map(([channel, durations]) => {
    const totalDurationMs = durations.reduce((total, durationMs) => total + durationMs, 0);
    const averageDurationMs = durations.length > 0 ? totalDurationMs / durations.length : 0;
    const maxDurationMs = durations.length > 0 ? Math.max(...durations) : 0;
    return [
      channel,
      {
        avgMs: roundMilliseconds(averageDurationMs),
        count: durations.length,
        maxMs: roundMilliseconds(maxDurationMs),
      },
    ] as const;
  });
  return Object.fromEntries(summaryEntries);
}

function summarizeReplayTraces(entries: readonly TerminalReplayTraceEntry[]): {
  byPriority: Record<
    string,
    {
      count: number;
      totalApplyMs: number;
      totalChunkCount: number;
      totalPauseMs: number;
      totalRecoveryFetchMs: number;
      totalRequestStateBytes: number;
      totalRestoreMs: number;
      totalResumeMs: number;
      totalWaitForOutputIdleMs: number;
      totalWrittenBytes: number;
    }
  >;
  overall: {
    count: number;
    totalApplyMs: number;
    totalChunkCount: number;
    totalPauseMs: number;
    totalRecoveryFetchMs: number;
    totalRequestStateBytes: number;
    totalRestoreMs: number;
    totalResumeMs: number;
    totalWaitForOutputIdleMs: number;
    totalWrittenBytes: number;
  };
} {
  const overall = {
    count: 0,
    totalApplyMs: 0,
    totalChunkCount: 0,
    totalPauseMs: 0,
    totalRecoveryFetchMs: 0,
    totalRequestStateBytes: 0,
    totalRestoreMs: 0,
    totalResumeMs: 0,
    totalWaitForOutputIdleMs: 0,
    totalWrittenBytes: 0,
  };
  const byPriority: Record<string, typeof overall> = {};

  for (const entry of entries) {
    overall.count += 1;
    overall.totalApplyMs += entry.applyMs;
    overall.totalChunkCount += entry.chunkCount;
    overall.totalPauseMs += entry.pauseMs;
    overall.totalRecoveryFetchMs += entry.recoveryFetchMs;
    overall.totalRequestStateBytes += entry.requestStateBytes;
    overall.totalRestoreMs += entry.restoreTotalMs;
    overall.totalResumeMs += entry.resumeMs;
    overall.totalWaitForOutputIdleMs += entry.waitForOutputIdleMs;
    overall.totalWrittenBytes += entry.writtenBytes;

    const prioritySummary =
      byPriority[entry.outputPriority] ??
      (byPriority[entry.outputPriority] = {
        count: 0,
        totalApplyMs: 0,
        totalChunkCount: 0,
        totalPauseMs: 0,
        totalRecoveryFetchMs: 0,
        totalRequestStateBytes: 0,
        totalRestoreMs: 0,
        totalResumeMs: 0,
        totalWaitForOutputIdleMs: 0,
        totalWrittenBytes: 0,
      });
    prioritySummary.count += 1;
    prioritySummary.totalApplyMs += entry.applyMs;
    prioritySummary.totalChunkCount += entry.chunkCount;
    prioritySummary.totalPauseMs += entry.pauseMs;
    prioritySummary.totalRecoveryFetchMs += entry.recoveryFetchMs;
    prioritySummary.totalRequestStateBytes += entry.requestStateBytes;
    prioritySummary.totalRestoreMs += entry.restoreTotalMs;
    prioritySummary.totalResumeMs += entry.resumeMs;
    prioritySummary.totalWaitForOutputIdleMs += entry.waitForOutputIdleMs;
    prioritySummary.totalWrittenBytes += entry.writtenBytes;
  }

  for (const summary of Object.values(byPriority)) {
    summary.totalApplyMs = roundMilliseconds(summary.totalApplyMs);
    summary.totalPauseMs = roundMilliseconds(summary.totalPauseMs);
    summary.totalRecoveryFetchMs = roundMilliseconds(summary.totalRecoveryFetchMs);
    summary.totalRestoreMs = roundMilliseconds(summary.totalRestoreMs);
    summary.totalResumeMs = roundMilliseconds(summary.totalResumeMs);
    summary.totalWaitForOutputIdleMs = roundMilliseconds(summary.totalWaitForOutputIdleMs);
  }

  overall.totalApplyMs = roundMilliseconds(overall.totalApplyMs);
  overall.totalPauseMs = roundMilliseconds(overall.totalPauseMs);
  overall.totalRecoveryFetchMs = roundMilliseconds(overall.totalRecoveryFetchMs);
  overall.totalRestoreMs = roundMilliseconds(overall.totalRestoreMs);
  overall.totalResumeMs = roundMilliseconds(overall.totalResumeMs);
  overall.totalWaitForOutputIdleMs = roundMilliseconds(overall.totalWaitForOutputIdleMs);

  return {
    byPriority,
    overall,
  };
}

function summarizeAttachTraces(entries: readonly TerminalAttachTraceEntry[]): {
  avgBindMs: number;
  avgQueueWaitMs: number;
  avgReadyAfterBindMs: number;
  firstQueuedToLastReadyMs: number;
  maxBindMs: number;
  maxQueueWaitMs: number;
  maxReadyAfterBindMs: number;
  maxReadyAtMs: number;
  minQueuedAtMs: number;
} {
  const bindDurations = entries
    .map((entry) =>
      entry.attachStartedAtMs === null || entry.attachBoundAtMs === null
        ? null
        : entry.attachBoundAtMs - entry.attachStartedAtMs,
    )
    .filter((value): value is number => value !== null);
  const queueWaitDurations = entries
    .map((entry) =>
      entry.attachStartedAtMs === null ? null : entry.attachStartedAtMs - entry.attachQueuedAtMs,
    )
    .filter((value): value is number => value !== null);
  const readyAfterBindDurations = entries
    .map((entry) =>
      entry.attachBoundAtMs === null || entry.readyAtMs === null
        ? null
        : entry.readyAtMs - entry.attachBoundAtMs,
    )
    .filter((value): value is number => value !== null);
  const queuedAtTimes = entries.map((entry) => entry.attachQueuedAtMs);
  const readyAtTimes = entries
    .map((entry) => entry.readyAtMs)
    .filter((value): value is number => value !== null);

  function average(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return values.reduce((total, value) => total + value, 0) / values.length;
  }

  function max(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return Math.max(...values);
  }

  function min(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return Math.min(...values);
  }

  const minQueuedAtMs = min(queuedAtTimes);
  const maxReadyAtMs = max(readyAtTimes);

  return {
    avgBindMs: roundMilliseconds(average(bindDurations)),
    avgQueueWaitMs: roundMilliseconds(average(queueWaitDurations)),
    avgReadyAfterBindMs: roundMilliseconds(average(readyAfterBindDurations)),
    firstQueuedToLastReadyMs: roundMilliseconds(maxReadyAtMs - minQueuedAtMs),
    maxBindMs: roundMilliseconds(max(bindDurations)),
    maxQueueWaitMs: roundMilliseconds(max(queueWaitDurations)),
    maxReadyAfterBindMs: roundMilliseconds(max(readyAfterBindDurations)),
    maxReadyAtMs: roundMilliseconds(maxReadyAtMs),
    minQueuedAtMs: roundMilliseconds(minQueuedAtMs),
  };
}

function parseTerminalStartupShellCounts(rawValue: string | undefined): readonly number[] {
  if (!rawValue) {
    return [1, 2, 3, 6] as const;
  }

  const counts = rawValue
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return counts.length > 0 ? counts : ([1, 2, 3, 6] as const);
}

function summarizeBackendDiagnostics(snapshot: BackendRuntimeDiagnosticsSnapshot): {
  browserChannels: BackendRuntimeDiagnosticsSnapshot['browserChannels'];
  terminalRecovery: BackendRuntimeDiagnosticsSnapshot['terminalRecovery'];
} {
  return {
    browserChannels: snapshot.browserChannels,
    terminalRecovery: snapshot.terminalRecovery,
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

async function primeLargeShellScrollback(
  browserLab: {
    runInTerminal: (
      page: import('@playwright/test').Page,
      text: string,
      options?: { pressEnter?: boolean; terminalIndex?: number },
    ) => Promise<void>;
    waitForAgentScrollback: (
      request: unknown,
      agentId: string,
      text: string,
      timeoutMs?: number,
    ) => Promise<void>;
  },
  page: import('@playwright/test').Page,
  request: unknown,
  shellAgentId: string,
  terminalIndex: number,
  marker: string,
): Promise<void> {
  await browserLab.runInTerminal(
    page,
    `yes 12345678901234567890 | head -n 100000; printf "${marker}\\n"`,
    {
      terminalIndex,
    },
  );
  await browserLab.waitForAgentScrollback(request, shellAgentId, marker, 20_000);
}

async function measureReloadRestore(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
    waitForTerminalReady: (
      page: import('@playwright/test').Page,
      terminalIndex?: number,
    ) => Promise<void>;
  },
  page: import('@playwright/test').Page,
  request: unknown,
  heavyShellTerminalIndices: readonly number[],
  totalTerminalCount: number,
): Promise<ReloadExperimentResult> {
  await installReloadStartupTracing(page);
  await browserLab.invokeIpc(request, IPC.ResetBackendRuntimeDiagnostics);

  const recoveryRequestCounts: Record<string, number> = {
    get_terminal_recovery_batch: 0,
    pause_agent: 0,
    resume_agent: 0,
    spawn_agent: 0,
  };

  let trackRequests = false;
  const handleRequest = (nextRequest: import('@playwright/test').Request): void => {
    if (!trackRequests) {
      return;
    }

    const url = nextRequest.url();
    if (!url.includes('/api/ipc/')) {
      return;
    }

    const channel = url.slice(url.lastIndexOf('/') + 1);
    if (channel in recoveryRequestCounts) {
      recoveryRequestCounts[channel] += 1;
    }
  };
  page.on('request', handleRequest);

  try {
    const reloadStartedAtMs = performance.now();
    trackRequests = true;
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    const shellVisibleAtMs = performance.now();
    const visibilityAtShellVisible = await page.evaluate((statusSelector) => {
      const statusElements = Array.from(document.querySelectorAll(statusSelector));
      return statusElements.map((element, index) => {
        if (!(element instanceof HTMLElement)) {
          return {
            agentId: null,
            index,
            isVisibleInViewport: false,
            status: null,
          };
        }

        const rect = element.getBoundingClientRect();
        return {
          agentId: element.getAttribute('data-terminal-agent-id'),
          index,
          isVisibleInViewport:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth,
          status: element.getAttribute('data-terminal-status'),
        };
      });
    }, TERMINAL_STATUS_SELECTOR);

    const readyPromises = Array.from({ length: totalTerminalCount }, (_, index) =>
      (async () => {
        await browserLab.waitForTerminalReady(page, index);
        return performance.now() - shellVisibleAtMs;
      })(),
    );

    const readyTimesMs = await Promise.all(readyPromises);

    const heavyShellReadyTimesMs = heavyShellTerminalIndices.map(
      (index) => readyTimesMs[index] ?? -1,
    );
    const startupTrace = await page.evaluate((storageKey) => {
      const windowWithTraceStore = window as typeof window & {
        [key: string]:
          | {
              fetches: Array<{ channel: string; durationMs: number; ok: boolean }>;
              longTasks: Array<{ durationMs: number; startMs: number }>;
              statusesByAgentId: Record<string, Array<{ atMs: number; status: string }>>;
            }
          | undefined;
      };
      return windowWithTraceStore[storageKey] ?? null;
    }, STARTUP_TRACE_STORAGE_KEY);
    const terminalAgentIds = await Promise.all(
      Array.from({ length: totalTerminalCount }, (_, index) =>
        page.locator(TERMINAL_STATUS_SELECTOR).nth(index).getAttribute('data-terminal-agent-id'),
      ),
    );

    const fetchDurationsByChannelMs: Record<string, number[]> = {};
    for (const entry of startupTrace?.fetches ?? []) {
      if (!(entry.channel in fetchDurationsByChannelMs)) {
        fetchDurationsByChannelMs[entry.channel] = [];
      }

      fetchDurationsByChannelMs[entry.channel]?.push(roundMilliseconds(entry.durationMs));
    }

    const longTaskDurations = (startupTrace?.longTasks ?? []).map((entry) => entry.durationMs);
    const longTaskTotalMs = longTaskDurations.reduce((total, durationMs) => total + durationMs, 0);
    const longTaskMaxMs = longTaskDurations.length > 0 ? Math.max(...longTaskDurations) : 0;
    const statusHistories = terminalAgentIds.map((agentId) =>
      agentId ? [...(startupTrace?.statusesByAgentId[agentId] ?? [])] : [],
    );
    const replayTraceEntries = await page.evaluate(() => {
      return [
        ...((
          window as typeof window & {
            __PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?: TerminalReplayTraceEntry[];
          }
        ).__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ ?? []),
      ];
    });
    const attachTraceEntries = await page.evaluate(() => {
      const traceStore = (
        window as typeof window & {
          __PARALLEL_CODE_TERMINAL_ATTACH_TRACE__?: Record<string, TerminalAttachTraceEntry>;
        }
      ).__PARALLEL_CODE_TERMINAL_ATTACH_TRACE__;
      return traceStore ? Object.values(traceStore) : [];
    });
    return {
      attachTraceEntries,
      fetchDurationsByChannelMs,
      heavyShellReadyTimesMs,
      longTaskCount: longTaskDurations.length,
      longTaskMaxMs: roundMilliseconds(longTaskMaxMs),
      longTaskTotalMs: roundMilliseconds(longTaskTotalMs),
      replayTraceEntries,
      recoveryRequestCounts,
      shellVisibleMs: roundMilliseconds(shellVisibleAtMs - reloadStartedAtMs),
      statusHistories,
      totalReadyMs: roundMilliseconds(Math.max(...readyTimesMs)),
      visibleTerminalCountAtShellVisible: visibilityAtShellVisible.filter(
        (entry) => entry.isVisibleInViewport,
      ).length,
      visibilityAtShellVisible,
    };
  } finally {
    trackRequests = false;
    page.off('request', handleRequest);
  }
}

test.describe('browser-lab terminal startup experiments', () => {
  test.skip(
    !RUN_TERMINAL_STARTUP_EXPERIMENT,
    'Manual terminal startup benchmark. Set RUN_TERMINAL_STARTUP_EXPERIMENT=1 to run.',
  );

  test.use({
    scenario: createPromptReadyScenario(),
  });

  for (const shellCount of TERMINAL_STARTUP_SHELL_COUNTS) {
    test(`measures reload restore with ${shellCount} large-history shell terminal${shellCount === 1 ? '' : 's'}`, async ({
      browser,
      browserLab,
      request,
    }) => {
      test.setTimeout(300_000);

      const { page } = await browserLab.openSession(browser, {
        displayName: `Startup Experiment ${shellCount}`,
      });

      await browserLab.waitForTerminalReady(page);

      const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
        request,
        IPC.ListRunningAgentIds,
      );

      const shellAgentIds: string[] = [];
      const shellTerminalIndices: number[] = [];

      for (let index = 0; index < shellCount; index += 1) {
        const shellTerminalIndex = await browserLab.createShellTerminal(page);
        const shellAgentId = await waitForNewRunningAgentId(
          browserLab,
          request,
          initialRunningAgentIds,
          shellAgentIds,
        );
        shellAgentIds.push(shellAgentId);
        shellTerminalIndices.push(shellTerminalIndex);
      }

      for (const [index, shellAgentId] of shellAgentIds.entries()) {
        await primeLargeShellScrollback(
          browserLab,
          page,
          request,
          shellAgentId,
          shellTerminalIndices[index] ?? 0,
          `__STARTUP_EXPERIMENT_DONE_${shellCount}_${index}__`,
        );
      }

      const experimentResult = await measureReloadRestore(
        browserLab,
        page,
        request,
        shellTerminalIndices,
        1 + shellCount,
      );

      const diagnosticsAfter = await browserLab.invokeIpc<BackendRuntimeDiagnosticsSnapshot>(
        request,
        IPC.GetBackendRuntimeDiagnostics,
      );
      const heavyShellReadyMinMs =
        experimentResult.heavyShellReadyTimesMs.length > 0
          ? Math.min(...experimentResult.heavyShellReadyTimesMs)
          : 0;
      const heavyShellReadyMaxMs =
        experimentResult.heavyShellReadyTimesMs.length > 0
          ? Math.max(...experimentResult.heavyShellReadyTimesMs)
          : 0;

      console.warn(
        JSON.stringify(
          {
            diagnosticsAfter: summarizeBackendDiagnostics(diagnosticsAfter),
            experiment: {
              attachTraceSummary: summarizeAttachTraces(experimentResult.attachTraceEntries),
              fetchDurationsByChannelMs: summarizeDurationsByChannel(
                experimentResult.fetchDurationsByChannelMs,
              ),
              heavyShellReadyMaxMs,
              heavyShellReadyMinMs,
              heavyShellReadyTimesMs: experimentResult.heavyShellReadyTimesMs,
              heavyShellSpreadMs: heavyShellReadyMaxMs - heavyShellReadyMinMs,
              longTaskCount: experimentResult.longTaskCount,
              longTaskMaxMs: experimentResult.longTaskMaxMs,
              longTaskTotalMs: experimentResult.longTaskTotalMs,
              replayTraceSummary: summarizeReplayTraces(experimentResult.replayTraceEntries),
              recoveryRequestCounts: experimentResult.recoveryRequestCounts,
              shellCount,
              shellVisibleMs: experimentResult.shellVisibleMs,
              statusHistories: experimentResult.statusHistories,
              totalReadyMs: experimentResult.totalReadyMs,
              visibilityAtShellVisible: experimentResult.visibilityAtShellVisible,
              visibleTerminalCountAtShellVisible:
                experimentResult.visibleTerminalCountAtShellVisible,
            },
          },
          null,
          2,
        ),
      );
    });
  }
});
