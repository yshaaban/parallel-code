import { IPC } from '../../electron/ipc/channels.js';

import { expect, test } from './harness/fixtures.js';
import { createPromptReadyScenario } from './harness/scenarios.js';

const RUN_TERMINAL_STARTUP_EXPERIMENT = process.env.RUN_TERMINAL_STARTUP_EXPERIMENT === '1';

interface TerminalStartupExperimentCase {
  key: string;
  largeHistoryLineCount?: number;
  shellCount: number;
  viewportHeight: number;
  viewportWidth: number;
  workload: TerminalStartupExperimentWorkload;
  wrappedOutputLineCount?: number;
}

type TerminalStartupExperimentWorkload = 'cursor-heavy' | 'large-history' | 'wrapped-output';
type TerminalStartupPaintRole = 'hidden' | 'selected' | 'visible-sibling';

interface TerminalStartupExperimentVariant {
  description: string;
  forceDomRenderer?: boolean;
  key: string;
  terminalExperiments?: Record<string, unknown>;
}

const TERMINAL_STARTUP_PAINT_ROLES: readonly TerminalStartupPaintRole[] = [
  'hidden',
  'selected',
  'visible-sibling',
];

const DEFAULT_TERMINAL_STARTUP_EXPERIMENT_CASES: readonly TerminalStartupExperimentCase[] = [
  {
    key: 'default-1-shell',
    shellCount: 1,
    viewportHeight: 900,
    viewportWidth: 1440,
    workload: 'large-history',
  },
  {
    key: 'default-2-shells',
    shellCount: 2,
    viewportHeight: 900,
    viewportWidth: 1440,
    workload: 'large-history',
  },
  {
    key: 'default-3-shells',
    shellCount: 3,
    viewportHeight: 900,
    viewportWidth: 1440,
    workload: 'large-history',
  },
  {
    key: 'compact-3-shells',
    largeHistoryLineCount: 5_000,
    shellCount: 3,
    viewportHeight: 260,
    viewportWidth: 1440,
    workload: 'large-history',
  },
  {
    key: 'default-4-shells',
    largeHistoryLineCount: 5_000,
    shellCount: 4,
    viewportHeight: 900,
    viewportWidth: 1440,
    workload: 'large-history',
  },
  {
    key: 'wrapped-2-shells',
    shellCount: 2,
    viewportHeight: 900,
    viewportWidth: 1440,
    workload: 'wrapped-output',
  },
  {
    key: 'cursor-heavy-2-shells',
    shellCount: 2,
    viewportHeight: 900,
    viewportWidth: 1440,
    workload: 'cursor-heavy',
  },
] as const;

const BUILT_IN_TERMINAL_STARTUP_EXPERIMENT_VARIANTS: readonly TerminalStartupExperimentVariant[] = [
  {
    description: 'Current shipped startup policy',
    key: 'baseline',
  },
  {
    description: 'Larger visible sibling attach chunks with no switch-window attach yielding',
    key: 'sibling-coalesce',
    terminalExperiments: {
      label: 'startup-sibling-coalesce',
      startupAttachSwitchWindowChunkByteOverrides: {
        'active-visible': 256 * 1024,
        'visible-background': 256 * 1024,
      },
      startupAttachYieldOverrides: {
        'active-visible': false,
        'visible-background': false,
      },
    },
  },
  {
    description:
      'More aggressively coalesce visible-sibling attach replay into larger startup writes',
    key: 'sibling-max-coalesce',
    terminalExperiments: {
      label: 'startup-sibling-max-coalesce',
      startupAttachChunkByteOverrides: {
        'active-visible': 512 * 1024,
        'visible-background': 512 * 1024,
      },
      startupAttachSwitchWindowChunkByteOverrides: {
        'active-visible': 512 * 1024,
        'visible-background': 512 * 1024,
      },
      startupAttachYieldOverrides: {
        'active-visible': false,
        'visible-background': false,
      },
    },
  },
  {
    description: 'Keep visible siblings blocked until selected startup fully settles',
    key: 'sibling-paint-settled',
    terminalExperiments: {
      label: 'startup-sibling-paint-settled',
      startupHiddenReplayUnblockPhase: 'all-visible-paint',
      startupVisibleSiblingReplayUnblockPhase: 'paint-settled',
    },
  },
  {
    description: 'Skip the extra session RAF fit for non-selected visible startup terminals',
    key: 'sibling-fit-lite',
    terminalExperiments: {
      label: 'startup-sibling-fit-lite',
      startupSkipNonSelectedVisibleSessionRafFit: true,
    },
  },
  {
    description:
      'Gate visible-sibling session fit stabilization until the selected startup paint is ready',
    key: 'sibling-fit-staged',
    terminalExperiments: {
      label: 'startup-sibling-fit-staged',
      startupSkipNonSelectedVisibleSessionRafFit: true,
      startupVisibleSiblingSessionFitGateUntilSelectedPaintReady: true,
    },
  },
  {
    description:
      'Schedule hidden startup replay continuations with background browser task priority',
    key: 'prioritized-hidden',
    terminalExperiments: {
      label: 'startup-prioritized-hidden',
      startupTaskSchedulingMode: 'post-task',
      startupTaskSchedulingRoles: {
        hidden: true,
      },
    },
  },
  {
    description:
      'Schedule visible-sibling startup replay continuations with user-visible browser task priority',
    key: 'prioritized-siblings',
    terminalExperiments: {
      label: 'startup-prioritized-siblings',
      startupTaskSchedulingMode: 'post-task',
      startupTaskSchedulingRoles: {
        'visible-sibling': true,
      },
    },
  },
  {
    description:
      'Schedule visible siblings and hidden startup replay continuations with browser task priorities',
    key: 'prioritized-all',
    terminalExperiments: {
      label: 'startup-prioritized-all',
      startupTaskSchedulingMode: 'post-task',
      startupTaskSchedulingRoles: {
        hidden: true,
        'visible-sibling': true,
      },
    },
  },
  {
    description: 'Combine coalesced visible replay, settled sibling gating, and fit-lite startup',
    key: 'combined',
    terminalExperiments: {
      label: 'startup-combined',
      startupAttachSwitchWindowChunkByteOverrides: {
        'active-visible': 256 * 1024,
        'visible-background': 256 * 1024,
      },
      startupAttachYieldOverrides: {
        'active-visible': false,
        'visible-background': false,
      },
      startupHiddenReplayUnblockPhase: 'selected-paint',
      startupSkipNonSelectedVisibleSessionRafFit: true,
      startupVisibleSiblingReplayUnblockPhase: 'paint-settled',
    },
  },
  {
    description: 'Force DOM rendering to isolate replay cost from WebGL startup behavior',
    forceDomRenderer: true,
    key: 'dom-only',
    terminalExperiments: {
      label: 'startup-dom-only',
    },
  },
] as const;

const TERMINAL_STARTUP_EXPERIMENT_CASES = parseTerminalStartupExperimentCases(
  process.env.TERMINAL_STARTUP_EXPERIMENT_CASES,
  process.env.TERMINAL_STARTUP_SHELL_COUNTS,
);
const TERMINAL_STARTUP_EXPERIMENT_VARIANTS = parseTerminalStartupExperimentVariants(
  process.env.TERMINAL_STARTUP_EXPERIMENT_VARIANTS,
);

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarizeRoleShare(
  valuesByRole: Record<TerminalStartupPaintRole, number>,
): Record<TerminalStartupPaintRole, number> {
  const total = TERMINAL_STARTUP_PAINT_ROLES.reduce((sum, role) => sum + valuesByRole[role], 0);
  return Object.fromEntries(
    TERMINAL_STARTUP_PAINT_ROLES.map((role) => [
      role,
      total <= 0 ? 0 : roundMilliseconds((valuesByRole[role] / total) * 100),
    ]),
  ) as Record<TerminalStartupPaintRole, number>;
}

function summarizePerRoleRatio(
  numeratorByRole: Record<TerminalStartupPaintRole, number>,
  denominatorByRole: Record<TerminalStartupPaintRole, number>,
): Record<TerminalStartupPaintRole, number> {
  return Object.fromEntries(
    TERMINAL_STARTUP_PAINT_ROLES.map((role) => [
      role,
      denominatorByRole[role] <= 0
        ? 0
        : roundMilliseconds(numeratorByRole[role] / denominatorByRole[role]),
    ]),
  ) as Record<TerminalStartupPaintRole, number>;
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
    terminalStateFallbacks: number;
    terminalStateResponses: number;
  };
}

interface ReloadExperimentResult {
  attachTraceEntries: TerminalAttachTraceEntry[];
  fetchDurationsByChannelMs: Record<string, number[]>;
  heavyShellLogicalReadyTimesMs: number[];
  heavyShellPaintReadyTimesMs: number[];
  heavyShellVisiblePaintReadyTimesMs: number[];
  heavyShellReadyTimesMs: number[];
  longAnimationFrameBlockingMaxMs: number;
  longAnimationFrameBlockingTotalMs: number;
  longAnimationFrameCount: number;
  longAnimationFrameMaxMs: number;
  longAnimationFrameTotalMs: number;
  longTaskCount: number;
  longTaskMaxMs: number;
  longTaskTotalMs: number;
  replayTraceEntries: TerminalReplayTraceEntry[];
  recoveryRequestCounts: Record<string, number>;
  shellVisibleMs: number;
  selectedTerminalIndexAtShellVisible: number;
  selectedTerminalLogicalReadyMs: number;
  selectedTerminalPaintReadyMs: number;
  selectedTerminalPaintReadyTimedOut: boolean;
  selectedPaintAfterLogicalMs: number;
  selectedVsFirstVisibleSiblingPaintGapMs: number | null;
  selectedVsLastVisibleSiblingPaintGapMs: number | null;
  statusHistories: Array<
    Array<{
      atMs: number;
      status: string;
    }>
  >;
  totalLogicalReadyMs: number;
  totalPaintReadyMs: number;
  totalVisiblePaintReadyMs: number;
  totalReadyMs: number;
  hiddenTerminalCountAtShellVisible: number;
  logicalReadyTimeoutIndices: number[];
  visibleSiblingCountAtShellVisible: number;
  visiblePaintReadyTimeoutIndices: number[];
  visibleSiblingPaintReadyTimeoutCount: number;
  visibleSiblingPaintReadyTimesMs: number[];
  visiblePaintReadyTimesMs: number[];
  visibleTerminalCountAtShellVisible: number;
  visibilityAtShellVisible: TerminalVisibilitySnapshot[];
  firstVisibleSiblingPaintReadyMs: number | null;
  lastVisibleSiblingPaintReadyMs: number | null;
}

interface SelectedTerminalResolutionOptions {
  heavyShellTerminalIndices: readonly number[];
  page: import('@playwright/test').Page;
  visibleTerminalIndicesAtShellVisible: readonly number[];
}

interface TerminalReplayTraceEntry {
  agentId: string;
  applyMs: number;
  chunkCount: number;
  outputPriority:
    | 'focused'
    | 'switch-target-visible'
    | 'active-visible'
    | 'visible-background'
    | 'hidden';
  pauseMs: number;
  reason: 'attach' | 'backpressure' | 'reconnect' | 'renderer-loss';
  recoveryFetchMs: number;
  recoveryKind: 'noop' | 'delta' | 'snapshot' | 'terminal-state';
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
const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';

async function createShellTerminalWithExtendedTimeout(
  page: import('@playwright/test').Page,
  browserLab: {
    createShellTerminal: (page: import('@playwright/test').Page) => Promise<number>;
  },
): Promise<number> {
  return browserLab.createShellTerminal(page);
}

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

      type StartupLongAnimationFrameTrace = {
        blockingDurationMs: number;
        durationMs: number;
        startMs: number;
      };

      type StartupStatusTrace = {
        atMs: number;
        status: string;
      };

      type StartupTraceStore = {
        fetches: StartupFetchTrace[];
        longAnimationFrames: StartupLongAnimationFrameTrace[];
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
        longAnimationFrames: [],
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

        try {
          const longAnimationFrameObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              const longAnimationFrameEntry = entry as PerformanceEntry & {
                blockingDuration?: number;
              };
              traceStore.longAnimationFrames.push({
                blockingDurationMs:
                  typeof longAnimationFrameEntry.blockingDuration === 'number'
                    ? longAnimationFrameEntry.blockingDuration
                    : 0,
                durationMs: entry.duration,
                startMs: entry.startTime,
              });
            }
          });
          longAnimationFrameObserver.observe({ entryTypes: ['long-animation-frame'] });
        } catch {
          // Older Chromium builds may not expose this entry type yet.
        }
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
  const counts = rawValue
    ?.split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return counts && counts.length > 0 ? counts : [];
}

function parseTerminalStartupExperimentCases(
  rawCases: string | undefined,
  rawShellCounts: string | undefined,
): readonly TerminalStartupExperimentCase[] {
  if (rawCases) {
    const parsedCases = rawCases
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [
          key,
          shellCountRaw,
          viewportWidthRaw,
          viewportHeightRaw,
          workloadRaw,
          workloadSizeRaw,
        ] = entry.split(':');
        const shellCount = Number.parseInt(shellCountRaw ?? '', 10);
        const viewportWidth = Number.parseInt(viewportWidthRaw ?? '', 10);
        const viewportHeight = Number.parseInt(viewportHeightRaw ?? '', 10);
        const workloadSize =
          workloadSizeRaw === undefined ? null : Number.parseInt(workloadSizeRaw, 10);
        const workload = normalizeTerminalStartupExperimentWorkload(workloadRaw);
        if (
          !key ||
          !Number.isInteger(shellCount) ||
          shellCount <= 0 ||
          !Number.isInteger(viewportWidth) ||
          viewportWidth <= 0 ||
          !Number.isInteger(viewportHeight) ||
          viewportHeight <= 0 ||
          (workloadSizeRaw !== undefined &&
            (!Number.isInteger(workloadSize) || (workloadSize ?? 0) <= 0)) ||
          workload === null
        ) {
          return null;
        }

        const parsedCase: TerminalStartupExperimentCase = {
          key,
          shellCount,
          viewportHeight,
          viewportWidth,
          workload,
        };

        if (workload === 'large-history' && workloadSize !== null) {
          parsedCase.largeHistoryLineCount = workloadSize;
        }
        if (workload === 'wrapped-output' && workloadSize !== null) {
          parsedCase.wrappedOutputLineCount = workloadSize;
        }

        return parsedCase;
      })
      .filter((entry): entry is TerminalStartupExperimentCase => entry !== null);
    if (parsedCases.length > 0) {
      return parsedCases;
    }
  }

  const shellCounts = parseTerminalStartupShellCounts(rawShellCounts);
  if (shellCounts.length > 0) {
    return shellCounts.map((shellCount) => ({
      key: `shell-count-${shellCount}`,
      shellCount,
      viewportHeight: 720,
      viewportWidth: 1440,
      workload: 'large-history',
    }));
  }

  return DEFAULT_TERMINAL_STARTUP_EXPERIMENT_CASES;
}

function normalizeTerminalStartupExperimentWorkload(
  value: string | undefined,
): TerminalStartupExperimentWorkload | null {
  switch (value?.trim()) {
    case undefined:
    case '':
    case 'large-history':
      return 'large-history';
    case 'wrapped-output':
      return 'wrapped-output';
    case 'cursor-heavy':
      return 'cursor-heavy';
    default:
      return null;
  }
}

function summarizeWorkloadSize(experimentCase: TerminalStartupExperimentCase): number | null {
  switch (experimentCase.workload) {
    case 'large-history':
      return experimentCase.largeHistoryLineCount ?? 100_000;
    case 'wrapped-output':
      return experimentCase.wrappedOutputLineCount ?? 12_000;
    case 'cursor-heavy':
      return 8_000;
    default:
      return null;
  }
}

function parseTerminalStartupExperimentVariants(
  rawVariants: string | undefined,
): readonly TerminalStartupExperimentVariant[] {
  const defaultVariant = BUILT_IN_TERMINAL_STARTUP_EXPERIMENT_VARIANTS[0];
  if (!defaultVariant) {
    return [];
  }

  const requestedVariantKeys = rawVariants
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (!requestedVariantKeys || requestedVariantKeys.length === 0) {
    return [defaultVariant];
  }

  const variants = requestedVariantKeys
    .map((variantKey) =>
      BUILT_IN_TERMINAL_STARTUP_EXPERIMENT_VARIANTS.find((variant) => variant.key === variantKey),
    )
    .filter((variant): variant is TerminalStartupExperimentVariant => variant !== undefined);

  return variants.length > 0 ? variants : [defaultVariant];
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

function summarizeStartupPaintAttribution(
  rendererDiagnostics: {
    terminalStartupPaint?: {
      fitExecutionCounts: Record<TerminalStartupPaintRole, number>;
      fitExecutionSourceCounts: Record<
        TerminalStartupPaintRole,
        Record<
          'lifecycle' | 'manager' | 'resize-commit' | 'session-immediate' | 'session-raf',
          number
        >
      >;
      fitGeometryChangeCounts: Record<TerminalStartupPaintRole, number>;
      fitScheduleCounts: Record<TerminalStartupPaintRole, number>;
      fitScheduleReasonCounts: Record<
        TerminalStartupPaintRole,
        Record<
          | 'attach'
          | 'ready'
          | 'renderer-loss'
          | 'restore'
          | 'spawn-ready'
          | 'startup'
          | 'visibility',
          number
        >
      >;
      renderEventCounts: Record<TerminalStartupPaintRole, number>;
      taskScheduleCounts: Record<TerminalStartupPaintRole, number>;
      writeMaxBytes: Record<TerminalStartupPaintRole, number>;
      writeSizeBucketCounts: Record<
        TerminalStartupPaintRole,
        Record<'gte-128k' | 'k32-to-128k' | 'k4-to-32k' | 'lt-4k', number>
      >;
      writeBytes: Record<TerminalStartupPaintRole, number>;
      writeCounts: Record<TerminalStartupPaintRole, number>;
    };
  } | null,
): {
  fitExecutionShareByRole: Record<TerminalStartupPaintRole, number>;
  fitExecutionsPerWriteByRole: Record<TerminalStartupPaintRole, number>;
  fitScheduleShareByRole: Record<TerminalStartupPaintRole, number>;
  fitSchedulesPerWriteByRole: Record<TerminalStartupPaintRole, number>;
  renderEventShareByRole: Record<TerminalStartupPaintRole, number>;
  raw: NonNullable<typeof rendererDiagnostics>['terminalStartupPaint'];
  taskScheduleShareByRole: Record<TerminalStartupPaintRole, number>;
  renderEventsPerWriteByRole: Record<TerminalStartupPaintRole, number>;
  writeAverageBytesByRole: Record<TerminalStartupPaintRole, number>;
  writeByteShareByRole: Record<TerminalStartupPaintRole, number>;
  writeCountShareByRole: Record<TerminalStartupPaintRole, number>;
  writeMaxBytesByRole: Record<TerminalStartupPaintRole, number>;
} | null {
  const startupPaint = rendererDiagnostics?.terminalStartupPaint;
  if (!startupPaint) {
    return null;
  }

  return {
    fitExecutionShareByRole: summarizeRoleShare(startupPaint.fitExecutionCounts),
    fitExecutionsPerWriteByRole: summarizePerRoleRatio(
      startupPaint.fitExecutionCounts,
      startupPaint.writeCounts,
    ),
    fitScheduleShareByRole: summarizeRoleShare(startupPaint.fitScheduleCounts),
    fitSchedulesPerWriteByRole: summarizePerRoleRatio(
      startupPaint.fitScheduleCounts,
      startupPaint.writeCounts,
    ),
    raw: startupPaint,
    renderEventShareByRole: summarizeRoleShare(startupPaint.renderEventCounts),
    renderEventsPerWriteByRole: summarizePerRoleRatio(
      startupPaint.renderEventCounts,
      startupPaint.writeCounts,
    ),
    taskScheduleShareByRole: summarizeRoleShare(startupPaint.taskScheduleCounts),
    writeByteShareByRole: summarizeRoleShare(startupPaint.writeBytes),
    writeCountShareByRole: summarizeRoleShare(startupPaint.writeCounts),
    writeAverageBytesByRole: summarizePerRoleRatio(
      startupPaint.writeBytes,
      startupPaint.writeCounts,
    ),
    writeMaxBytesByRole: { ...startupPaint.writeMaxBytes },
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

function buildTerminalStartupWorkloadCommand(
  experimentCase: TerminalStartupExperimentCase,
  marker: string,
): string {
  switch (experimentCase.workload) {
    case 'large-history':
      return `yes 12345678901234567890 | head -n ${
        experimentCase.largeHistoryLineCount ?? 100_000
      }; printf "${marker}\\n"`;
    case 'wrapped-output':
      return (
        'long_line="$(printf \'WRAP1234567890%.0s\' $(seq 1 24))"; ' +
        `yes "$long_line" | head -n ${experimentCase.wrappedOutputLineCount ?? 12_000}; printf "${marker}\\\\n"`
      );
    case 'cursor-heavy':
      return (
        'for i in $(seq 1 8000); do ' +
        'printf \'\\033[H\\033[2Jframe-%05d\\nstatus-%05d\\n\' "$i" "$i"; ' +
        'done; ' +
        `printf "${marker}\\\\n"`
      );
    default:
      return `printf "${marker}\\n"`;
  }
}

async function primeTerminalStartupWorkload(
  browserLab: {
    runInTerminal: (
      page: import('@playwright/test').Page,
      text: string,
      options?: { pressEnter?: boolean; terminalIndex?: number },
    ) => Promise<void>;
  },
  page: import('@playwright/test').Page,
  terminalIndex: number,
  experimentCase: TerminalStartupExperimentCase,
  marker: string,
): Promise<void> {
  const command = buildTerminalStartupWorkloadCommand(experimentCase, marker);
  await browserLab.runInTerminal(page, command, {
    terminalIndex,
  });
}

async function resolveSelectedTerminalIndexAtShellVisible(
  options: SelectedTerminalResolutionOptions,
): Promise<number> {
  const expectedSelectedTerminalIndex =
    options.heavyShellTerminalIndices[options.heavyShellTerminalIndices.length - 1] ?? null;
  if (
    expectedSelectedTerminalIndex !== null &&
    options.visibleTerminalIndicesAtShellVisible.includes(expectedSelectedTerminalIndex)
  ) {
    return expectedSelectedTerminalIndex;
  }

  const interactiveVisibleTerminalIndex = await waitForInteractiveVisibleTerminalIndex(
    options.page,
    options.visibleTerminalIndicesAtShellVisible,
  );

  return (
    interactiveVisibleTerminalIndex ??
    options.visibleTerminalIndicesAtShellVisible[
      options.visibleTerminalIndicesAtShellVisible.length - 1
    ] ??
    0
  );
}

async function waitForInteractiveVisibleTerminalIndex(
  page: import('@playwright/test').Page,
  visibleTerminalIndices: readonly number[],
): Promise<number | null> {
  const deadlineAtMs = performance.now() + 3_000;
  while (performance.now() < deadlineAtMs) {
    const interactiveIndex = await page.evaluate(
      ({ inputSelector, statusSelector, visibleIndices }) => {
        const statusElements = Array.from(document.querySelectorAll<HTMLElement>(statusSelector));
        const matchingInteractiveIndex =
          visibleIndices.find((index) => {
            const element = statusElements[index];
            return element?.getAttribute('data-terminal-surface-tier') === 'interactive-live';
          }) ?? null;
        if (matchingInteractiveIndex !== null) {
          return matchingInteractiveIndex;
        }

        const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>(inputSelector));
        const activeIndex = inputs.findIndex((input) => input === document.activeElement);
        if (activeIndex >= 0 && visibleIndices.includes(activeIndex)) {
          return activeIndex;
        }

        return null;
      },
      {
        inputSelector: TERMINAL_INPUT_SELECTOR,
        statusSelector: TERMINAL_STATUS_SELECTOR,
        visibleIndices: [...visibleTerminalIndices],
      },
    );
    if (interactiveIndex !== null) {
      return interactiveIndex;
    }

    await page.waitForTimeout(50);
  }

  return null;
}

async function measureReloadRestore(
  browserLab: {
    invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
    waitForTerminalLogicalReady: (
      page: import('@playwright/test').Page,
      terminalIndex?: number,
    ) => Promise<void>;
    waitForTerminalReady: (
      page: import('@playwright/test').Page,
      terminalIndex?: number,
    ) => Promise<void>;
    waitForTerminalPaintReady: (
      page: import('@playwright/test').Page,
      terminalIndex?: number,
      options?: { timeoutMs?: number },
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

    const visibleTerminalIndicesAtShellVisible = visibilityAtShellVisible
      .filter((entry) => entry.isVisibleInViewport)
      .map((entry) => entry.index);
    const selectedTerminalIndexAtShellVisible = await resolveSelectedTerminalIndexAtShellVisible({
      heavyShellTerminalIndices,
      page,
      visibleTerminalIndicesAtShellVisible,
    });

    const selectedTerminalPaintReadyPromise = (async () => {
      try {
        await browserLab.waitForTerminalPaintReady(page, selectedTerminalIndexAtShellVisible, {
          timeoutMs: 20_000,
        });
        return {
          readyAtMs: performance.now() - shellVisibleAtMs,
          timedOut: false,
        };
      } catch {
        return {
          readyAtMs: null,
          timedOut: true,
        };
      }
    })();

    const logicalReadyPromises = visibleTerminalIndicesAtShellVisible.map((index) =>
      (async () => {
        try {
          await browserLab.waitForTerminalLogicalReady(page, index);
          return {
            index,
            readyAtMs: performance.now() - shellVisibleAtMs,
          };
        } catch {
          return {
            index,
            readyAtMs: null,
          };
        }
      })(),
    );

    const logicalReadyPairs = await Promise.all(logicalReadyPromises);
    const logicalReadyTimeByIndex = new Map(
      logicalReadyPairs
        .filter((entry): entry is { index: number; readyAtMs: number } => entry.readyAtMs !== null)
        .map((entry) => [entry.index, entry.readyAtMs]),
    );
    const logicalReadyTimeoutIndices = logicalReadyPairs
      .filter((entry) => entry.readyAtMs === null)
      .map((entry) => entry.index);
    const logicalReadyTimesMs = visibleTerminalIndicesAtShellVisible
      .map((index) => logicalReadyTimeByIndex.get(index) ?? -1)
      .filter((readyAtMs) => readyAtMs >= 0);
    const visiblePaintReadyPairs = await Promise.all(
      visibleTerminalIndicesAtShellVisible.map(async (index) => {
        try {
          await browserLab.waitForTerminalPaintReady(page, index, {
            timeoutMs: index === selectedTerminalIndexAtShellVisible ? 20_000 : 15_000,
          });
          return {
            index,
            readyAtMs: performance.now() - shellVisibleAtMs,
          };
        } catch {
          return {
            index,
            readyAtMs: null,
          };
        }
      }),
    );
    const visiblePaintReadyTimeByIndex = new Map(
      visiblePaintReadyPairs
        .filter((entry): entry is { index: number; readyAtMs: number } => entry.readyAtMs !== null)
        .map((entry) => [entry.index, entry.readyAtMs]),
    );
    const visiblePaintReadyTimeoutIndices = visiblePaintReadyPairs
      .filter((entry) => entry.readyAtMs === null)
      .map((entry) => entry.index);
    const visiblePaintReadyTimesMs = visibleTerminalIndicesAtShellVisible.map(
      (index) => visiblePaintReadyTimeByIndex.get(index) ?? -1,
    );
    const completedVisiblePaintReadyTimesMs = visiblePaintReadyTimesMs.filter(
      (readyAtMs) => readyAtMs >= 0,
    );
    const visibleSiblingIndicesAtShellVisible = visibleTerminalIndicesAtShellVisible.filter(
      (index) => index !== selectedTerminalIndexAtShellVisible,
    );
    const visibleSiblingPaintReadyTimesMs = visibleSiblingIndicesAtShellVisible
      .map((index) => visiblePaintReadyTimeByIndex.get(index) ?? -1)
      .filter((readyAtMs) => readyAtMs >= 0);

    const heavyShellLogicalReadyTimesMs = heavyShellTerminalIndices
      .map((index) => logicalReadyTimeByIndex.get(index) ?? -1)
      .filter((readyAtMs) => readyAtMs >= 0);
    const heavyShellPaintReadyTimesMs = heavyShellTerminalIndices
      .map((index) => visiblePaintReadyTimeByIndex.get(index) ?? -1)
      .filter((readyAtMs) => readyAtMs >= 0);
    const heavyShellVisiblePaintReadyTimesMs = heavyShellPaintReadyTimesMs;
    const selectedTerminalPaintReadyResult = await selectedTerminalPaintReadyPromise;
    const selectedTerminalPaintReadyMs = roundMilliseconds(
      selectedTerminalPaintReadyResult.readyAtMs ?? -1,
    );
    const selectedTerminalLogicalReadyMs =
      logicalReadyTimeByIndex.get(selectedTerminalIndexAtShellVisible) ?? -1;
    const selectedPaintAfterLogicalMs = roundMilliseconds(
      Math.max(0, selectedTerminalPaintReadyMs - selectedTerminalLogicalReadyMs),
    );
    const firstVisibleSiblingPaintReadyMs =
      visibleSiblingPaintReadyTimesMs.length > 0
        ? roundMilliseconds(Math.min(...visibleSiblingPaintReadyTimesMs))
        : null;
    const lastVisibleSiblingPaintReadyMs =
      visibleSiblingPaintReadyTimesMs.length > 0
        ? roundMilliseconds(Math.max(...visibleSiblingPaintReadyTimesMs))
        : null;
    const totalLogicalReadyMs = roundMilliseconds(
      logicalReadyTimesMs.length > 0 ? Math.max(...logicalReadyTimesMs) : 0,
    );
    const totalPaintReadyMs = roundMilliseconds(
      completedVisiblePaintReadyTimesMs.length > 0
        ? Math.max(...completedVisiblePaintReadyTimesMs)
        : 0,
    );
    const heavyShellReadyTimesMs = heavyShellLogicalReadyTimesMs;
    const startupTrace = await page.evaluate((storageKey) => {
      const windowWithTraceStore = window as typeof window & {
        [key: string]:
          | {
              fetches: Array<{ channel: string; durationMs: number; ok: boolean }>;
              longAnimationFrames: Array<{
                blockingDurationMs: number;
                durationMs: number;
                startMs: number;
              }>;
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
    const longAnimationFrames = startupTrace?.longAnimationFrames ?? [];
    const longAnimationFrameDurations = longAnimationFrames.map((entry) => entry.durationMs);
    const longAnimationFrameBlockingDurations = longAnimationFrames.map(
      (entry) => entry.blockingDurationMs,
    );
    const longAnimationFrameTotalMs = longAnimationFrameDurations.reduce(
      (total, durationMs) => total + durationMs,
      0,
    );
    const longAnimationFrameMaxMs =
      longAnimationFrameDurations.length > 0 ? Math.max(...longAnimationFrameDurations) : 0;
    const longAnimationFrameBlockingTotalMs = longAnimationFrameBlockingDurations.reduce(
      (total, durationMs) => total + durationMs,
      0,
    );
    const longAnimationFrameBlockingMaxMs =
      longAnimationFrameBlockingDurations.length > 0
        ? Math.max(...longAnimationFrameBlockingDurations)
        : 0;
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
      heavyShellLogicalReadyTimesMs,
      heavyShellPaintReadyTimesMs,
      heavyShellVisiblePaintReadyTimesMs,
      heavyShellReadyTimesMs,
      longAnimationFrameBlockingMaxMs: roundMilliseconds(longAnimationFrameBlockingMaxMs),
      longAnimationFrameBlockingTotalMs: roundMilliseconds(longAnimationFrameBlockingTotalMs),
      longAnimationFrameCount: longAnimationFrames.length,
      longAnimationFrameMaxMs: roundMilliseconds(longAnimationFrameMaxMs),
      longAnimationFrameTotalMs: roundMilliseconds(longAnimationFrameTotalMs),
      longTaskCount: longTaskDurations.length,
      longTaskMaxMs: roundMilliseconds(longTaskMaxMs),
      longTaskTotalMs: roundMilliseconds(longTaskTotalMs),
      replayTraceEntries,
      recoveryRequestCounts,
      shellVisibleMs: roundMilliseconds(shellVisibleAtMs - reloadStartedAtMs),
      logicalReadyTimeoutIndices,
      selectedTerminalIndexAtShellVisible,
      selectedTerminalLogicalReadyMs: roundMilliseconds(selectedTerminalLogicalReadyMs),
      selectedTerminalPaintReadyMs,
      selectedTerminalPaintReadyTimedOut: selectedTerminalPaintReadyResult.timedOut,
      selectedPaintAfterLogicalMs,
      selectedVsFirstVisibleSiblingPaintGapMs:
        firstVisibleSiblingPaintReadyMs === null
          ? null
          : roundMilliseconds(firstVisibleSiblingPaintReadyMs - selectedTerminalPaintReadyMs),
      selectedVsLastVisibleSiblingPaintGapMs:
        lastVisibleSiblingPaintReadyMs === null
          ? null
          : roundMilliseconds(lastVisibleSiblingPaintReadyMs - selectedTerminalPaintReadyMs),
      statusHistories,
      totalLogicalReadyMs,
      totalPaintReadyMs,
      totalVisiblePaintReadyMs: totalPaintReadyMs,
      totalReadyMs: totalLogicalReadyMs,
      hiddenTerminalCountAtShellVisible:
        totalTerminalCount -
        visibilityAtShellVisible.filter((entry) => entry.isVisibleInViewport).length,
      visibleSiblingCountAtShellVisible: visibleSiblingIndicesAtShellVisible.length,
      visiblePaintReadyTimeoutIndices,
      visibleSiblingPaintReadyTimeoutCount: visiblePaintReadyTimeoutIndices.filter(
        (index) => index !== selectedTerminalIndexAtShellVisible,
      ).length,
      visibleSiblingPaintReadyTimesMs,
      visiblePaintReadyTimesMs,
      visibleTerminalCountAtShellVisible: visibilityAtShellVisible.filter(
        (entry) => entry.isVisibleInViewport,
      ).length,
      visibilityAtShellVisible,
      firstVisibleSiblingPaintReadyMs,
      lastVisibleSiblingPaintReadyMs,
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

  for (const experimentVariant of TERMINAL_STARTUP_EXPERIMENT_VARIANTS) {
    for (const experimentCase of TERMINAL_STARTUP_EXPERIMENT_CASES) {
      test(`measures reload restore for ${experimentVariant.key} / ${experimentCase.key}`, async ({
        browser,
        browserLab,
        request,
      }) => {
        test.setTimeout(300_000);

        const { page } = await browserLab.openSession(browser, {
          displayName: `Startup Experiment ${experimentVariant.key} ${experimentCase.key}`,
          prepareContext: async (context) => {
            await context.addInitScript(
              ({ forceDomRenderer, terminalExperiments }) => {
                if (forceDomRenderer) {
                  const originalGetContext = HTMLCanvasElement.prototype.getContext;
                  HTMLCanvasElement.prototype.getContext = function getContextWithoutWebgl(
                    contextId: string,
                    ...args: unknown[]
                  ): RenderingContext | null {
                    if (
                      contextId === 'webgl' ||
                      contextId === 'webgl2' ||
                      contextId === 'experimental-webgl'
                    ) {
                      return null;
                    }

                    return originalGetContext.call(this, contextId, ...args);
                  };
                }

                window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
                if (terminalExperiments) {
                  window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = terminalExperiments;
                }
              },
              {
                forceDomRenderer: experimentVariant.forceDomRenderer === true,
                terminalExperiments: experimentVariant.terminalExperiments ?? null,
              },
            );
          },
        });

        await browserLab.waitForTerminalPaintReady(page);

        const initialRunningAgentIds = await browserLab.invokeIpc<string[]>(
          request,
          IPC.ListRunningAgentIds,
        );

        const shellAgentIds: string[] = [];
        const shellTerminalIndices: number[] = [];

        for (let index = 0; index < experimentCase.shellCount; index += 1) {
          const shellTerminalIndex = await createShellTerminalWithExtendedTimeout(page, browserLab);
          const shellAgentId = await waitForNewRunningAgentId(
            browserLab,
            request,
            initialRunningAgentIds,
            shellAgentIds,
          );
          shellAgentIds.push(shellAgentId);
          shellTerminalIndices.push(shellTerminalIndex);
        }

        const workloadMarkers = shellAgentIds.map(
          (_, index) =>
            `__STARTUP_EXPERIMENT_DONE_${experimentVariant.key}_${experimentCase.key}_${index}__`,
        );
        for (const [index] of shellAgentIds.entries()) {
          await primeTerminalStartupWorkload(
            browserLab,
            page,
            shellTerminalIndices[index] ?? 0,
            experimentCase,
            workloadMarkers[index] ?? '',
          );
        }
        await Promise.all(
          shellAgentIds.map((terminalAgentId, index) =>
            browserLab.waitForAgentScrollback(
              request,
              terminalAgentId,
              workloadMarkers[index] ?? '',
              20_000,
            ),
          ),
        );

        await page.setViewportSize({
          height: experimentCase.viewportHeight,
          width: experimentCase.viewportWidth,
        });
        await browserLab.focusTerminal(
          page,
          shellTerminalIndices[shellTerminalIndices.length - 1] ?? 0,
        );

        const experimentResult = await measureReloadRestore(
          browserLab,
          page,
          request,
          shellTerminalIndices,
          1 + experimentCase.shellCount,
        );
        const rendererDiagnostics = await page.evaluate(() => {
          return window.__parallelCodeRendererRuntimeDiagnostics?.getSnapshot() ?? null;
        });

        const diagnosticsAfter = await browserLab.invokeIpc<BackendRuntimeDiagnosticsSnapshot>(
          request,
          IPC.GetBackendRuntimeDiagnostics,
        );
        const heavyShellLogicalReadyMinMs =
          experimentResult.heavyShellLogicalReadyTimesMs.length > 0
            ? Math.min(...experimentResult.heavyShellLogicalReadyTimesMs)
            : 0;
        const heavyShellLogicalReadyMaxMs =
          experimentResult.heavyShellLogicalReadyTimesMs.length > 0
            ? Math.max(...experimentResult.heavyShellLogicalReadyTimesMs)
            : 0;
        const heavyShellPaintReadyMinMs =
          experimentResult.heavyShellPaintReadyTimesMs.length > 0
            ? Math.min(...experimentResult.heavyShellPaintReadyTimesMs)
            : 0;
        const heavyShellPaintReadyMaxMs =
          experimentResult.heavyShellPaintReadyTimesMs.length > 0
            ? Math.max(...experimentResult.heavyShellPaintReadyTimesMs)
            : 0;
        const heavyShellReadyMinMs = heavyShellLogicalReadyMinMs;
        const heavyShellReadyMaxMs = heavyShellLogicalReadyMaxMs;

        console.warn(
          JSON.stringify(
            {
              diagnosticsAfter: summarizeBackendDiagnostics(diagnosticsAfter),
              experiment: {
                attachTraceSummary: summarizeAttachTraces(experimentResult.attachTraceEntries),
                fetchDurationsByChannelMs: summarizeDurationsByChannel(
                  experimentResult.fetchDurationsByChannelMs,
                ),
                heavyShellLogicalReadyMaxMs,
                heavyShellLogicalReadyMinMs,
                heavyShellLogicalReadyTimesMs: experimentResult.heavyShellLogicalReadyTimesMs,
                heavyShellPaintReadyMaxMs,
                heavyShellPaintReadyMinMs,
                heavyShellPaintReadyTimesMs: experimentResult.heavyShellPaintReadyTimesMs,
                heavyShellVisiblePaintReadyMaxMs: heavyShellPaintReadyMaxMs,
                heavyShellVisiblePaintReadyMinMs: heavyShellPaintReadyMinMs,
                heavyShellVisiblePaintReadyTimesMs:
                  experimentResult.heavyShellVisiblePaintReadyTimesMs,
                heavyShellReadyMaxMs,
                heavyShellReadyMinMs,
                heavyShellReadyTimesMs: experimentResult.heavyShellReadyTimesMs,
                heavyShellSpreadMs: heavyShellReadyMaxMs - heavyShellReadyMinMs,
                longAnimationFrameBlockingMaxMs: experimentResult.longAnimationFrameBlockingMaxMs,
                longAnimationFrameBlockingTotalMs:
                  experimentResult.longAnimationFrameBlockingTotalMs,
                longAnimationFrameCount: experimentResult.longAnimationFrameCount,
                longAnimationFrameMaxMs: experimentResult.longAnimationFrameMaxMs,
                longAnimationFrameTotalMs: experimentResult.longAnimationFrameTotalMs,
                longTaskCount: experimentResult.longTaskCount,
                longTaskMaxMs: experimentResult.longTaskMaxMs,
                longTaskTotalMs: experimentResult.longTaskTotalMs,
                caseKey: experimentCase.key,
                variantDescription: experimentVariant.description,
                variantKey: experimentVariant.key,
                remainingVisiblePaintAfterSelectedMs: roundMilliseconds(
                  experimentResult.totalVisiblePaintReadyMs -
                    experimentResult.selectedTerminalPaintReadyMs,
                ),
                replayTraceSummary: summarizeReplayTraces(experimentResult.replayTraceEntries),
                recoveryRequestCounts: experimentResult.recoveryRequestCounts,
                shellCount: experimentCase.shellCount,
                viewportHeight: experimentCase.viewportHeight,
                viewportWidth: experimentCase.viewportWidth,
                workload: experimentCase.workload,
                workloadSize: summarizeWorkloadSize(experimentCase),
                shellVisibleMs: experimentResult.shellVisibleMs,
                firstVisibleSiblingPaintReadyMs: experimentResult.firstVisibleSiblingPaintReadyMs,
                lastVisibleSiblingPaintReadyMs: experimentResult.lastVisibleSiblingPaintReadyMs,
                selectedTerminalIndexAtShellVisible:
                  experimentResult.selectedTerminalIndexAtShellVisible,
                selectedTerminalLogicalReadyMs: experimentResult.selectedTerminalLogicalReadyMs,
                selectedPaintAfterLogicalMs: experimentResult.selectedPaintAfterLogicalMs,
                selectedTerminalPaintReadyMs: experimentResult.selectedTerminalPaintReadyMs,
                startupPaintAttribution: summarizeStartupPaintAttribution(rendererDiagnostics),
                selectedVsFirstVisibleSiblingPaintGapMs:
                  experimentResult.selectedVsFirstVisibleSiblingPaintGapMs,
                selectedVsLastVisibleSiblingPaintGapMs:
                  experimentResult.selectedVsLastVisibleSiblingPaintGapMs,
                statusHistories: experimentResult.statusHistories,
                totalLogicalReadyMs: experimentResult.totalLogicalReadyMs,
                totalPaintReadyMs: experimentResult.totalPaintReadyMs,
                totalReadyMs: experimentResult.totalReadyMs,
                totalVisiblePaintReadyMs: experimentResult.totalVisiblePaintReadyMs,
                hiddenTerminalCountAtShellVisible:
                  experimentResult.hiddenTerminalCountAtShellVisible,
                visiblePaintReadyTimeoutIndices: experimentResult.visiblePaintReadyTimeoutIndices,
                visibleSiblingCountAtShellVisible:
                  experimentResult.visibleSiblingCountAtShellVisible,
                visibleSiblingPaintReadyTimeoutCount:
                  experimentResult.visibleSiblingPaintReadyTimeoutCount,
                visibleSiblingPaintReadyTimesMs: experimentResult.visibleSiblingPaintReadyTimesMs,
                visiblePaintReadyTimesMs: experimentResult.visiblePaintReadyTimesMs,
                visibilityAtShellVisible: experimentResult.visibilityAtShellVisible,
                visibleTerminalCountAtShellVisible:
                  experimentResult.visibleTerminalCountAtShellVisible,
              },
              rendererDiagnostics: rendererDiagnostics
                ? {
                    terminalFit: rendererDiagnostics.terminalFit,
                    terminalRecovery: rendererDiagnostics.terminalRecovery,
                    terminalRenderer: rendererDiagnostics.terminalRenderer,
                    terminalResize: rendererDiagnostics.terminalResize,
                    terminalStartupPaint: rendererDiagnostics.terminalStartupPaint,
                  }
                : null,
            },
            null,
            2,
          ),
        );
      });
    }
  }
});
