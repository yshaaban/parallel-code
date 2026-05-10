#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { createBrowserServerClient } from './browser-server-client.mjs';
import { getDefaultTerminalUiFluidityGateProfiles } from './terminal-ui-fluidity-gate.mjs';
import { getTerminalUiFluidityVariant } from './terminal-ui-fluidity-variants.mjs';

const GET_AGENT_SCROLLBACK = 'get_agent_scrollback';
const GET_BACKEND_RUNTIME_DIAGNOSTICS = 'get_backend_runtime_diagnostics';
const RESET_BACKEND_RUNTIME_DIAGNOSTICS = 'reset_backend_runtime_diagnostics';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const DEFAULT_AUTH_TOKEN = 'parallel-code-local-browser';
const APP_SHELL_SELECTOR = '.app-shell';
const CLIENT_ID_STORAGE_KEY = 'parallel-code-client-id';
const DISPLAY_NAME_STORAGE_KEY = 'parallel-code-display-name';
const PROFILE_TERMINAL_OPEN_SHORTCUT = 'Control+Shift+D';
const SERVER_START_TIMEOUT_MS = 20_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const STANDALONE_SERVER_READY_BUFFER_MAX_CHARS = 8_192;
const TERMINAL_ATTACH_TIMEOUT_MS = 15_000;
const TERMINAL_CREATE_DEBOUNCE_BUFFER_MS = 350;
const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';
const TERMINAL_LOADING_OVERLAY_SELECTOR = '[data-terminal-loading-overlay="true"]';
const TERMINAL_READY_TIMEOUT_MS = 15_000;
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';
const TRACE_POLL_INTERVAL_MS = 100;
const TERMINAL_ROUND_TRIP_TIMEOUT_MS = 5_000;
const TERMINAL_ROUND_TRIP_READY_RETRY_DELAY_MS = 250;
const TERMINAL_ROUND_TRIP_READY_TIMEOUT_MS = 20_000;
const UI_DIAGNOSTICS_READY_TIMEOUT_MS = 8_000;
const WORKLOAD_WARMUP_MS = 1_000;
const SEEDED_AGENT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DURATION_MS = 6_000;
const DEFAULT_TERMINALS = 24;
const DEFAULT_INPUT_INTERVAL_MS = 800;
const BROWSER_CONTROL_CLIENT_DETAIL_TYPES = ['input', 'resize', 'pause', 'resume'];
const DEFAULT_SURFACE = 'agents';
const DEFAULT_VARIANT = 'baseline';
const DEFAULT_VISIBLE_TERMINAL_COUNT = null;
const DEFAULT_VIEWPORT_HEIGHT = 1_080;
const SUITE_BOOTSTRAP_RETRY_LIMIT = 2;
const PAGE_GOTO_TIMEOUT_MS = 60_000;
const VIEWPORT_BASE_WIDTH = 1_280;
const VIEWPORT_WIDTH_PER_VISIBLE_TERMINAL = 360;
const VISIBLE_TERMINAL_VIEWPORT_ADJUSTMENT_STEP_PX = 120;
const VISIBLE_TERMINAL_VIEWPORT_MIN_WIDTH = 760;
const VISIBLE_TERMINAL_VIEWPORT_MAX_WIDTH = 3_200;
const VISIBLE_TERMINAL_VIEWPORT_ALIGNMENT_ATTEMPTS = 14;
const VISIBLE_TERMINAL_VIEWPORT_SETTLE_MS = 100;
const DEFAULT_PROFILES = getDefaultTerminalUiFluidityGateProfiles();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STANDALONE_SERVER_ENTRY = path.resolve(PROJECT_ROOT, 'dist-server', 'server', 'main.js');
const DEFAULT_OUT_DIR = path.resolve(PROJECT_ROOT, 'artifacts', 'terminal-ui-fluidity');
const SESSION_STRESS_AGENT_ENTRY = path.resolve(
  PROJECT_ROOT,
  'scripts',
  'fixtures',
  'session-stress-agent.mjs',
);

const SUITE_DEFINITIONS = {
  active_visible_selected: {
    inputProbes: 0,
    workload: 'mixed_agents',
  },
  bulk_text: {
    inputProbes: 2,
    workload: 'bulk_text',
  },
  markdown_burst: {
    inputProbes: 2,
    workload: 'markdown_burst',
  },
  code_burst: {
    inputProbes: 2,
    workload: 'code_burst',
  },
  diff_burst: {
    inputProbes: 2,
    workload: 'diff_burst',
  },
  agent_cli_burst: {
    inputProbes: 2,
    workload: 'agent_cli_burst',
  },
  statusline: {
    inputProbes: 2,
    workload: 'statusline',
  },
  mixed_agents: {
    inputProbes: 3,
    workload: 'mixed_agents',
  },
  hidden_switch: {
    inputProbes: 1,
    workload: 'hidden_switch',
  },
  recent_hidden_switch: {
    inputProbes: 1,
    workload: 'hidden_switch',
  },
  hidden_render_wake: {
    inputProbes: 1,
    workload: 'hidden_switch',
  },
  hidden_session_wake: {
    inputProbes: 1,
    workload: 'hidden_switch',
  },
  interactive_verbose: {
    inputProbes: Math.max(4, Math.ceil(DEFAULT_DURATION_MS / DEFAULT_INPUT_INTERVAL_MS)),
    workload: 'interactive_verbose',
  },
};

function createTimestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const defaultVariant = getTerminalUiFluidityVariant(DEFAULT_VARIANT);
  const options = {
    authToken: process.env.AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN,
    durationMs: DEFAULT_DURATION_MS,
    experimentConfig: defaultVariant.experiments,
    injectedExperimentConfig: defaultVariant.injectExperiments ? defaultVariant.experiments : null,
    injectedHighLoadMode: defaultVariant.injectHighLoadMode
      ? defaultVariant.highLoadModeEnabled
      : null,
    inputIntervalMs: DEFAULT_INPUT_INTERVAL_MS,
    keepServer: false,
    launchServer: false,
    outDir: path.resolve(DEFAULT_OUT_DIR, createTimestampForPath()),
    profiles: [...DEFAULT_PROFILES],
    visibleTerminalCount: DEFAULT_VISIBLE_TERMINAL_COUNT,
    serverUrl: process.env.SERVER_URL ?? DEFAULT_SERVER_URL,
    surface: DEFAULT_SURFACE,
    terminals: DEFAULT_TERMINALS,
    trace: false,
    traceProfiles: [],
    variant: DEFAULT_VARIANT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--server-url':
        options.serverUrl = next ?? options.serverUrl;
        index += 1;
        break;
      case '--auth-token':
        options.authToken = next ?? options.authToken;
        index += 1;
        break;
      case '--profiles':
        options.profiles = (next ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        index += 1;
        break;
      case '--terminals':
        options.terminals = parsePositiveInteger(next, options.terminals);
        index += 1;
        break;
      case '--visible-terminal-count':
        options.visibleTerminalCount = parseNullablePositiveInteger(
          next,
          options.visibleTerminalCount,
        );
        index += 1;
        break;
      case '--surface':
        if (next !== 'agents' && next !== 'shell') {
          throw new Error(`Unknown surface: ${next}`);
        }
        options.surface = next;
        index += 1;
        break;
      case '--duration-ms':
        options.durationMs = parsePositiveInteger(next, options.durationMs);
        index += 1;
        break;
      case '--input-interval-ms':
        options.inputIntervalMs = parsePositiveInteger(next, options.inputIntervalMs);
        index += 1;
        break;
      case '--out-dir':
        options.outDir = path.resolve(next ?? options.outDir);
        index += 1;
        break;
      case '--variant': {
        const variantName = next ?? DEFAULT_VARIANT;
        const variant = getTerminalUiFluidityVariant(variantName);
        options.experimentConfig = variant.experiments;
        options.injectedExperimentConfig = variant.injectExperiments ? variant.experiments : null;
        options.injectedHighLoadMode = variant.injectHighLoadMode
          ? variant.highLoadModeEnabled
          : null;
        options.variant = variantName;
        index += 1;
        break;
      }
      case '--trace':
        options.trace = true;
        break;
      case '--trace-profiles':
        options.traceProfiles = (next ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        index += 1;
        break;
      case '--launch-server':
        options.launchServer = true;
        break;
      case '--keep-server':
        options.keepServer = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/profile-terminal-ui-fluidity.mjs [options]

Options:
  --launch-server             Launch a fresh standalone browser server for the run
  --keep-server               Keep the launched server alive after profiling
  --server-url <url>          Reuse an existing standalone server (default: ${DEFAULT_SERVER_URL})
  --auth-token <token>        Auth token for an existing server
  --profiles <a,b,c>          Profiles to run (default: ${DEFAULT_PROFILES.join(',')})
  --surface <agents|shell>   Surface to profile (default: ${DEFAULT_SURFACE})
  --terminals <n>             Number of active terminals/tasks per suite (default: ${DEFAULT_TERMINALS})
  --visible-terminal-count <n>
                              Approximate number of terminals visible in the viewport
                              (default: browser viewport, no override)
  --duration-ms <n>           Measurement window per suite (default: ${DEFAULT_DURATION_MS})
  --input-interval-ms <n>     Focused input probe interval for interactive suites (default: ${DEFAULT_INPUT_INTERVAL_MS})
  --variant <name>            Experiment variant preset (default: ${DEFAULT_VARIANT})
  --trace                     Capture a Chromium performance trace for each profiled suite
  --trace-profiles <a,b,c>    Only capture traces for these profiles (default: all when --trace is set)
  --out-dir <path>            Artifact directory (default: artifacts/terminal-ui-fluidity/<timestamp>)
  --help                      Print this help and exit
`);
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${value.toFixed(2)}ms`;
}

function formatCount(value) {
  return Number.isFinite(value) ? String(value) : 'n/a';
}

function createEmptyBrowserControlClientTypeStats() {
  return {
    nonZeroBufferedSendAttempts: 0,
    postSendBufferedAmountMax: 0,
    sendAttempts: 0,
    sendBufferedAmountMax: 0,
    sendDurationMs: createEmptyLatencyStats(),
  };
}

function getBrowserControlClientTypeStats(browserControlClient, type) {
  return browserControlClient.byType?.[type] ?? createEmptyBrowserControlClientTypeStats();
}

function formatBrowserControlClientTypeStats(browserControlClient, type) {
  const stats = getBrowserControlClientTypeStats(browserControlClient, type);
  return (
    `${type}-sends=${formatCount(stats.sendAttempts)}` +
    ` ${type}-nonzero-buffered=${formatCount(stats.nonZeroBufferedSendAttempts)}` +
    ` ${type}-buffered-max=${formatCount(stats.sendBufferedAmountMax)}` +
    ` ${type}-post-buffered-max=${formatCount(stats.postSendBufferedAmountMax)}` +
    ` ${type}-send-duration-p95=${formatMs(stats.sendDurationMs.p95)}`
  );
}

function createEmptyDurationSummary() {
  return {
    avgMs: 0,
    count: 0,
    maxMs: 0,
    p50Ms: 0,
    p95Ms: 0,
  };
}

function createEmptyLatencyStats() {
  return {
    avg: 0,
    count: 0,
    max: 0,
    min: 0,
    p50: 0,
    p95: 0,
  };
}

function getRequiredDurationSample(sortedValues, index) {
  const value = sortedValues[index];
  if (value === undefined) {
    throw new Error('Duration sample index out of bounds');
  }

  return value;
}

function getDurationPercentile(sortedValues, fraction) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return getRequiredDurationSample(sortedValues, index);
}

function summarizeDurations(values) {
  const sortedValues = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sortedValues.length === 0) {
    return createEmptyDurationSummary();
  }

  const sum = sortedValues.reduce((total, value) => total + value, 0);
  return {
    avgMs: Math.round((sum / sortedValues.length) * 100) / 100,
    count: sortedValues.length,
    maxMs: getRequiredDurationSample(sortedValues, sortedValues.length - 1),
    p50Ms: getDurationPercentile(sortedValues, 0.5),
    p95Ms: getDurationPercentile(sortedValues, 0.95),
  };
}

function parseNullablePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return parsePositiveInteger(value, fallback);
}

function shouldCaptureTraceForSuite(options, suiteName) {
  if (!options.trace) {
    return false;
  }

  return options.traceProfiles.length === 0 || options.traceProfiles.includes(suiteName);
}

function isActiveVisibleSelectedSuiteName(suiteName) {
  return suiteName === 'active_visible_selected';
}

function summarizeTraceEvents(traceEvents) {
  const threadNames = new Map();
  for (const event of traceEvents) {
    if (
      event.ph === 'M' &&
      event.name === 'thread_name' &&
      typeof event.pid === 'number' &&
      typeof event.tid === 'number'
    ) {
      const threadName = event.args?.name;
      if (typeof threadName === 'string') {
        threadNames.set(`${event.pid}:${event.tid}`, threadName);
      }
    }
  }

  const rendererMainThreadKey = [...threadNames.entries()].find(
    ([, threadName]) => threadName === 'CrRendererMain',
  )?.[0];
  const groupedSlices = new Map();
  let mainThreadLongTaskCount = 0;
  let mainThreadLongTaskTotalMs = 0;
  let mainThreadLongTaskMaxMs = 0;
  let mainThreadSliceCount = 0;

  for (const event of traceEvents) {
    if (
      event.ph !== 'X' ||
      typeof event.pid !== 'number' ||
      typeof event.tid !== 'number' ||
      typeof event.dur !== 'number'
    ) {
      continue;
    }

    if (rendererMainThreadKey && `${event.pid}:${event.tid}` !== rendererMainThreadKey) {
      continue;
    }

    const durationMs = event.dur / 1000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      continue;
    }

    mainThreadSliceCount += 1;
    if (durationMs >= 50) {
      mainThreadLongTaskCount += 1;
      mainThreadLongTaskTotalMs += durationMs;
      mainThreadLongTaskMaxMs = Math.max(mainThreadLongTaskMaxMs, durationMs);
    }

    const sliceKey = `${event.cat ?? 'uncategorized'}:${event.name}`;
    const existing = groupedSlices.get(sliceKey) ?? {
      count: 0,
      maxMs: 0,
      name: sliceKey,
      totalMs: 0,
    };
    existing.count += 1;
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    existing.totalMs += durationMs;
    groupedSlices.set(sliceKey, existing);
  }

  return {
    eventCount: traceEvents.length,
    mainThreadLongTasks: {
      count: mainThreadLongTaskCount,
      maxMs: mainThreadLongTaskMaxMs,
      totalMs: mainThreadLongTaskTotalMs,
    },
    mainThreadName: rendererMainThreadKey ? (threadNames.get(rendererMainThreadKey) ?? null) : null,
    mainThreadSliceCount,
    topMainThreadSlices: [...groupedSlices.values()]
      .sort((left, right) => right.totalMs - left.totalMs)
      .slice(0, 12),
  };
}

function getViewportSizeForVisibleTerminalCount(visibleTerminalCount) {
  if (visibleTerminalCount === null) {
    return null;
  }

  return {
    height: DEFAULT_VIEWPORT_HEIGHT,
    width:
      VIEWPORT_BASE_WIDTH +
      Math.max(0, visibleTerminalCount - 1) * VIEWPORT_WIDTH_PER_VISIBLE_TERMINAL,
  };
}

async function readVisibleTerminalCount(page) {
  const snapshot = await collectUiFluiditySnapshot(page);
  const visibleTerminalCount = snapshot?.pacing?.visibleTerminalCount;
  return Number.isFinite(visibleTerminalCount) ? visibleTerminalCount : null;
}

function getAdjustedViewportWidth(currentWidth, visibleTerminalCount, targetVisibleTerminalCount) {
  const direction = visibleTerminalCount > targetVisibleTerminalCount ? -1 : 1;
  const nextWidth = currentWidth + direction * VISIBLE_TERMINAL_VIEWPORT_ADJUSTMENT_STEP_PX;
  return Math.max(
    VISIBLE_TERMINAL_VIEWPORT_MIN_WIDTH,
    Math.min(VISIBLE_TERMINAL_VIEWPORT_MAX_WIDTH, nextWidth),
  );
}

async function alignViewportToVisibleTerminalCount(page, targetVisibleTerminalCount) {
  if (targetVisibleTerminalCount === null) {
    return;
  }

  for (let attempt = 0; attempt < VISIBLE_TERMINAL_VIEWPORT_ALIGNMENT_ATTEMPTS; attempt += 1) {
    const visibleTerminalCount = await readVisibleTerminalCount(page);
    if (visibleTerminalCount === targetVisibleTerminalCount) {
      return;
    }

    if (visibleTerminalCount === null) {
      await page.waitForTimeout(VISIBLE_TERMINAL_VIEWPORT_SETTLE_MS);
      continue;
    }

    const viewport = page.viewportSize();
    if (!viewport) {
      throw new Error('Cannot align visible terminal count without a viewport');
    }

    const nextWidth = getAdjustedViewportWidth(
      viewport.width,
      visibleTerminalCount,
      targetVisibleTerminalCount,
    );
    if (nextWidth === viewport.width) {
      break;
    }

    await page.setViewportSize({
      height: viewport.height,
      width: nextWidth,
    });
    await page.waitForTimeout(VISIBLE_TERMINAL_VIEWPORT_SETTLE_MS);
  }

  const finalVisibleTerminalCount = await readVisibleTerminalCount(page);
  throw new Error(
    `Unable to align visible terminal count to ${targetVisibleTerminalCount}; ` +
      `app reported ${finalVisibleTerminalCount ?? 'unknown'}`,
  );
}

async function captureBrowserPerformanceTrace(page, tracePath, measure) {
  const traceClient = await page.context().newCDPSession(page);
  const traceEvents = [];
  const handleTraceDataCollected = (event) => {
    if (Array.isArray(event.value)) {
      traceEvents.push(...event.value);
    }
  };
  traceClient.on('Tracing.dataCollected', handleTraceDataCollected);
  const tracingComplete = new Promise((resolve) => {
    traceClient.once('Tracing.tracingComplete', resolve);
  });

  await traceClient.send('Tracing.start', {
    categories: [
      '-*',
      'blink.user_timing',
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'toplevel',
      'v8.execute',
    ].join(','),
    options: 'sampling-frequency=10000',
    transferMode: 'ReportEvents',
  });

  try {
    const measured = await measure();
    await traceClient.send('Tracing.end');
    await tracingComplete;
    const traceSummary = summarizeTraceEvents(traceEvents);
    await writeFile(
      tracePath,
      `${JSON.stringify({ traceEvents, traceSummary }, null, 2)}\n`,
      'utf8',
    );
    return {
      measured,
      traceSummary: {
        ...traceSummary,
        artifactPath: tracePath,
      },
    };
  } finally {
    traceClient.off('Tracing.dataCollected', handleTraceDataCollected);
    await traceClient.detach().catch(() => {});
  }
}

function createProject(projectId, repoDir) {
  return {
    id: projectId,
    name: 'UI Fluidity Project',
    path: repoDir,
    color: '#2f8fdd',
    baseBranch: 'main',
    branchPrefix: 'ui-fluidity',
  };
}

function createProfilerAgentDef(id, name, args) {
  return {
    id,
    name,
    command: process.execPath,
    args,
    resume_args: [],
    skip_permissions_args: [],
    description: `${name} UI fluidity fixture`,
  };
}

function createAgentWorkloadArgs(
  profileName,
  terminalIndex,
  durationMs,
  readyMarker,
  startGateFile,
) {
  const sharedWorkloadArgs = ['--ready-marker', readyMarker, '--start-gate-file', startGateFile];
  if (profileName === 'bulk_text') {
    return [
      SESSION_STRESS_AGENT_ENTRY,
      '--style',
      'lines',
      '--label',
      `${profileName}-bulk-${terminalIndex + 1}`,
      '--line-count',
      String(Math.max(20_000, Math.ceil(durationMs * 12))),
      '--line-bytes',
      '960',
      ...sharedWorkloadArgs,
    ];
  }

  const verboseBurstStyleByProfile = {
    agent_cli_burst: 'agent-cli-burst',
    code_burst: 'code-burst',
    diff_burst: 'diff-burst',
    markdown_burst: 'markdown-burst',
  };
  const verboseBurstStyle = verboseBurstStyleByProfile[profileName];
  if (typeof verboseBurstStyle === 'string') {
    return [
      SESSION_STRESS_AGENT_ENTRY,
      '--style',
      verboseBurstStyle,
      '--label',
      `${profileName}-burst-${terminalIndex + 1}`,
      '--paragraph-count',
      String(Math.max(180, Math.ceil(durationMs / 40))),
      '--paragraph-bytes',
      '720',
      '--line-width',
      '108',
      ...sharedWorkloadArgs,
    ];
  }

  if (profileName === 'statusline') {
    return [
      SESSION_STRESS_AGENT_ENTRY,
      '--style',
      'statusline',
      '--label',
      `${profileName}-status-${terminalIndex + 1}`,
      '--frame-count',
      String(Math.max(180, Math.ceil(durationMs / 20))),
      '--frame-delay-ms',
      '20',
      '--chunk-delay-ms',
      '0',
      '--footer-top-row',
      String(18 + (terminalIndex % 6)),
      ...sharedWorkloadArgs,
    ];
  }

  const mixedWorkloadSlot = terminalIndex % 3;
  if (mixedWorkloadSlot === 0) {
    return [
      SESSION_STRESS_AGENT_ENTRY,
      '--style',
      'mixed',
      '--label',
      `${profileName}-mixed-${terminalIndex + 1}`,
      '--paragraph-count',
      String(Math.max(180, Math.ceil(durationMs / 40))),
      '--paragraph-bytes',
      '720',
      '--line-width',
      '108',
      '--frame-count',
      String(Math.max(300, Math.ceil(durationMs / 16))),
      '--frame-delay-ms',
      '18',
      '--chunk-delay-ms',
      '1',
      '--footer-top-row',
      String(18 + (terminalIndex % 6)),
      ...sharedWorkloadArgs,
    ];
  }

  if (mixedWorkloadSlot === 1) {
    return [
      SESSION_STRESS_AGENT_ENTRY,
      '--style',
      'statusline',
      '--label',
      `${profileName}-status-${terminalIndex + 1}`,
      '--frame-count',
      String(Math.max(180, Math.ceil(durationMs / 20))),
      '--frame-delay-ms',
      '20',
      '--chunk-delay-ms',
      '0',
      '--footer-top-row',
      String(18 + (terminalIndex % 6)),
      ...sharedWorkloadArgs,
    ];
  }

  return [
    SESSION_STRESS_AGENT_ENTRY,
    '--style',
    'lines',
    '--label',
    `${profileName}-bulk-${terminalIndex + 1}`,
    '--line-count',
    String(Math.max(20_000, Math.ceil(durationMs * 12))),
    '--line-bytes',
    '960',
    ...sharedWorkloadArgs,
  ];
}

function createSeededTaskEntry(
  project,
  branchName,
  profileName,
  terminalIndex,
  durationMs,
  startGateFile,
) {
  const taskId = `ui-fluidity-task-${terminalIndex + 1}`;
  const agentId = `ui-fluidity-agent-${terminalIndex + 1}`;
  const readyMarker = `${profileName}-ready-${terminalIndex + 1}`;
  const agentDefId = `ui-fluidity-agent-def-${terminalIndex + 1}`;
  const agentDef = createProfilerAgentDef(
    agentDefId,
    `UI Fluidity Agent ${terminalIndex + 1}`,
    createAgentWorkloadArgs(profileName, terminalIndex, durationMs, readyMarker, startGateFile),
  );

  return {
    agentDef,
    agentId,
    readyMarker,
    startGateFile,
    task: {
      id: taskId,
      name: `UI Fluidity Task ${terminalIndex + 1}`,
      projectId: project.id,
      branchName,
      worktreePath: project.path,
      notes: '',
      lastPrompt: '',
      shellCount: 0,
      agentId,
      shellAgentIds: [],
      agentDef,
    },
    taskId,
  };
}

function createSeededState(project, profileName, terminalCount, durationMs, startGateDir) {
  const branchName = getCurrentBranchName(project.path);
  const taskEntries = Array.from({ length: terminalCount }, (_, index) =>
    createSeededTaskEntry(
      project,
      branchName,
      profileName,
      index,
      durationMs,
      path.resolve(startGateDir, `agent-${index + 1}.ready`),
    ),
  );
  const tasks = Object.fromEntries(taskEntries.map((entry) => [entry.taskId, entry.task]));
  const taskOrder = taskEntries.map((entry) => entry.taskId);
  const customAgents = taskEntries.map((entry) => entry.agentDef);

  const shared = {
    completedTaskCount: 0,
    completedTaskDate: '2026-03-23',
    customAgents,
    hydraCommand: '',
    hydraForceDispatchFromPromptPanel: true,
    hydraStartupMode: 'auto',
    mergedLinesAdded: 0,
    mergedLinesRemoved: 0,
    projects: [project],
    taskOrder,
    tasks,
    terminals: {},
  };

  return {
    seededTasks: taskEntries.map((entry) => ({
      agentId: entry.agentId,
      readyMarker: entry.readyMarker,
      startGateFile: entry.startGateFile,
      taskId: entry.taskId,
    })),
    state: {
      ...shared,
      activeTaskId: taskOrder[0] ?? null,
      collapsedTaskOrder: [],
      lastAgentId: customAgents[0]?.id ?? null,
      lastProjectId: project.id,
      sidebarVisible: true,
    },
    workspaceState: {
      ...shared,
      collapsedTaskOrder: [],
    },
  };
}

function getCurrentBranchName(repoDir) {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
}

async function createSeedRepo(parentDir) {
  const repoDir = path.join(parentDir, 'repo');
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'README.md'), '# UI Fluidity Fixture\n', 'utf8');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'UI Fluidity'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'ui-fluidity@example.com'], { cwd: repoDir });
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'ui fluidity seed'], { cwd: repoDir });
  return repoDir;
}

async function writeSeededStateFiles(stateDir, state, workspaceState) {
  await mkdir(stateDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(stateDir, 'state.json'), JSON.stringify(state), 'utf8'),
    writeFile(
      path.join(stateDir, 'workspace-state.json'),
      JSON.stringify({
        revision: 1,
        state: workspaceState,
      }),
      'utf8',
    ),
  ]);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to reserve a localhost port for browser fluidity profiling'));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function appendServerOutput(previous, chunk) {
  const next = `${previous}${chunk}`;
  if (next.length <= STANDALONE_SERVER_READY_BUFFER_MAX_CHARS) {
    return next;
  }

  return next.slice(-STANDALONE_SERVER_READY_BUFFER_MAX_CHARS);
}

function waitForServerReady(serverProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the standalone server to start'));
    }, SERVER_START_TIMEOUT_MS);

    let stdoutText = '';
    let stderrText = '';

    function cleanup() {
      globalThis.clearTimeout(timeout);
      serverProcess.stdout.off('data', handleStdout);
      serverProcess.stderr.off('data', handleStderr);
      serverProcess.off('exit', handleExit);
    }

    function handleStdout(chunk) {
      stdoutText = appendServerOutput(stdoutText, chunk.toString('utf8'));
      const match = stdoutText.match(/Parallel Code server listening on (https?:\/\/\S+)/u);
      if (!match) {
        return;
      }

      cleanup();
      resolve(match[1]);
    }

    function handleStderr(chunk) {
      stderrText += chunk.toString('utf8');
    }

    function handleExit(code) {
      cleanup();
      reject(
        new Error(
          stderrText.trim().length > 0
            ? `Standalone server exited early with code ${code ?? 'null'}: ${stderrText.trim()}`
            : `Standalone server exited early with code ${code ?? 'null'}`,
        ),
      );
    }

    serverProcess.stdout.on('data', handleStdout);
    serverProcess.stderr.on('data', handleStderr);
    serverProcess.on('exit', handleExit);
  });
}

function stopServerProcess(serverProcess) {
  return new Promise((resolve) => {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      serverProcess.kill('SIGKILL');
    }, SERVER_STOP_TIMEOUT_MS);

    serverProcess.once('exit', () => {
      globalThis.clearTimeout(timeout);
      resolve();
    });

    serverProcess.kill('SIGTERM');
  });
}

async function maybeLaunchServer(options, suiteName) {
  if (!options.launchServer) {
    if (options.surface === 'agents') {
      throw new Error('The agents surface requires --launch-server so the profiler can seed tasks');
    }
    return null;
  }

  const port = await reservePort();
  const authToken = `ui-fluidity-profiler-${randomBytes(12).toString('hex')}`;
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-ui-fluidity-'));
  let rootDir = null;
  let seededTasks = [];
  let startGateDir = null;
  if (options.surface === 'agents') {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-ui-fluidity-seeded-'));
    const repoDir = await createSeedRepo(rootDir);
    const project = createProject('project-ui-fluidity', repoDir);
    const workloadDurationMs = Math.max(options.durationMs * 3, options.durationMs + 8_000);
    startGateDir = path.resolve(rootDir, 'start-gates');
    await mkdir(startGateDir, { recursive: true });
    const seededState = createSeededState(
      project,
      suiteName,
      options.terminals,
      workloadDurationMs,
      startGateDir,
    );
    seededTasks = seededState.seededTasks;
    await writeSeededStateFiles(
      `${userDataPath}-dev`,
      seededState.state,
      seededState.workspaceState,
    );
  }
  const serverProcess = spawn(process.execPath, [STANDALONE_SERVER_ENTRY], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      AUTH_TOKEN: authToken,
      PARALLEL_CODE_USER_DATA_DIR: userDataPath,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const baseUrl = await waitForServerReady(serverProcess);
    return {
      authToken,
      baseUrl,
      async releaseWorkloads() {
        if (seededTasks.length === 0) {
          return;
        }

        await Promise.all(
          seededTasks.map((seededTask) => writeFile(seededTask.startGateFile, 'start\n', 'utf8')),
        );
      },
      seededTasks,
      async stop() {
        if (options.keepServer) {
          console.log(`Keeping standalone server alive at ${baseUrl}`);
          return;
        }

        await stopServerProcess(serverProcess);
        await rm(userDataPath, { force: true, recursive: true });
        if (rootDir) {
          await rm(rootDir, { force: true, recursive: true });
        }
      },
    };
  } catch (error) {
    await stopServerProcess(serverProcess).catch(() => {});
    await rm(userDataPath, { force: true, recursive: true }).catch(() => {});
    if (rootDir) {
      await rm(rootDir, { force: true, recursive: true }).catch(() => {});
    }
    throw error;
  }
}

function getTerminalInput(page, terminalIndex) {
  return page.locator(TERMINAL_INPUT_SELECTOR).nth(terminalIndex);
}

function getTaskPanel(page, taskId) {
  return page.locator(`[data-task-id="${taskId}"]`).first();
}

function getSidebarTaskRow(page, taskId) {
  return page.locator(`[data-sidebar-task-id="${taskId}"]`).first();
}

function getTaskTerminalStatusContainer(page, taskId) {
  return getTaskPanel(page, taskId).locator(TERMINAL_STATUS_SELECTOR).first();
}

function getTaskTerminalInput(page, taskId) {
  return getTaskPanel(page, taskId).locator(TERMINAL_INPUT_SELECTOR).first();
}

function getTaskPromptTextarea(page, taskId) {
  return getTaskPanel(page, taskId).locator('.prompt-textarea').first();
}

async function pollUntil(action, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await action();
    if (predicate(result)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, TRACE_POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '');
}

function isRetryableBrowserServerError(error) {
  const message = getErrorMessage(error);
  const causeMessage =
    error instanceof Error && error.cause !== undefined ? getErrorMessage(error.cause) : '';
  return (
    message.includes('fetch failed') ||
    causeMessage.includes('fetch failed') ||
    message.includes('ECONNRESET') ||
    causeMessage.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    causeMessage.includes('ECONNREFUSED')
  );
}

function isRetryableSuiteBootstrapError(error) {
  const message = getErrorMessage(error);
  return (
    isRetryableBrowserServerError(error) ||
    message.includes("waiting for locator('.app-shell')") ||
    message.includes('UI fluidity diagnostics store') ||
    message.includes('terminal latency store') ||
    message.includes('seeded agent terminal')
  );
}

async function readTerminalStatus(page, terminalIndex) {
  const input = getTerminalInput(page, terminalIndex);
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-status') ?? null,
    TERMINAL_STATUS_SELECTOR,
  );
}

async function readTerminalLiveRenderReady(page, terminalIndex) {
  const input = getTerminalInput(page, terminalIndex);
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-live-render-ready') === 'true',
    TERMINAL_STATUS_SELECTOR,
  );
}

async function readTerminalAgentId(page, terminalIndex) {
  const input = getTerminalInput(page, terminalIndex);
  return input.evaluate(
    (element, statusSelector) =>
      element.closest(statusSelector)?.getAttribute('data-terminal-agent-id') ?? null,
    TERMINAL_STATUS_SELECTOR,
  );
}

async function isTaskPanelVisible(page, taskId) {
  return getTaskPanel(page, taskId).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < globalThis.window.innerHeight &&
      rect.left < globalThis.window.innerWidth
    );
  });
}

async function waitForTerminalReady(page, terminalIndex) {
  const input = getTerminalInput(page, terminalIndex);
  await input.waitFor({ state: 'attached', timeout: TERMINAL_ATTACH_TIMEOUT_MS });
  await pollUntil(
    () => readTerminalStatus(page, terminalIndex),
    (status) => status === 'ready',
    TERMINAL_READY_TIMEOUT_MS,
    `terminal ${terminalIndex} ready status`,
  );
  await pollUntil(
    () => readTerminalLiveRenderReady(page, terminalIndex),
    (isLiveRenderReady) => isLiveRenderReady === true,
    TERMINAL_READY_TIMEOUT_MS,
    `terminal ${terminalIndex} live render ready`,
  );
}

async function readTaskTerminalLiveRenderReady(page, taskId) {
  return (
    (await getTaskTerminalStatusContainer(page, taskId).getAttribute(
      'data-terminal-live-render-ready',
    )) === 'true'
  );
}

async function waitForTaskTerminalReady(page, taskId) {
  await getTaskPanel(page, taskId).waitFor({
    state: 'attached',
    timeout: TERMINAL_ATTACH_TIMEOUT_MS,
  });
  await pollUntil(
    () => isTaskPanelVisible(page, taskId),
    (isVisible) => isVisible === true,
    TERMINAL_READY_TIMEOUT_MS,
    `task ${taskId} panel visible`,
  );
  await pollUntil(
    () => getTaskTerminalStatusContainer(page, taskId).getAttribute('data-terminal-status'),
    (status) => status === 'ready',
    TERMINAL_READY_TIMEOUT_MS,
    `task ${taskId} ready status`,
  );
  await getTaskTerminalInput(page, taskId).waitFor({
    state: 'attached',
    timeout: TERMINAL_ATTACH_TIMEOUT_MS,
  });
  await pollUntil(
    () => readTaskTerminalLiveRenderReady(page, taskId),
    (isLiveRenderReady) => isLiveRenderReady === true,
    TERMINAL_READY_TIMEOUT_MS,
    `task ${taskId} live render ready`,
  );
}

async function waitForTaskPanelVisible(page, taskId) {
  await getTaskPanel(page, taskId).waitFor({
    state: 'attached',
    timeout: TERMINAL_ATTACH_TIMEOUT_MS,
  });
  await pollUntil(
    () => isTaskPanelVisible(page, taskId),
    (isVisible) => isVisible === true,
    TERMINAL_READY_TIMEOUT_MS,
    `task ${taskId} panel visible`,
  );
}

async function focusTerminal(page, terminalIndex) {
  await waitForTerminalReady(page, terminalIndex);
  const input = getTerminalInput(page, terminalIndex);
  await input.focus();
}

async function focusTaskTerminal(page, taskId) {
  await waitForTaskTerminalReady(page, taskId);
  const input = getTaskTerminalInput(page, taskId);
  await input.focus();
}

async function createShellTerminal(page) {
  const terminalInputs = page.locator(TERMINAL_INPUT_SELECTOR);
  const terminalCount = await terminalInputs.count();
  await page.locator(APP_SHELL_SELECTOR).click({
    force: true,
    position: { x: 12, y: 12 },
  });
  await page.keyboard.press(PROFILE_TERMINAL_OPEN_SHORTCUT);
  await pollUntil(
    () => terminalInputs.count(),
    (count) => count === terminalCount + 1,
    TERMINAL_ATTACH_TIMEOUT_MS,
    `terminal count ${terminalCount + 1}`,
  );
  await waitForTerminalReady(page, terminalCount);
  await page.waitForTimeout(TERMINAL_CREATE_DEBOUNCE_BUFFER_MS);
  return terminalCount;
}

async function typeLineInTerminal(page, terminalIndex, text) {
  await focusTerminal(page, terminalIndex);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function waitForUiDiagnosticsStore(page) {
  await pollUntil(
    () =>
      page.evaluate(() => ({
        hasStore: Boolean(globalThis.window.__parallelCodeUiFluidityDiagnostics),
      })),
    (result) => result.hasStore === true,
    UI_DIAGNOSTICS_READY_TIMEOUT_MS,
    'UI fluidity diagnostics store',
  );
}

async function waitForTerminalLatencyStore(page) {
  await pollUntil(
    () =>
      page.evaluate(() => ({
        hasStore: Boolean(globalThis.window.__parallelCodeTerminalLatency),
      })),
    (result) => result.hasStore === true,
    UI_DIAGNOSTICS_READY_TIMEOUT_MS,
    'terminal latency store',
  );
}

async function openUiFluidityPage(context, suiteName, serverUrl, authToken) {
  const authedUrl = new globalThis.URL('/', serverUrl);
  authedUrl.searchParams.set('token', authToken);
  const page = await context.newPage();
  console.log(`[ui-fluidity] opening ${suiteName} on ${authedUrl.toString()}`);
  await page.goto(authedUrl.toString(), {
    timeout: PAGE_GOTO_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.locator(APP_SHELL_SELECTOR).waitFor({ state: 'visible' });
  await waitForUiDiagnosticsStore(page);
  await waitForTerminalLatencyStore(page);
  return page;
}

async function resetMeasuredDiagnostics(page, client) {
  await Promise.all([
    page.evaluate(() => {
      globalThis.window.__parallelCodeUiFluidityDiagnostics?.reset();
      globalThis.window.__parallelCodeTerminalLatency?.reset();
    }),
    client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS, undefined),
  ]);
}

async function collectBackendRuntimeDiagnostics(client) {
  return client.invokeIpc(GET_BACKEND_RUNTIME_DIAGNOSTICS, undefined);
}

async function startFocusedRoundTripProbe(page) {
  const probe = await page.evaluate((timeoutMs) => {
    const marker = globalThis.window.__parallelCodeTerminalLatency?.startRoundTripProbe(timeoutMs);
    return {
      inputDispatchStartedAtMs: globalThis.performance.now(),
      marker: typeof marker === 'string' ? marker : '',
    };
  }, TERMINAL_ROUND_TRIP_TIMEOUT_MS);
  if (
    !probe ||
    typeof probe.marker !== 'string' ||
    probe.marker.length === 0 ||
    typeof probe.inputDispatchStartedAtMs !== 'number'
  ) {
    throw new Error('Failed to start a focused terminal round-trip probe');
  }

  return probe;
}

async function waitForFocusedRoundTripProbe(page, marker) {
  const roundTripMs = await page.evaluate(
    async (probeMarker) =>
      (await globalThis.window.__parallelCodeTerminalLatency?.waitForRoundTripProbe(probeMarker)) ??
      -1,
    marker,
  );
  return typeof roundTripMs === 'number' ? roundTripMs : -1;
}

async function waitForFocusedRenderedRoundTripProbe(page, marker) {
  const roundTripMs = await page.evaluate(
    async (probeMarker) =>
      (await globalThis.window.__parallelCodeTerminalLatency?.waitForRenderedRoundTripProbe(
        probeMarker,
      )) ?? -1,
    marker,
  );
  return typeof roundTripMs === 'number' ? roundTripMs : -1;
}

async function measureFocusedRoundTripDetails(page, terminalIndex) {
  await focusTerminal(page, terminalIndex);
  const probe = await startFocusedRoundTripProbe(page);

  await page.keyboard.type(probe.marker);
  await page.keyboard.press('Enter');
  const inputDispatchEndedAtMs = await page.evaluate(() => globalThis.performance.now());
  const inputDispatchMs = Math.max(0, inputDispatchEndedAtMs - probe.inputDispatchStartedAtMs);
  const roundTripMs = await waitForFocusedRoundTripProbe(page, probe.marker);
  const renderedRoundTripMs =
    roundTripMs >= 0 ? await waitForFocusedRenderedRoundTripProbe(page, probe.marker) : -1;

  return {
    echoAfterDispatchMs: roundTripMs >= 0 ? Math.max(0, roundTripMs - inputDispatchMs) : -1,
    inputDispatchMs,
    renderAfterReceiveMs:
      renderedRoundTripMs >= 0 && roundTripMs >= 0
        ? Math.max(0, renderedRoundTripMs - roundTripMs)
        : -1,
    renderedRoundTripMs,
    roundTripMs,
  };
}

async function measureFocusedRoundTrip(page, terminalIndex) {
  const result = await measureFocusedRoundTripDetails(page, terminalIndex);
  return result.roundTripMs;
}

async function measureFocusedRoundTripSafely(page, terminalIndex) {
  return await measureFocusedRoundTrip(page, terminalIndex).catch(() => -1);
}

async function measureFocusedRoundTripDetailsSafely(page, terminalIndex) {
  return await measureFocusedRoundTripDetails(page, terminalIndex).catch(() => ({
    echoAfterDispatchMs: -1,
    inputDispatchMs: 0,
    renderAfterReceiveMs: -1,
    renderedRoundTripMs: -1,
    roundTripMs: -1,
  }));
}

async function measureFocusedRoundTripForTask(page, taskId) {
  await focusTaskTerminal(page, taskId);
  const probe = await startFocusedRoundTripProbe(page);

  await page.keyboard.type(probe.marker);
  await page.keyboard.press('Enter');

  return await waitForFocusedRoundTripProbe(page, probe.marker);
}

async function measureFocusedRoundTripForTaskSafely(page, taskId) {
  return await measureFocusedRoundTripForTask(page, taskId).catch(() => -1);
}

async function waitForRoundTripReady(page, terminalIndex) {
  const deadline = Date.now() + TERMINAL_ROUND_TRIP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const roundTripMs = await measureFocusedRoundTripSafely(page, terminalIndex);
    if (roundTripMs >= 0) {
      await page.evaluate(() => {
        globalThis.window.__parallelCodeTerminalLatency?.reset();
      });
      return true;
    }

    await page.evaluate(() => {
      globalThis.window.__parallelCodeTerminalLatency?.reset();
    });
    await page.waitForTimeout(TERMINAL_ROUND_TRIP_READY_RETRY_DELAY_MS);
  }

  return false;
}

function selectHiddenSwitchTarget(terminalEntries) {
  const preferredTarget = [...terminalEntries]
    .reverse()
    .find(
      (entry) =>
        typeof entry.taskId === 'string' &&
        entry.terminalIndex >= 6 &&
        entry.terminalIndex % 3 === 0,
    );
  return preferredTarget ?? terminalEntries[terminalEntries.length - 1] ?? null;
}

function selectRecentHiddenSwitchDriver(terminalEntries, targetTaskId) {
  return (
    terminalEntries.find(
      (entry) => typeof entry.taskId === 'string' && entry.taskId !== targetTaskId,
    ) ?? null
  );
}

function rankHiddenSwitchTargets(terminalEntries) {
  return [...terminalEntries].sort((left, right) => {
    const leftPreferred = left.terminalIndex >= 6 && left.terminalIndex % 3 === 0;
    const rightPreferred = right.terminalIndex >= 6 && right.terminalIndex % 3 === 0;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred ? -1 : 1;
    }

    return right.terminalIndex - left.terminalIndex;
  });
}

async function readHiddenTargetLifecycleStates(page, terminalEntries) {
  return page.evaluate((entries) => {
    return entries.map((entry) => {
      const panel = globalThis.document.querySelector(`[data-task-id="${entry.taskId}"]`);
      if (!(panel instanceof globalThis.HTMLElement)) {
        return {
          ...entry,
          isHidden: false,
          isDormant: false,
          isRenderHibernating: false,
          isAttached: false,
        };
      }

      const rect = panel.getBoundingClientRect();
      const isVisible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < globalThis.window.innerHeight &&
        rect.left < globalThis.window.innerWidth;
      const dormantShell = panel.querySelector('[data-terminal-dormant="true"]');
      const renderHibernatingShell = panel.querySelector(
        '[data-terminal-render-hibernating="true"]',
      );

      return {
        ...entry,
        isAttached: true,
        isDormant: dormantShell instanceof globalThis.HTMLElement,
        isHidden: !isVisible,
        isRenderHibernating: renderHibernatingShell instanceof globalThis.HTMLElement,
        surfaceTier:
          panel
            .querySelector('[data-terminal-surface-tier]')
            ?.getAttribute('data-terminal-surface-tier') ?? null,
      };
    });
  }, terminalEntries);
}

async function readTaskLifecycleState(page, taskId) {
  return page.evaluate((targetTaskId) => {
    const panel = globalThis.document.querySelector(`[data-task-id="${targetTaskId}"]`);
    if (!(panel instanceof globalThis.HTMLElement)) {
      return {
        isDormant: false,
        isHidden: false,
        isRenderHibernating: false,
        isVisible: false,
        surfaceTier: null,
      };
    }

    const rect = panel.getBoundingClientRect();
    const isVisible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < globalThis.window.innerHeight &&
      rect.left < globalThis.window.innerWidth;
    return {
      isDormant: Boolean(panel.querySelector('[data-terminal-dormant="true"]')),
      isHidden: !isVisible,
      isRenderHibernating: Boolean(
        panel.querySelector('[data-terminal-render-hibernating="true"]'),
      ),
      isVisible,
      surfaceTier:
        panel
          .querySelector('[data-terminal-surface-tier]')
          ?.getAttribute('data-terminal-surface-tier') ?? null,
    };
  }, taskId);
}

async function startHiddenSwitchTimingWatch(page, taskId) {
  await page.evaluate(
    ({ inputSelector, loadingOverlaySelector, statusSelector, targetTaskId }) => {
      const watchState = {
        firstPaintMs: null,
        inputReadyMs: null,
        startAtMs: globalThis.performance.now(),
        taskId: targetTaskId,
      };

      function isPanelVisible() {
        const panel = globalThis.document.querySelector(`[data-task-id="${targetTaskId}"]`);
        if (!(panel instanceof globalThis.HTMLElement)) {
          return false;
        }

        const rect = panel.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < globalThis.window.innerHeight &&
          rect.left < globalThis.window.innerWidth
        );
      }

      function isTerminalReady() {
        if (!isPanelVisible()) {
          return false;
        }

        const panel = globalThis.document.querySelector(`[data-task-id="${targetTaskId}"]`);
        if (!(panel instanceof globalThis.HTMLElement)) {
          return false;
        }

        const statusContainer = panel.querySelector(statusSelector);
        if (!(statusContainer instanceof globalThis.HTMLElement)) {
          return false;
        }

        if (statusContainer.getAttribute('data-terminal-status') !== 'ready') {
          return false;
        }

        const input = panel.querySelector(inputSelector);
        if (!(input instanceof globalThis.HTMLElement)) {
          return false;
        }

        return (
          statusContainer.getAttribute('data-terminal-live-render-ready') === 'true' &&
          !(panel.querySelector(loadingOverlaySelector) instanceof globalThis.HTMLElement)
        );
      }

      function isTerminalFirstPaintReady() {
        if (!isPanelVisible()) {
          return false;
        }

        const panel = globalThis.document.querySelector(`[data-task-id="${targetTaskId}"]`);
        if (!(panel instanceof globalThis.HTMLElement)) {
          return false;
        }

        const statusContainer = panel.querySelector(statusSelector);
        if (!(statusContainer instanceof globalThis.HTMLElement)) {
          return false;
        }

        return statusContainer.getAttribute('data-terminal-live-render-ready') === 'true';
      }

      function sample() {
        if (globalThis.window.__parallelCodeHiddenSwitchTimingWatch !== watchState) {
          return;
        }

        const elapsedMs = globalThis.performance.now() - watchState.startAtMs;
        if (watchState.firstPaintMs === null && isTerminalFirstPaintReady()) {
          watchState.firstPaintMs = elapsedMs;
        }

        if (watchState.inputReadyMs === null && isTerminalReady()) {
          watchState.inputReadyMs = elapsedMs;
        }

        if (watchState.firstPaintMs === null || watchState.inputReadyMs === null) {
          globalThis.requestAnimationFrame(sample);
        }
      }

      globalThis.window.__parallelCodeHiddenSwitchTimingWatch = watchState;
      globalThis.requestAnimationFrame(sample);
    },
    {
      loadingOverlaySelector: TERMINAL_LOADING_OVERLAY_SELECTOR,
      inputSelector: TERMINAL_INPUT_SELECTOR,
      statusSelector: TERMINAL_STATUS_SELECTOR,
      targetTaskId: taskId,
    },
  );
}

async function startAppSwitchWindowWatch(page, taskId) {
  await page.evaluate((targetTaskId) => {
    const watchState = {
      activeObserved: false,
      summary: null,
      taskId: targetTaskId,
    };

    function sample() {
      if (globalThis.window.__parallelCodeAppSwitchWindowWatch !== watchState) {
        return;
      }

      const switchWindow =
        globalThis.window.__parallelCodeUiFluidityDiagnostics?.getSnapshot()?.switchWindow ?? null;
      if (switchWindow?.active === true && switchWindow.targetTaskId === targetTaskId) {
        watchState.activeObserved = true;
      }

      if (switchWindow?.active === false && switchWindow.lastCompletion?.taskId === targetTaskId) {
        watchState.summary = switchWindow;
        return;
      }

      globalThis.requestAnimationFrame(sample);
    }

    globalThis.window.__parallelCodeAppSwitchWindowWatch = watchState;
    globalThis.requestAnimationFrame(sample);
  }, taskId);
}

async function resolveHiddenSwitchTarget(page, terminalEntries, suiteName) {
  const rankedEntries = rankHiddenSwitchTargets(terminalEntries);
  const lifecycleStates = await readHiddenTargetLifecycleStates(page, rankedEntries);
  const eligibleStates = lifecycleStates.filter((entry) => {
    if (entry.isAttached !== true || entry.isHidden !== true || typeof entry.taskId !== 'string') {
      return false;
    }

    switch (suiteName) {
      case 'hidden_render_wake':
        return entry.isRenderHibernating === true && entry.isDormant !== true;
      case 'hidden_session_wake':
        return entry.isDormant === true;
      case 'hidden_switch':
        return entry.isDormant !== true && entry.isRenderHibernating !== true;
      default:
        return false;
    }
  });

  return eligibleStates[0] ?? null;
}

async function maybePrewarmHiddenTaskSwitch(page, experimentConfig, targetTaskId) {
  const prewarmDelayMs = experimentConfig.sidebarIntentPrewarmDelayMs ?? null;
  if (prewarmDelayMs === null) {
    return;
  }

  const sidebarTaskRow = getSidebarTaskRow(page, targetTaskId);
  await sidebarTaskRow.hover({ force: true });
  await page.waitForTimeout(prewarmDelayMs + 24);
}

function shouldTrackSwitchWindow(experimentConfig) {
  return (experimentConfig.switchTargetWindowMs ?? 0) > 0;
}

async function readAppSwitchWindowWatch(page) {
  return page.evaluate(() => globalThis.window.__parallelCodeAppSwitchWindowWatch ?? null);
}

async function readAppSwitchWindowWatchSafely(page) {
  return readAppSwitchWindowWatch(page).catch(() => null);
}

function createHiddenTaskSwitchSummary({
  failureReason,
  inputReadyMs,
  replayEntry,
  replayEntryCountAfterSwitch,
  roundTripMs,
  switchWindowSummary,
  targetTaskId,
  targetLifecycleState,
  timingWatch,
}) {
  return {
    failureReason,
    firstPaintMs: timingWatch?.firstPaintMs ?? null,
    inputReadyMs,
    replayEntry,
    replayEntryCountAfterSwitch,
    roundTripMs,
    switchWindowObservedActive: switchWindowSummary?.activeObserved === true,
    switchWindowSummary: switchWindowSummary?.summary ?? null,
    targetTaskId,
    targetLifecycleState,
  };
}

async function measureHiddenTaskSwitch(page, experimentConfig, targetTaskId, targetAgentId) {
  const tracksSwitchWindow = shouldTrackSwitchWindow(experimentConfig);
  await maybePrewarmHiddenTaskSwitch(page, experimentConfig, targetTaskId);
  const targetLifecycleState = await readTaskLifecycleState(page, targetTaskId);
  const replayTraceCountBeforeSwitch = await page.evaluate(
    () => globalThis.window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__?.length ?? 0,
  );
  await startHiddenSwitchTimingWatch(page, targetTaskId);
  if (tracksSwitchWindow) {
    await startAppSwitchWindowWatch(page, targetTaskId);
  }
  await getSidebarTaskRow(page, targetTaskId).click({ force: true });
  try {
    await waitForTaskPanelVisible(page, targetTaskId);
    await waitForTaskTerminalReady(page, targetTaskId);
    const timingWatch = await pollUntil(
      () =>
        page.evaluate(() => {
          const watch = globalThis.window.__parallelCodeHiddenSwitchTimingWatch ?? null;
          if (!watch) {
            return null;
          }

          if (typeof watch.firstPaintMs !== 'number' || typeof watch.inputReadyMs !== 'number') {
            return null;
          }

          return watch;
        }),
      (watch) => watch !== null,
      TERMINAL_READY_TIMEOUT_MS,
      `hidden switch timing watch for ${targetTaskId}`,
    );
    const switchWindowSummary = tracksSwitchWindow
      ? await pollUntil(
          () => readAppSwitchWindowWatch(page),
          (watch) => watch?.summary !== null,
          TERMINAL_READY_TIMEOUT_MS,
          `switch window completion for ${targetTaskId}`,
        )
      : null;
    const roundTripMs = await measureFocusedRoundTripForTaskSafely(page, targetTaskId);
    const replaySummary = await page.evaluate(
      ({ agentId, replayTraceCount }) => {
        const replayEntries = globalThis.window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ ?? [];
        const nextEntries = replayEntries
          .slice(replayTraceCount)
          .filter((entry) => entry.agentId === agentId);
        return {
          replayEntry: nextEntries[0] ?? null,
          laterReplayCount: Math.max(0, nextEntries.length - 1),
        };
      },
      { agentId: targetAgentId, replayTraceCount: replayTraceCountBeforeSwitch },
    );

    return createHiddenTaskSwitchSummary({
      failureReason: null,
      inputReadyMs: timingWatch?.inputReadyMs ?? null,
      replayEntry: replaySummary?.replayEntry ?? null,
      replayEntryCountAfterSwitch: replaySummary?.laterReplayCount ?? 0,
      roundTripMs,
      switchWindowSummary,
      targetTaskId,
      targetLifecycleState,
      timingWatch,
    });
  } catch (error) {
    const switchWindowSummary = tracksSwitchWindow
      ? await readAppSwitchWindowWatchSafely(page)
      : null;

    return createHiddenTaskSwitchSummary({
      failureReason: getErrorMessage(error),
      inputReadyMs: null,
      replayEntry: null,
      replayEntryCountAfterSwitch: 0,
      roundTripMs: -1,
      switchWindowSummary,
      targetTaskId,
      targetLifecycleState,
      timingWatch: null,
    });
  }
}

function createSwitchWakeSummary(switchSummary, switchEchoGraceSummary) {
  if (switchSummary === null) {
    return null;
  }

  const switchWindowSummary = switchSummary.switchWindowSummary;
  const appSwitchObserved = switchSummary.switchWindowObservedActive === true;
  const targetEchoGraceSummary =
    switchEchoGraceSummary?.lastCompletion?.taskId === switchSummary.targetTaskId ||
    switchEchoGraceSummary?.targetTaskId === switchSummary.targetTaskId
      ? switchEchoGraceSummary
      : null;
  const appSwitchEchoObserved = targetEchoGraceSummary !== null;
  const firstPaintSample = switchWindowSummary?.firstPaintSample ?? null;
  const inputReadySample = switchWindowSummary?.inputReadySample ?? null;
  const completionSample = targetEchoGraceSummary?.completionSample ?? null;
  const postInputReadyEchoDelayMs =
    typeof switchSummary.inputReadyMs === 'number' &&
    Number.isFinite(switchSummary.inputReadyMs) &&
    typeof switchSummary.roundTripMs === 'number' &&
    Number.isFinite(switchSummary.roundTripMs) &&
    switchSummary.roundTripMs >= 0
      ? Math.max(0, switchSummary.roundTripMs - switchSummary.inputReadyMs)
      : null;

  return {
    activeVisibleBytes: switchWindowSummary?.activeVisibleBytes ?? 0,
    activeVisibleQueueAgeMs: switchWindowSummary?.activeVisibleQueueAgeMs ?? 0,
    appPostInputReadyEchoFocusedBytes: targetEchoGraceSummary?.focusedBytes ?? 0,
    appPostInputReadyEchoFocusedQueueAgeMs: targetEchoGraceSummary?.focusedQueueAgeMs ?? 0,
    appPostInputReadyEchoFramePressureLevel: completionSample?.framePressureLevel ?? null,
    appPostInputReadyEchoMs: appSwitchEchoObserved
      ? (targetEchoGraceSummary?.durationMs ?? null)
      : null,
    appPostInputReadyEchoNonTargetVisibleBytes: targetEchoGraceSummary?.nonTargetVisibleBytes ?? 0,
    appPostInputReadyEchoReason: appSwitchEchoObserved
      ? (targetEchoGraceSummary?.lastCompletion?.reason ?? null)
      : null,
    appPostInputReadyEchoVisibleBackgroundBytes:
      targetEchoGraceSummary?.visibleBackgroundBytes ?? 0,
    appPostInputReadyEchoVisibleBackgroundQueueAgeMs:
      targetEchoGraceSummary?.visibleBackgroundQueueAgeMs ?? 0,
    appFirstPaintMs: appSwitchObserved ? (switchWindowSummary?.firstPaintDurationMs ?? null) : null,
    appInputReadyMs: appSwitchObserved ? (switchWindowSummary?.inputReadyDurationMs ?? null) : null,
    appSwitchDurationMs: appSwitchObserved
      ? (switchWindowSummary?.lastCompletion?.durationMs ?? null)
      : null,
    appSwitchReason: appSwitchObserved
      ? (switchWindowSummary?.lastCompletion?.reason ?? null)
      : null,
    focusedBytes: switchWindowSummary?.focusedBytes ?? 0,
    focusedQueueAgeMs: switchWindowSummary?.focusedQueueAgeMs ?? 0,
    firstPaintMs: switchSummary.firstPaintMs,
    firstPaintFramePressureLevel: firstPaintSample?.framePressureLevel ?? null,
    firstPaintFocusedBytes: firstPaintSample?.focusedBytes ?? 0,
    firstPaintFocusedQueueAgeMs: firstPaintSample?.focusedQueueAgeMs ?? 0,
    firstPaintHiddenBytes: firstPaintSample?.hiddenBytes ?? 0,
    firstPaintHiddenQueueAgeMs: firstPaintSample?.hiddenQueueAgeMs ?? 0,
    firstPaintNonTargetVisibleBytes: firstPaintSample?.nonTargetVisibleBytes ?? 0,
    firstPaintSwitchTargetVisibleBytes: firstPaintSample?.switchTargetVisibleBytes ?? 0,
    hiddenBytes: switchWindowSummary?.hiddenBytes ?? 0,
    hiddenQueueAgeMs: switchWindowSummary?.hiddenQueueAgeMs ?? 0,
    inputReadyMs: switchSummary.inputReadyMs,
    inputReadyFramePressureLevel: inputReadySample?.framePressureLevel ?? null,
    inputReadyFocusedBytes: inputReadySample?.focusedBytes ?? 0,
    inputReadyFocusedQueueAgeMs: inputReadySample?.focusedQueueAgeMs ?? 0,
    inputReadyHiddenBytes: inputReadySample?.hiddenBytes ?? 0,
    inputReadyHiddenQueueAgeMs: inputReadySample?.hiddenQueueAgeMs ?? 0,
    inputReadyNonTargetVisibleBytes: inputReadySample?.nonTargetVisibleBytes ?? 0,
    inputReadySwitchTargetVisibleBytes: inputReadySample?.switchTargetVisibleBytes ?? 0,
    pauseMs: switchSummary.replayEntry?.pauseMs ?? 0,
    queuedQueueAgeMs: switchWindowSummary?.queuedQueueAgeMs ?? 0,
    replayEntryCountAfterSwitch: switchSummary.replayEntryCountAfterSwitch ?? 0,
    recoveryFetchMs: switchSummary.replayEntry?.recoveryFetchMs ?? 0,
    recoveryKind: switchSummary.replayEntry?.recoveryKind ?? null,
    restoreTotalMs: switchSummary.replayEntry?.restoreTotalMs ?? 0,
    roundTripMs: switchSummary.roundTripMs,
    postInputReadyEchoDelayMs,
    applyMs: switchSummary.replayEntry?.applyMs ?? 0,
    chunkCount: switchSummary.replayEntry?.chunkCount ?? 0,
    recoveryRequestStateBytes: switchSummary.replayEntry?.requestStateBytes ?? 0,
    resumeMs: switchSummary.replayEntry?.resumeMs ?? 0,
    selectedRecoveryActive: switchWindowSummary?.selectedRecoveryActive ?? false,
    selectedRecoveryProtected: switchSummary.replayEntry?.selectedRecoveryProtected === true,
    targetSurfaceTier: switchSummary.targetLifecycleState?.surfaceTier ?? null,
    targetWasDormant: switchSummary.targetLifecycleState?.isDormant === true,
    targetWasRenderHibernating: switchSummary.targetLifecycleState?.isRenderHibernating === true,
    failureReason: switchSummary.failureReason ?? null,
    switchTargetVisibleBytes: switchWindowSummary?.switchTargetVisibleBytes ?? 0,
    switchTargetVisibleQueueAgeMs: switchWindowSummary?.switchTargetVisibleQueueAgeMs ?? 0,
    waitForOutputIdleMs: switchSummary.replayEntry?.waitForOutputIdleMs ?? 0,
    visibleBackgroundBytes: switchWindowSummary?.visibleBackgroundBytes ?? 0,
    visibleBackgroundQueueAgeMs: switchWindowSummary?.visibleBackgroundQueueAgeMs ?? 0,
    visibleBytes: switchWindowSummary?.visibleBytes ?? 0,
    visibleQueueAgeMs: switchWindowSummary?.visibleQueueAgeMs ?? 0,
    writtenBytes: switchSummary.replayEntry?.writtenBytes ?? 0,
  };
}

async function waitForHiddenWakePreconditions(page, options, suiteName, terminalEntries) {
  const baseHiddenTarget = selectHiddenSwitchTarget(terminalEntries);
  if (!baseHiddenTarget?.taskId) {
    throw new Error('Failed to select a hidden wake target');
  }

  await pollUntil(
    () => isTaskPanelVisible(page, baseHiddenTarget.taskId),
    (isVisible) => isVisible === false,
    TERMINAL_READY_TIMEOUT_MS,
    `task ${baseHiddenTarget.taskId} hidden before switch`,
  );

  if (suiteName === 'hidden_switch') {
    const hiddenSwitchTarget = await pollUntil(
      () => resolveHiddenSwitchTarget(page, terminalEntries, suiteName),
      (entry) => entry !== null,
      TERMINAL_READY_TIMEOUT_MS,
      'a hidden terminal to stay live before switch',
    );
    return hiddenSwitchTarget;
  }

  if (suiteName === 'recent_hidden_switch') {
    const recentDriver = selectRecentHiddenSwitchDriver(terminalEntries, baseHiddenTarget.taskId);
    if (!recentDriver?.taskId) {
      throw new Error('Failed to select a recent hidden switch driver');
    }

    await getSidebarTaskRow(page, baseHiddenTarget.taskId).click({ force: true });
    await waitForTaskTerminalReady(page, baseHiddenTarget.taskId);
    await getSidebarTaskRow(page, recentDriver.taskId).click({ force: true });
    await waitForTaskTerminalReady(page, recentDriver.taskId);
    await pollUntil(
      () => isTaskPanelVisible(page, baseHiddenTarget.taskId),
      (isVisible) => isVisible === false,
      TERMINAL_READY_TIMEOUT_MS,
      `task ${baseHiddenTarget.taskId} hidden after recent switch preparation`,
    );
    const hiddenLifecycleState = await readTaskLifecycleState(page, baseHiddenTarget.taskId);
    if (hiddenLifecycleState.isDormant || hiddenLifecycleState.isRenderHibernating) {
      throw new Error(
        `The recent_hidden_switch target ${baseHiddenTarget.taskId} aged out before measurement`,
      );
    }

    return baseHiddenTarget;
  }

  if (suiteName === 'hidden_render_wake') {
    const hibernationDelayMs = options.experimentConfig.hiddenTerminalHibernationDelayMs ?? null;
    if (hibernationDelayMs === null) {
      throw new Error('The hidden_render_wake suite requires a hidden terminal hibernation delay');
    }

    const renderWakeTarget = await pollUntil(
      () => resolveHiddenSwitchTarget(page, terminalEntries, suiteName),
      (entry) => entry !== null,
      TERMINAL_READY_TIMEOUT_MS,
      'a hidden terminal to enter render hibernation before switch',
    );
    return renderWakeTarget;
  }

  const sessionDormancyDelayMs =
    options.experimentConfig.hiddenTerminalSessionDormancyDelayMs ?? null;
  if (suiteName === 'hidden_session_wake' || sessionDormancyDelayMs !== null) {
    if (sessionDormancyDelayMs === null) {
      throw new Error(
        'The hidden_session_wake suite requires a hidden terminal session dormancy delay',
      );
    }

    const dormantTarget = await pollUntil(
      () => resolveHiddenSwitchTarget(page, terminalEntries, suiteName),
      (entry) => entry !== null,
      sessionDormancyDelayMs + TERMINAL_READY_TIMEOUT_MS,
      'a hidden terminal to enter session dormancy before switch',
    );
    return dormantTarget;
  }

  return baseHiddenTarget;
}

function isHiddenWakeSuiteName(suiteName) {
  return (
    suiteName === 'hidden_switch' ||
    suiteName === 'recent_hidden_switch' ||
    suiteName === 'hidden_render_wake' ||
    suiteName === 'hidden_session_wake'
  );
}

function createBulkTextWorkloadCommand(suiteName, terminalIndex, durationMs) {
  const label = `${suiteName}-bulk-${terminalIndex + 1}`;
  return [
    `node ${SESSION_STRESS_AGENT_ENTRY}`,
    '--style lines',
    `--label ${label}`,
    `--line-count ${Math.max(20_000, Math.ceil(durationMs * 12))}`,
    '--line-bytes 960',
  ].join(' ');
}

function createVerboseBurstWorkloadCommand(style, suiteName, terminalIndex, durationMs) {
  const label = `${suiteName}-burst-${terminalIndex + 1}`;
  return [
    `node ${SESSION_STRESS_AGENT_ENTRY}`,
    `--style ${style}`,
    `--label ${label}`,
    `--paragraph-count ${Math.max(180, Math.ceil(durationMs / 40))}`,
    '--paragraph-bytes 720',
    '--line-width 108',
  ].join(' ');
}

function createStatuslineWorkloadCommand(suiteName, terminalIndex, durationMs) {
  const label = `${suiteName}-status-${terminalIndex + 1}`;
  return [
    `node ${SESSION_STRESS_AGENT_ENTRY}`,
    '--style statusline',
    `--label ${label}`,
    `--frame-count ${Math.max(180, Math.ceil(durationMs / 20))}`,
    '--frame-delay-ms 20',
    '--chunk-delay-ms 0',
    `--footer-top-row ${18 + (terminalIndex % 6)}`,
  ].join(' ');
}

function createMixedWorkloadCommand(suiteName, terminalIndex, durationMs) {
  const label = `${suiteName}-mixed-${terminalIndex + 1}`;
  return [
    `node ${SESSION_STRESS_AGENT_ENTRY}`,
    '--style mixed',
    `--label ${label}`,
    `--paragraph-count ${Math.max(180, Math.ceil(durationMs / 40))}`,
    '--paragraph-bytes 720',
    '--line-width 108',
    `--frame-count ${Math.max(300, Math.ceil(durationMs / 16))}`,
    '--frame-delay-ms 18',
    '--chunk-delay-ms 1',
    `--footer-top-row ${18 + (terminalIndex % 6)}`,
  ].join(' ');
}

function withReadyMarker(command, readyMarker) {
  return `STRESS_READY_MARKER=${readyMarker} ${command}`;
}

function getWorkloadLaunch(profileName, terminalIndex, durationMs, isFocusedTerminal) {
  if (isFocusedTerminal) {
    return null;
  }

  switch (profileName) {
    case 'bulk_text':
      return {
        command: withReadyMarker(
          createBulkTextWorkloadCommand(profileName, terminalIndex, durationMs),
          `${profileName}-ready-${terminalIndex + 1}`,
        ),
        readyText: `${profileName}-ready-${terminalIndex + 1}`,
      };
    case 'markdown_burst':
      return {
        command: withReadyMarker(
          createVerboseBurstWorkloadCommand(
            'markdown-burst',
            profileName,
            terminalIndex,
            durationMs,
          ),
          `${profileName}-ready-${terminalIndex + 1}`,
        ),
        readyText: `${profileName}-ready-${terminalIndex + 1}`,
      };
    case 'code_burst':
      return {
        command: withReadyMarker(
          createVerboseBurstWorkloadCommand('code-burst', profileName, terminalIndex, durationMs),
          `${profileName}-ready-${terminalIndex + 1}`,
        ),
        readyText: `${profileName}-ready-${terminalIndex + 1}`,
      };
    case 'diff_burst':
      return {
        command: withReadyMarker(
          createVerboseBurstWorkloadCommand('diff-burst', profileName, terminalIndex, durationMs),
          `${profileName}-ready-${terminalIndex + 1}`,
        ),
        readyText: `${profileName}-ready-${terminalIndex + 1}`,
      };
    case 'agent_cli_burst':
      return {
        command: withReadyMarker(
          createVerboseBurstWorkloadCommand(
            'agent-cli-burst',
            profileName,
            terminalIndex,
            durationMs,
          ),
          `${profileName}-ready-${terminalIndex + 1}`,
        ),
        readyText: `${profileName}-ready-${terminalIndex + 1}`,
      };
    case 'statusline':
      return {
        command: withReadyMarker(
          createStatuslineWorkloadCommand(profileName, terminalIndex, durationMs),
          `${profileName}-ready-${terminalIndex + 1}`,
        ),
        readyText: `${profileName}-ready-${terminalIndex + 1}`,
      };
    case 'hidden_switch':
    case 'hidden_render_wake':
    case 'hidden_session_wake':
    case 'mixed_agents':
    case 'interactive_verbose':
      if (terminalIndex % 3 === 0) {
        return {
          command: withReadyMarker(
            createMixedWorkloadCommand(profileName, terminalIndex, durationMs),
            `${profileName}-ready-${terminalIndex + 1}`,
          ),
          readyText: `${profileName}-ready-${terminalIndex + 1}`,
        };
      }
      if (terminalIndex % 3 === 1) {
        return {
          command: withReadyMarker(
            createStatuslineWorkloadCommand(profileName, terminalIndex, durationMs),
            `${profileName}-ready-${terminalIndex + 1}`,
          ),
          readyText: `${profileName}-ready-${terminalIndex + 1}`,
        };
      }
      return {
        command: withReadyMarker(
          createBulkTextWorkloadCommand(profileName, terminalIndex, durationMs),
          `${profileName}-ready-${terminalIndex + 1}`,
        ),
        readyText: `${profileName}-ready-${terminalIndex + 1}`,
      };
    default:
      throw new Error(`Unknown workload profile: ${profileName}`);
  }
}

async function createTerminals(page, terminalCount) {
  const createdTerminalIndices = [];
  for (let index = 0; index < terminalCount; index += 1) {
    createdTerminalIndices.push(await createShellTerminal(page));
  }
  return createdTerminalIndices;
}

async function waitForAnySeededTaskTerminalReady(page, seededTasks) {
  const taskIds = seededTasks
    .map((seededTask) => seededTask.taskId)
    .filter((taskId) => typeof taskId === 'string' && taskId.length > 0);
  if (taskIds.length === 0) {
    throw new Error('Expected at least one seeded agent task');
  }

  const readyTaskId = await pollUntil(
    () =>
      page.evaluate((candidateTaskIds) => {
        for (const taskId of candidateTaskIds) {
          const panel = globalThis.document.querySelector(`[data-task-id="${taskId}"]`);
          if (!(panel instanceof globalThis.HTMLElement)) {
            continue;
          }

          const isVisible =
            panel.offsetParent !== null && panel.offsetWidth > 0 && panel.offsetHeight > 0;
          if (!isVisible) {
            continue;
          }

          const status = panel
            .querySelector('[data-terminal-status]')
            ?.getAttribute('data-terminal-status');
          if (status === 'ready') {
            return taskId;
          }
        }

        return '';
      }, taskIds),
    (taskId) => typeof taskId === 'string' && taskId.length > 0,
    TERMINAL_READY_TIMEOUT_MS * 2,
    'any seeded task ready',
  );

  await waitForTaskTerminalReady(page, readyTaskId);
}

async function waitForSeededAgentTerminals(page, seededTasks) {
  await waitForAnySeededTaskTerminalReady(page, seededTasks);

  return seededTasks.map((seededTask, terminalIndex) => ({
    agentId: seededTask.agentId,
    readyMarker: seededTask.readyMarker,
    taskId: seededTask.taskId,
    terminalIndex,
  }));
}

async function waitForAgentScrollback(client, agentId, text, timeoutMs = 15_000) {
  let lastDecoded = '';

  try {
    await pollUntil(
      async () => {
        let scrollback = '';
        try {
          const nextScrollback = await client.invokeIpc(GET_AGENT_SCROLLBACK, { agentId });
          scrollback = typeof nextScrollback === 'string' ? nextScrollback : '';
        } catch (error) {
          if (isRetryableBrowserServerError(error)) {
            return lastDecoded;
          }
          throw error;
        }

        if (typeof scrollback !== 'string' || scrollback.length === 0) {
          lastDecoded = '';
          return '';
        }

        lastDecoded = globalThis.Buffer.from(scrollback, 'base64').toString('utf8');
        return lastDecoded;
      },
      (decoded) => decoded.includes(text),
      timeoutMs,
      `agent ${agentId} scrollback containing ${text}`,
    );
  } catch (error) {
    const tail = lastDecoded.slice(-240);
    throw new Error(
      `Timed out waiting for agent ${agentId} scrollback containing ${text}. Last scrollback tail:\n${tail}`,
      { cause: error },
    );
  }
}

function getSeededAgentReadyTimeoutMs(options) {
  const visibleTerminalCount =
    options.visibleTerminalCount === null ? options.terminals : options.visibleTerminalCount;
  const hiddenTerminalCount = Math.max(0, options.terminals - visibleTerminalCount);
  return Math.max(
    SEEDED_AGENT_READY_TIMEOUT_MS,
    SEEDED_AGENT_READY_TIMEOUT_MS + options.terminals * 1_000 + hiddenTerminalCount * 750,
  );
}

async function waitForSeededAgentsReady(client, seededTasks, timeoutMs) {
  await Promise.all(
    seededTasks.map((seededTask) =>
      waitForAgentScrollback(client, seededTask.agentId, seededTask.readyMarker, timeoutMs),
    ),
  );
}

async function waitForTerminalOutputActivity(page, minimumWriteCalls = 1) {
  await pollUntil(
    () =>
      page.evaluate(() => {
        const snapshot = globalThis.window.__parallelCodeUiFluidityDiagnostics?.getSnapshot();
        return snapshot?.terminalOutput?.writes?.totalCalls ?? 0;
      }),
    (totalCalls) => typeof totalCalls === 'number' && totalCalls >= minimumWriteCalls,
    TERMINAL_READY_TIMEOUT_MS,
    `terminal output activity (${minimumWriteCalls} writes)`,
  );
}

async function waitForActiveVisibleOutputActivity(page, minimumBytes = 1) {
  await pollUntil(
    () =>
      page.evaluate(() => {
        const snapshot = globalThis.window.__parallelCodeUiFluidityDiagnostics?.getSnapshot();
        return snapshot?.terminalOutput?.writes?.byPriority?.['active-visible']?.bytes ?? 0;
      }),
    (activeVisibleBytes) =>
      typeof activeVisibleBytes === 'number' && activeVisibleBytes >= minimumBytes,
    TERMINAL_READY_TIMEOUT_MS,
    `active-visible terminal output activity (${minimumBytes} bytes)`,
  );
}

async function prepareActiveVisibleSelectedTask(page, taskId) {
  await waitForTaskTerminalReady(page, taskId);
  await getTaskPromptTextarea(page, taskId).click({ force: true });
  await pollUntil(
    () =>
      page.evaluate(
        ({ targetTaskId }) => {
          const panel = globalThis.document.querySelector(`[data-task-id="${targetTaskId}"]`);
          if (!(panel instanceof globalThis.HTMLElement)) {
            return false;
          }

          const promptInput = panel.querySelector('.prompt-textarea');
          const shellContainer = panel.querySelector('[data-shell-focused]');
          return (
            promptInput instanceof globalThis.HTMLTextAreaElement &&
            globalThis.document.activeElement === promptInput &&
            shellContainer instanceof globalThis.HTMLElement &&
            shellContainer.getAttribute('data-shell-focused') === 'false'
          );
        },
        {
          targetTaskId: taskId,
        },
      ),
    (terminalBlurred) => terminalBlurred === true,
    TERMINAL_READY_TIMEOUT_MS,
    `active-visible task ${taskId} terminal blurred`,
  );
}

async function startTerminalWorkloads(page, client, terminalIndices, profileName, durationMs) {
  for (const [index, terminalIndex] of terminalIndices.entries()) {
    const launch = getWorkloadLaunch(profileName, terminalIndex, durationMs, index === 0);
    if (!launch) {
      continue;
    }

    await typeLineInTerminal(page, terminalIndex, launch.command);
    const agentId = await readTerminalAgentId(page, terminalIndex);
    if (!agentId) {
      throw new Error(`Terminal ${terminalIndex} did not expose an agent id`);
    }
    await waitForAgentScrollback(client, agentId, launch.readyText);
  }
}

async function runFocusedInputProbes(
  page,
  terminalIndex,
  measurementDurationMs,
  probeCount,
  inputIntervalMs,
) {
  const startedAt = Date.now();
  const echoAfterDispatchSamples = [];
  const inputDispatchSamples = [];
  const renderAfterReceiveSamples = [];
  const renderedRoundTripSamples = [];
  let attemptedCount = 0;
  let renderedTimeoutCount = 0;
  let timeoutCount = 0;
  for (let probeIndex = 0; probeIndex < probeCount; probeIndex += 1) {
    attemptedCount += 1;
    const probeResult = await measureFocusedRoundTripDetailsSafely(page, terminalIndex);
    if (Number.isFinite(probeResult.inputDispatchMs)) {
      inputDispatchSamples.push(probeResult.inputDispatchMs);
    }

    if (probeResult.roundTripMs < 0) {
      timeoutCount += 1;
    } else {
      echoAfterDispatchSamples.push(probeResult.echoAfterDispatchMs);
    }

    if (probeResult.renderedRoundTripMs < 0) {
      renderedTimeoutCount += 1;
    } else {
      renderedRoundTripSamples.push(probeResult.renderedRoundTripMs);
      renderAfterReceiveSamples.push(probeResult.renderAfterReceiveMs);
    }

    if (probeIndex === probeCount - 1) {
      break;
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = measurementDurationMs - elapsedMs;
    if (remainingMs <= 0) {
      break;
    }
    await page.waitForTimeout(Math.min(inputIntervalMs, remainingMs));
  }

  return {
    attemptedCount,
    echoAfterDispatch: summarizeDurations(echoAfterDispatchSamples),
    elapsedMs: Date.now() - startedAt,
    inputDispatch: summarizeDurations(inputDispatchSamples),
    renderAfterReceive: summarizeDurations(renderAfterReceiveSamples),
    renderedRoundTrip: summarizeDurations(renderedRoundTripSamples),
    renderedTimeoutCount,
    timeoutCount,
  };
}

async function waitForAnimationFrames(page, frameCount) {
  await page.evaluate(async (requestedFrameCount) => {
    for (let completed = 0; completed < requestedFrameCount; completed += 1) {
      await new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve(undefined)));
    }
  }, frameCount);
}

function getInputProbeCount(options, suiteName) {
  if (suiteName === 'interactive_verbose') {
    return Math.max(4, Math.ceil(options.durationMs / options.inputIntervalMs));
  }

  return SUITE_DEFINITIONS[suiteName]?.inputProbes ?? 2;
}

async function collectUiFluiditySnapshot(page) {
  return page.evaluate(
    () => globalThis.window.__parallelCodeUiFluidityDiagnostics?.getSnapshot() ?? null,
  );
}

function createSuiteSummary(suiteName, suiteResult) {
  const backendDiagnostics = suiteResult.backendDiagnosticsSnapshot;
  const backendTrace = backendDiagnostics.terminalInputTracing;
  const backendTraceSummary = backendTrace.summary;
  const uiSnapshot = suiteResult.uiSnapshot;
  const browserControlSummary = suiteResult.terminalLatencySnapshot.browserControl ?? {
    nonZeroBufferedSendAttempts: 0,
    postSendBufferedAmountMax: 0,
    sendAttempts: 0,
    sendBufferedAmountMax: 0,
    sendDurationMs: createEmptyLatencyStats(),
  };
  const flowSummary = suiteResult.terminalLatencySnapshot.flow;
  const inputSummary = suiteResult.terminalLatencySnapshot.input;
  const renderedRoundTripSummary = suiteResult.terminalLatencySnapshot.renderedRoundTrip;
  const roundTripSummary = suiteResult.terminalLatencySnapshot.roundTrip;
  const renderSummary = suiteResult.terminalLatencySnapshot.render;
  const hiddenSwitchRoundTripMs = suiteResult.switchSummary?.roundTripMs ?? null;
  const skipsFocusedRoundTripProbes = suiteResult.inputProbeSummary.attemptedCount === 0;
  const usesHiddenSwitchRoundTrip =
    isHiddenWakeSuiteName(suiteName) && hiddenSwitchRoundTripMs !== null;
  const nonHiddenRoundTripFallbackMs = skipsFocusedRoundTripProbes
    ? null
    : roundTripSummary.count > 0 || suiteResult.inputProbeSummary.timeoutCount === 0
      ? 0
      : -1;
  const normalizedFocusedRoundTripSummary = usesHiddenSwitchRoundTrip
    ? {
        count: hiddenSwitchRoundTripMs >= 0 ? 1 : 0,
        max: hiddenSwitchRoundTripMs,
        p50: hiddenSwitchRoundTripMs,
        p95: hiddenSwitchRoundTripMs,
        timeoutCount: hiddenSwitchRoundTripMs < 0 ? 1 : 0,
      }
    : {
        count: roundTripSummary.count,
        max: roundTripSummary.count > 0 ? roundTripSummary.max : nonHiddenRoundTripFallbackMs,
        p50: roundTripSummary.count > 0 ? roundTripSummary.p50 : nonHiddenRoundTripFallbackMs,
        p95: roundTripSummary.count > 0 ? roundTripSummary.p95 : nonHiddenRoundTripFallbackMs,
        timeoutCount: suiteResult.inputProbeSummary.timeoutCount,
      };

  return {
    experiment: uiSnapshot.experiment,
    focusedRoundTrip: {
      attemptedCount: suiteResult.inputProbeSummary.attemptedCount,
      count: normalizedFocusedRoundTripSummary.count,
      echoAfterDispatchP95Ms: suiteResult.inputProbeSummary.echoAfterDispatch?.p95Ms ?? 0,
      initiallyReady: suiteResult.initialRoundTripReady === true,
      inputDispatchP95Ms: suiteResult.inputProbeSummary.inputDispatch?.p95Ms ?? 0,
      maxMs: normalizedFocusedRoundTripSummary.max,
      p50Ms: normalizedFocusedRoundTripSummary.p50,
      p95Ms: normalizedFocusedRoundTripSummary.p95,
      renderAfterReceiveP95Ms: suiteResult.inputProbeSummary.renderAfterReceive?.p95Ms ?? 0,
      renderedP95Ms:
        suiteResult.inputProbeSummary.renderedRoundTrip?.p95Ms ?? renderedRoundTripSummary.p95,
      renderedTimeoutCount: suiteResult.inputProbeSummary.renderedTimeoutCount ?? 0,
      timeoutCount: normalizedFocusedRoundTripSummary.timeoutCount,
    },
    frameGap: {
      maxMs: uiSnapshot.frames.gapMs.max,
      overBudget16ms: uiSnapshot.frames.overBudget16ms,
      overBudget33ms: uiSnapshot.frames.overBudget33ms,
      overBudget50ms: uiSnapshot.frames.overBudget50ms,
      pressureCounts: uiSnapshot.frames.pressureCounts,
      p95Ms: uiSnapshot.frames.gapMs.p95,
    },
    longTasks: {
      count: uiSnapshot.longTasks.durationMs.count,
      maxMs: uiSnapshot.longTasks.durationMs.max,
      p95Ms: uiSnapshot.longTasks.durationMs.p95,
      totalDurationMs: uiSnapshot.longTasks.totalDurationMs,
    },
    focusedInput: {
      active: uiSnapshot.focusedInput.active,
      ageMs: uiSnapshot.focusedInput.ageMs,
      echoReservationActive: uiSnapshot.focusedInput.echoReservationActive,
      echoReservationRemainingMs: uiSnapshot.focusedInput.echoReservationRemainingMs,
      remainingMs: uiSnapshot.focusedInput.remainingMs,
      taskId: uiSnapshot.focusedInput.taskId,
    },
    terminalInput: {
      accepted: {
        avgMs: inputSummary.accepted.avg,
        count: inputSummary.accepted.count,
        maxMs: inputSummary.accepted.max,
        p50Ms: inputSummary.accepted.p50,
        p95Ms: inputSummary.accepted.p95,
      },
      acceptedSettled: {
        avgMs: inputSummary.acceptedSettled.avg,
        count: inputSummary.acceptedSettled.count,
        maxMs: inputSummary.acceptedSettled.max,
        p50Ms: inputSummary.acceptedSettled.p50,
        p95Ms: inputSummary.acceptedSettled.p95,
      },
      buffered: {
        avgMs: inputSummary.buffered.avg,
        count: inputSummary.buffered.count,
        maxMs: inputSummary.buffered.max,
        p50Ms: inputSummary.buffered.p50,
        p95Ms: inputSummary.buffered.p95,
      },
      commandResultReceived: {
        avgMs: inputSummary.commandResultReceived.avg,
        count: inputSummary.commandResultReceived.count,
        maxMs: inputSummary.commandResultReceived.max,
        p50Ms: inputSummary.commandResultReceived.p50,
        p95Ms: inputSummary.commandResultReceived.p95,
      },
      dispatched: {
        avgMs: inputSummary.dispatched.avg,
        count: inputSummary.dispatched.count,
        maxMs: inputSummary.dispatched.max,
        p50Ms: inputSummary.dispatched.p50,
        p95Ms: inputSummary.dispatched.p95,
      },
      leaseWait: {
        avgMs: inputSummary.leaseWait.avg,
        count: inputSummary.leaseWait.count,
        maxMs: inputSummary.leaseWait.max,
        p50Ms: inputSummary.leaseWait.p50,
        p95Ms: inputSummary.leaseWait.p95,
      },
      sent: {
        avgMs: inputSummary.sent.avg,
        count: inputSummary.sent.count,
        maxMs: inputSummary.sent.max,
        p50Ms: inputSummary.sent.p50,
        p95Ms: inputSummary.sent.p95,
      },
    },
    rendererTerminalInput: {
      bufferedCharsMax: uiSnapshot.rendererRuntime.terminalInput.bufferedCharsMax,
      droppedSuffixBatches: uiSnapshot.rendererRuntime.terminalInput.droppedSuffixBatches,
      inFlightBatchesMax: uiSnapshot.rendererRuntime.terminalInput.inFlightBatchesMax,
      queuedChunksMax: uiSnapshot.rendererRuntime.terminalInput.queuedChunksMax,
      retrySchedules: uiSnapshot.rendererRuntime.terminalInput.retrySchedules,
      sentBatchCharsMax: uiSnapshot.rendererRuntime.terminalInput.sentBatchCharsMax,
      sentBatches: uiSnapshot.rendererRuntime.terminalInput.sentBatches,
    },
    browserControlClient: {
      byType: browserControlSummary.byType ?? {},
      nonZeroBufferedSendAttempts: browserControlSummary.nonZeroBufferedSendAttempts,
      postSendBufferedAmountMax: browserControlSummary.postSendBufferedAmountMax,
      sendAttempts: browserControlSummary.sendAttempts,
      sendBufferedAmountMax: browserControlSummary.sendBufferedAmountMax,
      sendDurationP95Ms: browserControlSummary.sendDurationMs.p95,
    },
    terminalFlowControl: {
      avgPauseRequestWindowMs: flowSummary.avgPauseRequestWindowMs,
      pauseRequests: flowSummary.pauseRequests,
      resumeRequests: flowSummary.resumeRequests,
    },
    backendInputTrace: {
      activeTraceCount: backendTrace.activeTraceCount,
      backendOutputBufferP95Ms: backendTraceSummary.backendOutputBufferMs.p95,
      browserChannelDispatchP95Ms: backendTraceSummary.browserChannelDispatchMs.p95,
      browserDeliveryP95Ms: backendTraceSummary.browserDeliveryMs.p95,
      browserTransportDeliveryP95Ms: backendTraceSummary.browserTransportDeliveryMs.p95,
      clientBufferP95Ms: backendTraceSummary.clientBufferMs.p95,
      clientSendP95Ms: backendTraceSummary.clientSendMs.p95,
      commandAckP95Ms: backendTraceSummary.commandAckMs.p95,
      completedCount: backendTraceSummary.count,
      droppedTraces: backendTrace.droppedTraces,
      endToEndP95Ms: backendTraceSummary.endToEndMs.p95,
      ptyEchoP95Ms: backendTraceSummary.ptyEchoMs.p95,
      ptyWriteToCommandAckP95Ms: backendTraceSummary.ptyWriteToCommandAckMs.p95,
      renderP95Ms: backendTraceSummary.renderMs.p95,
      sendToEchoP95Ms: backendTraceSummary.sendToEchoMs.p95,
      serverQueueP95Ms: backendTraceSummary.serverQueueMs.p95,
      transportResidualP95Ms: backendTraceSummary.transportResidualMs.p95,
    },
    backendPtyInput: {
      coalescedMessages: backendDiagnostics.ptyInput.coalescedMessages,
      enqueuedMessages: backendDiagnostics.ptyInput.enqueuedMessages,
      flushes: backendDiagnostics.ptyInput.flushes,
      maxQueuedChars: backendDiagnostics.ptyInput.maxQueuedChars,
      writeFailures: backendDiagnostics.ptyInput.writeFailures,
    },
    backendBrowserControl: {
      backpressureRejects: backendDiagnostics.browserControl.backpressureRejects,
      delayedQueueMaxAgeMs: backendDiagnostics.browserControl.delayedQueueMaxAgeMs,
      delayedQueueMaxBytes: backendDiagnostics.browserControl.delayedQueueMaxBytes,
      delayedQueueMaxDepth: backendDiagnostics.browserControl.delayedQueueMaxDepth,
      maxBufferedAmountBytes: backendDiagnostics.browserControl.maxBufferedAmountBytes ?? 0,
      notOpenRejects: backendDiagnostics.browserControl.notOpenRejects,
      sendErrors: backendDiagnostics.browserControl.sendErrors,
    },
    pacing: {
      denseFocusedInputProtectionActive: uiSnapshot.pacing.denseFocusedInputProtectionActive,
      focusedPreemptionWindowActive: uiSnapshot.pacing.focusedPreemptionWindowActive,
      framePressureLevel: uiSnapshot.pacing.framePressureLevel,
      hiddenLaneFrameBudgetBytes: uiSnapshot.pacing.laneFrameBudgetBytes.hidden,
      focusedLaneFrameBudgetBytes: uiSnapshot.pacing.laneFrameBudgetBytes.focused,
      sharedNonTargetVisibleFrameBudgetBytes:
        uiSnapshot.pacing.sharedNonTargetVisibleFrameBudgetBytes,
      switchTargetReserveBudgetBytes: uiSnapshot.pacing.switchTargetReserveBudgetBytes,
      switchWindowActive: uiSnapshot.pacing.switchWindowActive,
      visibleLaneFrameBudgetBytes: uiSnapshot.pacing.laneFrameBudgetBytes.visible,
      visibleTerminalCount: uiSnapshot.pacing.visibleTerminalCount,
    },
    profile: suiteName,
    terminalOutputTotals: {
      activeVisibleBytes: uiSnapshot.terminalOutput.writes.byPriority['active-visible'].bytes,
      focusedBytes: uiSnapshot.terminalOutput.writes.byLane.focused.bytes,
      hiddenBytes: uiSnapshot.terminalOutput.writes.byLane.hidden.bytes,
      queuedBytes: uiSnapshot.terminalOutput.writes.bySource.queued.bytes,
      suppressedBytes: uiSnapshot.terminalOutput.suppressed.totalBytes,
      suppressedChunks: uiSnapshot.terminalOutput.suppressed.totalChunks,
      totalBytes: uiSnapshot.terminalOutput.writes.totalBytes,
      totalCalls: uiSnapshot.terminalOutput.writes.totalCalls,
      visibleBytes: uiSnapshot.terminalOutput.writes.byLane.visible.bytes,
      visibleBackgroundBytes:
        uiSnapshot.terminalOutput.writes.byPriority['visible-background'].bytes,
    },
    runtimePerFrame: {
      activeWebglContextsP95: uiSnapshot.runtimePerFrame.activeWebglContexts.p95,
      agentAnalysisP95Ms: uiSnapshot.runtimePerFrame.agentAnalysisDurationMs.p95,
      ownerP95Ms: uiSnapshot.runtimePerFrame.ownerDurationMs.p95,
      schedulerDrainP95Ms: uiSnapshot.runtimePerFrame.schedulerDrainDurationMs.p95,
      schedulerScanP95Ms: uiSnapshot.runtimePerFrame.schedulerScanDurationMs.p95,
      visibleWebglContextsP95: uiSnapshot.runtimePerFrame.visibleWebglContexts.p95,
    },
    terminalFit: {
      dirtyMarks: uiSnapshot.rendererRuntime.terminalFit.dirtyMarks,
      dirtyReasonCounts: uiSnapshot.rendererRuntime.terminalFit.dirtyReasonCounts,
      executionCounts: uiSnapshot.rendererRuntime.terminalFit.executionCounts,
      flushCalls: uiSnapshot.rendererRuntime.terminalFit.flushCalls,
      geometryChangeFits: uiSnapshot.rendererRuntime.terminalFit.geometryChangeFits,
      idleFlushCalls: uiSnapshot.rendererRuntime.terminalFit.idleFlushCalls,
      noopSkips: uiSnapshot.rendererRuntime.terminalFit.noopSkips,
      scheduleCalls: uiSnapshot.rendererRuntime.terminalFit.scheduleCalls,
      scheduleReasonCounts: uiSnapshot.rendererRuntime.terminalFit.scheduleReasonCounts,
    },
    terminalRenderer: {
      acquireAttempts: uiSnapshot.rendererRuntime.terminalRenderer.acquireAttempts,
      acquireHits: uiSnapshot.rendererRuntime.terminalRenderer.acquireHits,
      acquireMisses: uiSnapshot.rendererRuntime.terminalRenderer.acquireMisses,
      activeContextsCurrent: uiSnapshot.rendererRuntime.terminalRenderer.activeContextsCurrent,
      activeContextsMax: uiSnapshot.rendererRuntime.terminalRenderer.activeContextsMax,
      explicitReleases: uiSnapshot.rendererRuntime.terminalRenderer.explicitReleases,
      fallbackActivations: uiSnapshot.rendererRuntime.terminalRenderer.fallbackActivations,
      fallbackRecoveries: uiSnapshot.rendererRuntime.terminalRenderer.fallbackRecoveries,
      rendererSwapCounts: uiSnapshot.rendererRuntime.terminalRenderer.rendererSwapCounts,
      visibleContextsCurrent: uiSnapshot.rendererRuntime.terminalRenderer.visibleContextsCurrent,
      visibleContextsMax: uiSnapshot.rendererRuntime.terminalRenderer.visibleContextsMax,
      webglEvictions: uiSnapshot.rendererRuntime.terminalRenderer.webglEvictions,
    },
    switchWake: createSwitchWakeSummary(
      suiteResult.switchSummary,
      suiteResult.uiSnapshot.switchEchoGrace,
    ),
    terminalRender: {
      avgMs: renderSummary.avg,
      count: renderSummary.count,
      maxMs: renderSummary.max,
      p50Ms: renderSummary.p50,
      p95Ms: renderSummary.p95,
    },
    terminalOutputPerFrame: {
      activeWriteAgeP95Ms: uiSnapshot.terminalOutputPerFrame.activeWriteAgeMs.p95,
      activeWriteCountP95: uiSnapshot.terminalOutputPerFrame.activeWriteCount.p95,
      activeVisibleBytesP95: uiSnapshot.terminalOutputPerFrame.activeVisibleBytes.p95,
      activeVisibleQueueAgeP95Ms: uiSnapshot.terminalOutputPerFrame.activeVisibleQueueAgeMs.p95,
      activeVisibleWriteDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.activeVisibleWriteDurationMs.p95,
      activeVisibleWriteFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.activeVisibleWriteFinalizationDurationMs.p95,
      controlWriteBytesP95: uiSnapshot.terminalOutputPerFrame.controlWriteBytes.p95,
      controlWriteDurationP95Ms: uiSnapshot.terminalOutputPerFrame.controlWriteDurationMs.p95,
      directWriteBytesP95: uiSnapshot.terminalOutputPerFrame.directWriteBytes.p95,
      directWriteCallsP95: uiSnapshot.terminalOutputPerFrame.directWriteCalls.p95,
      focusedQueueAgeP95Ms: uiSnapshot.terminalOutputPerFrame.focusedQueueAgeMs.p95,
      focusedWriteBytesP95: uiSnapshot.terminalOutputPerFrame.focusedWriteBytes.p95,
      focusedWriteDurationP95Ms: uiSnapshot.terminalOutputPerFrame.focusedWriteDurationMs.p95,
      focusedWriteFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.focusedWriteFinalizationDurationMs.p95,
      hiddenBytesP95: uiSnapshot.terminalOutputPerFrame.hiddenBytes.p95,
      hiddenQueueAgeP95Ms: uiSnapshot.terminalOutputPerFrame.hiddenQueueAgeMs.p95,
      nonTargetVisibleActiveWriteAgeP95Ms:
        uiSnapshot.terminalOutputPerFrame.nonTargetVisibleActiveWriteAgeMs.p95,
      nonTargetVisibleActiveWriteCountP95:
        uiSnapshot.terminalOutputPerFrame.nonTargetVisibleActiveWriteCount.p95,
      nonTargetVisibleBytesP95: uiSnapshot.terminalOutputPerFrame.nonTargetVisibleBytes.p95,
      plainWriteBytesP95: uiSnapshot.terminalOutputPerFrame.plainWriteBytes.p95,
      plainWriteDurationP95Ms: uiSnapshot.terminalOutputPerFrame.plainWriteDurationMs.p95,
      queuedWriteBytesP95: uiSnapshot.terminalOutputPerFrame.queuedWriteBytes.p95,
      queuedWriteCallsP95: uiSnapshot.terminalOutputPerFrame.queuedWriteCalls.p95,
      queuedWriteDurationP95Ms: uiSnapshot.terminalOutputPerFrame.queuedWriteDurationMs.p95,
      queuedWriteFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.queuedWriteFinalizationDurationMs.p95,
      queuedQueueAgeP95Ms: uiSnapshot.terminalOutputPerFrame.queuedQueueAgeMs.p95,
      redrawControlWriteBytesP95: uiSnapshot.terminalOutputPerFrame.redrawControlWriteBytes.p95,
      redrawControlWriteDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.redrawControlWriteDurationMs.p95,
      suppressedBytesP95: uiSnapshot.terminalOutputPerFrame.suppressedBytes.p95,
      visibleBytesP95: uiSnapshot.terminalOutputPerFrame.visibleBytes.p95,
      visibleBackgroundActiveWriteAgeP95Ms:
        uiSnapshot.terminalOutputPerFrame.visibleBackgroundActiveWriteAgeMs.p95,
      visibleBackgroundActiveWriteCountP95:
        uiSnapshot.terminalOutputPerFrame.visibleBackgroundActiveWriteCount.p95,
      visibleBackgroundBytesP95: uiSnapshot.terminalOutputPerFrame.visibleBackgroundBytes.p95,
      visibleBackgroundQueueAgeP95Ms:
        uiSnapshot.terminalOutputPerFrame.visibleBackgroundQueueAgeMs.p95,
      visibleBackgroundWriteDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.visibleBackgroundWriteDurationMs.p95,
      visibleBackgroundWriteFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.visibleBackgroundWriteFinalizationDurationMs.p95,
      visibleQueueAgeP95Ms: uiSnapshot.terminalOutputPerFrame.visibleQueueAgeMs.p95,
      writeBytesP95: uiSnapshot.terminalOutputPerFrame.writeBytes.p95,
      writeCallsP95: uiSnapshot.terminalOutputPerFrame.writeCalls.p95,
      writeDurationP95Ms: uiSnapshot.terminalOutputPerFrame.writeDurationMs.p95,
      writeFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputPerFrame.writeFinalizationDurationMs.p95,
    },
    terminalOutputDuringFocusedInputPerFrame: {
      activeWriteAgeP95Ms: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.activeWriteAgeMs.p95,
      activeWriteCountP95: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.activeWriteCount.p95,
      activeVisibleBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.activeVisibleBytes.p95,
      activeVisibleQueueAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.activeVisibleQueueAgeMs.p95,
      controlWriteBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.controlWriteBytes.p95,
      controlWriteDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.controlWriteDurationMs.p95,
      directWriteBytesP95: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.directWriteBytes.p95,
      directWriteCallsP95: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.directWriteCalls.p95,
      focusedWriteBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.focusedWriteBytes.p95,
      hiddenBytesP95: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.hiddenBytes.p95,
      nonTargetVisibleActiveWriteAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleActiveWriteAgeMs.p95,
      nonTargetVisibleActiveWriteCountP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleActiveWriteCount.p95,
      nonTargetVisibleActiveWriteStartedBeforeInputAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .nonTargetVisibleActiveWriteStartedBeforeInputAgeMs.p95,
      nonTargetVisibleActiveWriteStartedBeforeInputBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .nonTargetVisibleActiveWriteStartedBeforeInputBytes.p95,
      nonTargetVisibleActiveWriteStartedBeforeInputCountP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .nonTargetVisibleActiveWriteStartedBeforeInputCount.p95,
      nonTargetVisibleActiveWriteStartedDuringInputAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .nonTargetVisibleActiveWriteStartedDuringInputAgeMs.p95,
      nonTargetVisibleActiveWriteStartedDuringInputBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .nonTargetVisibleActiveWriteStartedDuringInputBytes.p95,
      nonTargetVisibleActiveWriteStartedDuringInputCountP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .nonTargetVisibleActiveWriteStartedDuringInputCount.p95,
      nonTargetVisibleBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleBytes.p95,
      nonTargetVisibleWriteDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleWriteDurationMs.p95,
      nonTargetVisibleWriteFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .nonTargetVisibleWriteFinalizationDurationMs.p95,
      plainWriteBytesP95: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.plainWriteBytes.p95,
      plainWriteDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.plainWriteDurationMs.p95,
      queuedWriteBytesP95: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.queuedWriteBytes.p95,
      queuedWriteCallsP95: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.queuedWriteCalls.p95,
      queuedQueueAgeP95Ms: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.queuedQueueAgeMs.p95,
      redrawControlWriteBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.redrawControlWriteBytes.p95,
      redrawControlWriteDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.redrawControlWriteDurationMs.p95,
      visibleBackgroundActiveWriteAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteAgeMs.p95,
      visibleBackgroundActiveWriteCountP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteCount.p95,
      visibleBackgroundActiveWriteStartedBeforeInputAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .visibleBackgroundActiveWriteStartedBeforeInputAgeMs.p95,
      visibleBackgroundActiveWriteStartedBeforeInputBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .visibleBackgroundActiveWriteStartedBeforeInputBytes.p95,
      visibleBackgroundActiveWriteStartedBeforeInputCountP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .visibleBackgroundActiveWriteStartedBeforeInputCount.p95,
      visibleBackgroundActiveWriteStartedDuringInputAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .visibleBackgroundActiveWriteStartedDuringInputAgeMs.p95,
      visibleBackgroundActiveWriteStartedDuringInputBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .visibleBackgroundActiveWriteStartedDuringInputBytes.p95,
      visibleBackgroundActiveWriteStartedDuringInputCountP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .visibleBackgroundActiveWriteStartedDuringInputCount.p95,
      visibleBackgroundBytesP95:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundBytes.p95,
      visibleBackgroundQueueAgeP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundQueueAgeMs.p95,
      visibleBackgroundWriteDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundWriteDurationMs.p95,
      visibleBackgroundWriteFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame
          .visibleBackgroundWriteFinalizationDurationMs.p95,
      writeDurationP95Ms: uiSnapshot.terminalOutputDuringFocusedInputPerFrame.writeDurationMs.p95,
      writeFinalizationDurationP95Ms:
        uiSnapshot.terminalOutputDuringFocusedInputPerFrame.writeFinalizationDurationMs.p95,
    },
    trace: suiteResult.traceSummary ?? null,
  };
}

function createMarkdownSummary(runSummary) {
  const lines = ['# Terminal UI Fluidity Summary', ''];

  for (const suite of runSummary.suites) {
    lines.push(`## ${suite.profile}`);
    lines.push(`- experiment=${suite.experiment.label}`);
    lines.push(
      `- frame gap p95=${formatMs(suite.frameGap.p95Ms)} max=${formatMs(suite.frameGap.maxMs)} missed16=${formatCount(suite.frameGap.overBudget16ms)} missed33=${formatCount(suite.frameGap.overBudget33ms)} missed50=${formatCount(suite.frameGap.overBudget50ms)}`,
    );
    lines.push(
      `- frame pressure counts stable=${formatCount(suite.frameGap.pressureCounts.stable)} elevated=${formatCount(suite.frameGap.pressureCounts.elevated)} critical=${formatCount(suite.frameGap.pressureCounts.critical)}`,
    );
    lines.push(
      `- long tasks count=${formatCount(suite.longTasks.count)} p95=${formatMs(suite.longTasks.p95Ms)} max=${formatMs(suite.longTasks.maxMs)} total=${formatMs(suite.longTasks.totalDurationMs)}`,
    );
    lines.push(
      `- cumulative writes calls=${formatCount(suite.terminalOutputTotals.totalCalls)} bytes=${formatCount(suite.terminalOutputTotals.totalBytes)} focused=${formatCount(suite.terminalOutputTotals.focusedBytes)} active-visible=${formatCount(suite.terminalOutputTotals.activeVisibleBytes)} visible-background=${formatCount(suite.terminalOutputTotals.visibleBackgroundBytes)} hidden=${formatCount(suite.terminalOutputTotals.hiddenBytes)} queued=${formatCount(suite.terminalOutputTotals.queuedBytes)} suppressed=${formatCount(suite.terminalOutputTotals.suppressedBytes)}`,
    );
    lines.push(
      `- per-frame writes p95 calls=${formatCount(suite.terminalOutputPerFrame.writeCallsP95)} direct-calls=${formatCount(suite.terminalOutputPerFrame.directWriteCallsP95)} queued-calls=${formatCount(suite.terminalOutputPerFrame.queuedWriteCallsP95)} bytes=${formatCount(suite.terminalOutputPerFrame.writeBytesP95)} direct-bytes=${formatCount(suite.terminalOutputPerFrame.directWriteBytesP95)} queued-bytes=${formatCount(suite.terminalOutputPerFrame.queuedWriteBytesP95)} focused-bytes=${formatCount(suite.terminalOutputPerFrame.focusedWriteBytesP95)} non-target-visible-bytes=${formatCount(suite.terminalOutputPerFrame.nonTargetVisibleBytesP95)} active-visible-bytes=${formatCount(suite.terminalOutputPerFrame.activeVisibleBytesP95)} visible-background-bytes=${formatCount(suite.terminalOutputPerFrame.visibleBackgroundBytesP95)} hidden-bytes=${formatCount(suite.terminalOutputPerFrame.hiddenBytesP95)} plain-bytes=${formatCount(suite.terminalOutputPerFrame.plainWriteBytesP95)} control-bytes=${formatCount(suite.terminalOutputPerFrame.controlWriteBytesP95)} redraw-control-bytes=${formatCount(suite.terminalOutputPerFrame.redrawControlWriteBytesP95)} suppressed-bytes=${formatCount(suite.terminalOutputPerFrame.suppressedBytesP95)}`,
    );
    lines.push(
      `- terminal-write duration p95 total=${formatMs(suite.terminalOutputPerFrame.writeDurationP95Ms)} focused=${formatMs(suite.terminalOutputPerFrame.focusedWriteDurationP95Ms)} active-visible=${formatMs(suite.terminalOutputPerFrame.activeVisibleWriteDurationP95Ms)} visible-background=${formatMs(suite.terminalOutputPerFrame.visibleBackgroundWriteDurationP95Ms)} queued=${formatMs(suite.terminalOutputPerFrame.queuedWriteDurationP95Ms)} plain=${formatMs(suite.terminalOutputPerFrame.plainWriteDurationP95Ms)} control=${formatMs(suite.terminalOutputPerFrame.controlWriteDurationP95Ms)} redraw-control=${formatMs(suite.terminalOutputPerFrame.redrawControlWriteDurationP95Ms)}`,
    );
    lines.push(
      `- terminal-write finalization p95 total=${formatMs(suite.terminalOutputPerFrame.writeFinalizationDurationP95Ms)} focused=${formatMs(suite.terminalOutputPerFrame.focusedWriteFinalizationDurationP95Ms)} active-visible=${formatMs(suite.terminalOutputPerFrame.activeVisibleWriteFinalizationDurationP95Ms)} visible-background=${formatMs(suite.terminalOutputPerFrame.visibleBackgroundWriteFinalizationDurationP95Ms)} queued=${formatMs(suite.terminalOutputPerFrame.queuedWriteFinalizationDurationP95Ms)}`,
    );
    lines.push(
      `- terminal-active writes p95 count=${formatCount(suite.terminalOutputPerFrame.activeWriteCountP95)}` +
        ` age=${formatMs(suite.terminalOutputPerFrame.activeWriteAgeP95Ms)}` +
        ` non-target-visible-count=${formatCount(suite.terminalOutputPerFrame.nonTargetVisibleActiveWriteCountP95)}` +
        ` non-target-visible-age=${formatMs(suite.terminalOutputPerFrame.nonTargetVisibleActiveWriteAgeP95Ms)}` +
        ` visible-background-count=${formatCount(suite.terminalOutputPerFrame.visibleBackgroundActiveWriteCountP95)}` +
        ` visible-background-age=${formatMs(suite.terminalOutputPerFrame.visibleBackgroundActiveWriteAgeP95Ms)}`,
    );
    lines.push(
      `- focused-input window active=${String(suite.focusedInput.active)} task=${suite.focusedInput.taskId ?? 'none'} age=${formatMs(suite.focusedInput.ageMs)} remaining=${formatMs(suite.focusedInput.remainingMs)} echo-reservation=${String(suite.focusedInput.echoReservationActive)} echo-remaining=${formatMs(suite.focusedInput.echoReservationRemainingMs)} focused-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.focusedWriteBytesP95)} active-visible-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.activeVisibleBytesP95)} non-target-visible-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleBytesP95)} visible-background-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundBytesP95)} hidden-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.hiddenBytesP95)} plain-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.plainWriteBytesP95)} control-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.controlWriteBytesP95)} redraw-control-bytes-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.redrawControlWriteBytesP95)} direct-calls-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.directWriteCallsP95)} queued-calls-p95=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.queuedWriteCallsP95)} write-duration-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.writeDurationP95Ms)} plain-write-duration-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.plainWriteDurationP95Ms)} control-write-duration-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.controlWriteDurationP95Ms)} redraw-control-write-duration-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.redrawControlWriteDurationP95Ms)} write-finalization-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.writeFinalizationDurationP95Ms)} non-target-visible-write-duration-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleWriteDurationP95Ms)} non-target-visible-write-finalization-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleWriteFinalizationDurationP95Ms)} visible-background-write-duration-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundWriteDurationP95Ms)} visible-background-write-finalization-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundWriteFinalizationDurationP95Ms)} active-visible-age-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.activeVisibleQueueAgeP95Ms)} visible-background-age-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundQueueAgeP95Ms)} queued-age-p95=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.queuedQueueAgeP95Ms)}`,
    );
    lines.push(
      `- focused-input active writes p95 count=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.activeWriteCountP95)}` +
        ` age=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.activeWriteAgeP95Ms)}` +
        ` non-target-visible-count=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleActiveWriteCountP95)}` +
        ` non-target-visible-age=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.nonTargetVisibleActiveWriteAgeP95Ms)}` +
        ` visible-background-count=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteCountP95)}` +
        ` visible-background-age=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteAgeP95Ms)}` +
        ` visible-background-started-before-input-count=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedBeforeInputCountP95)}` +
        ` visible-background-started-before-input-bytes=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedBeforeInputBytesP95)}` +
        ` visible-background-started-before-input-age=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedBeforeInputAgeP95Ms)}` +
        ` visible-background-started-during-input-count=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedDuringInputCountP95)}` +
        ` visible-background-started-during-input-bytes=${formatCount(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedDuringInputBytesP95)}` +
        ` visible-background-started-during-input-age=${formatMs(suite.terminalOutputDuringFocusedInputPerFrame.visibleBackgroundActiveWriteStartedDuringInputAgeP95Ms)}`,
    );
    lines.push(
      `- pacing visible-count=${formatCount(suite.pacing.visibleTerminalCount)} pressure=${suite.pacing.framePressureLevel} focused-lane-budget=${formatCount(suite.pacing.focusedLaneFrameBudgetBytes)} visible-lane-budget=${formatCount(suite.pacing.visibleLaneFrameBudgetBytes)} hidden-lane-budget=${formatCount(suite.pacing.hiddenLaneFrameBudgetBytes)} shared-visible-budget=${formatCount(suite.pacing.sharedNonTargetVisibleFrameBudgetBytes ?? 0)} switch-target-reserve=${formatCount(suite.pacing.switchTargetReserveBudgetBytes ?? 0)} switch-window=${String(suite.pacing.switchWindowActive)} dense-focused-input=${String(suite.pacing.denseFocusedInputProtectionActive)} focused-preemption=${String(suite.pacing.focusedPreemptionWindowActive)}`,
    );
    lines.push(
      `- queue age p95 focused=${formatMs(suite.terminalOutputPerFrame.focusedQueueAgeP95Ms)} active-visible=${formatMs(suite.terminalOutputPerFrame.activeVisibleQueueAgeP95Ms)} visible-background=${formatMs(suite.terminalOutputPerFrame.visibleBackgroundQueueAgeP95Ms)} visible=${formatMs(suite.terminalOutputPerFrame.visibleQueueAgeP95Ms)} hidden=${formatMs(suite.terminalOutputPerFrame.hiddenQueueAgeP95Ms)} queued=${formatMs(suite.terminalOutputPerFrame.queuedQueueAgeP95Ms)}`,
    );
    lines.push(
      `- terminal render p50=${formatMs(suite.terminalRender.p50Ms)} p95=${formatMs(suite.terminalRender.p95Ms)} max=${formatMs(suite.terminalRender.maxMs)} count=${formatCount(suite.terminalRender.count)}`,
    );
    lines.push(
      `- terminal input buffered p50=${formatMs(suite.terminalInput.buffered.p50Ms)} p95=${formatMs(suite.terminalInput.buffered.p95Ms)} max=${formatMs(suite.terminalInput.buffered.maxMs)} count=${formatCount(suite.terminalInput.buffered.count)} sent p50=${formatMs(suite.terminalInput.sent.p50Ms)} p95=${formatMs(suite.terminalInput.sent.p95Ms)} max=${formatMs(suite.terminalInput.sent.maxMs)} count=${formatCount(suite.terminalInput.sent.count)}`,
    );
    lines.push(
      `- terminal input split lease-wait p50=${formatMs(suite.terminalInput.leaseWait.p50Ms)} p95=${formatMs(suite.terminalInput.leaseWait.p95Ms)} max=${formatMs(suite.terminalInput.leaseWait.maxMs)} count=${formatCount(suite.terminalInput.leaseWait.count)} dispatched p50=${formatMs(suite.terminalInput.dispatched.p50Ms)} p95=${formatMs(suite.terminalInput.dispatched.p95Ms)} max=${formatMs(suite.terminalInput.dispatched.maxMs)} count=${formatCount(suite.terminalInput.dispatched.count)} command-result p50=${formatMs(suite.terminalInput.commandResultReceived.p50Ms)} p95=${formatMs(suite.terminalInput.commandResultReceived.p95Ms)} max=${formatMs(suite.terminalInput.commandResultReceived.maxMs)} count=${formatCount(suite.terminalInput.commandResultReceived.count)} accepted p50=${formatMs(suite.terminalInput.accepted.p50Ms)} p95=${formatMs(suite.terminalInput.accepted.p95Ms)} max=${formatMs(suite.terminalInput.accepted.maxMs)} count=${formatCount(suite.terminalInput.accepted.count)} accepted-settle p95=${formatMs(suite.terminalInput.acceptedSettled.p95Ms)} max=${formatMs(suite.terminalInput.acceptedSettled.maxMs)} count=${formatCount(suite.terminalInput.acceptedSettled.count)}`,
    );
    lines.push(
      `- renderer terminal-input buffered-chars-max=${formatCount(suite.rendererTerminalInput.bufferedCharsMax)} queued-chunks-max=${formatCount(suite.rendererTerminalInput.queuedChunksMax)} in-flight-max=${formatCount(suite.rendererTerminalInput.inFlightBatchesMax)} sent-batches=${formatCount(suite.rendererTerminalInput.sentBatches)} sent-batch-chars-max=${formatCount(suite.rendererTerminalInput.sentBatchCharsMax)} retry-schedules=${formatCount(suite.rendererTerminalInput.retrySchedules)} dropped-suffix=${formatCount(suite.rendererTerminalInput.droppedSuffixBatches)}`,
    );
    lines.push(
      `- browser control-client sends=${formatCount(suite.browserControlClient.sendAttempts)} nonzero-buffered-sends=${formatCount(suite.browserControlClient.nonZeroBufferedSendAttempts)} buffered-max=${formatCount(suite.browserControlClient.sendBufferedAmountMax)} post-buffered-max=${formatCount(suite.browserControlClient.postSendBufferedAmountMax)} send-duration-p95=${formatMs(suite.browserControlClient.sendDurationP95Ms)} ` +
        BROWSER_CONTROL_CLIENT_DETAIL_TYPES.map((type) =>
          formatBrowserControlClientTypeStats(suite.browserControlClient, type),
        ).join(' '),
    );
    lines.push(
      `- terminal flow-control pauses=${formatCount(suite.terminalFlowControl.pauseRequests)} resumes=${formatCount(suite.terminalFlowControl.resumeRequests)} avg-pause-window=${formatMs(suite.terminalFlowControl.avgPauseRequestWindowMs)}`,
    );
    lines.push(
      `- backend input trace completed=${formatCount(suite.backendInputTrace.completedCount)} active=${formatCount(suite.backendInputTrace.activeTraceCount)} dropped=${formatCount(suite.backendInputTrace.droppedTraces)} client-buffer-p95=${formatMs(suite.backendInputTrace.clientBufferP95Ms)} client-send-p95=${formatMs(suite.backendInputTrace.clientSendP95Ms)} server-queue-p95=${formatMs(suite.backendInputTrace.serverQueueP95Ms)} command-ack-p95=${formatMs(suite.backendInputTrace.commandAckP95Ms)} pty-write-to-command-ack-p95=${formatMs(suite.backendInputTrace.ptyWriteToCommandAckP95Ms)} pty-echo-p95=${formatMs(suite.backendInputTrace.ptyEchoP95Ms)} backend-output-buffer-p95=${formatMs(suite.backendInputTrace.backendOutputBufferP95Ms)} browser-delivery-p95=${formatMs(suite.backendInputTrace.browserDeliveryP95Ms)} browser-transport-delivery-p95=${formatMs(suite.backendInputTrace.browserTransportDeliveryP95Ms)} browser-channel-dispatch-p95=${formatMs(suite.backendInputTrace.browserChannelDispatchP95Ms)} transport-residual-p95=${formatMs(suite.backendInputTrace.transportResidualP95Ms)} render-p95=${formatMs(suite.backendInputTrace.renderP95Ms)} end-to-end-p95=${formatMs(suite.backendInputTrace.endToEndP95Ms)}`,
    );
    lines.push(
      `- backend pty-input enqueued=${formatCount(suite.backendPtyInput.enqueuedMessages)} flushes=${formatCount(suite.backendPtyInput.flushes)} coalesced=${formatCount(suite.backendPtyInput.coalescedMessages)} max-queued-chars=${formatCount(suite.backendPtyInput.maxQueuedChars)} write-failures=${formatCount(suite.backendPtyInput.writeFailures)} control-backpressure=${formatCount(suite.backendBrowserControl.backpressureRejects)} control-not-open=${formatCount(suite.backendBrowserControl.notOpenRejects)} control-send-errors=${formatCount(suite.backendBrowserControl.sendErrors)} control-delayed-depth=${formatCount(suite.backendBrowserControl.delayedQueueMaxDepth)} control-delayed-age=${formatMs(suite.backendBrowserControl.delayedQueueMaxAgeMs)}`,
      `- backend browser-control buffered-max=${formatCount(suite.backendBrowserControl.maxBufferedAmountBytes)} delayed-bytes=${formatCount(suite.backendBrowserControl.delayedQueueMaxBytes)}`,
    );
    lines.push(
      `- runtime-per-frame p95 owner=${formatMs(suite.runtimePerFrame.ownerP95Ms)} analysis=${formatMs(suite.runtimePerFrame.agentAnalysisP95Ms)} scan=${formatMs(suite.runtimePerFrame.schedulerScanP95Ms)} drain=${formatMs(suite.runtimePerFrame.schedulerDrainP95Ms)} active-webgl=${formatCount(suite.runtimePerFrame.activeWebglContextsP95)} visible-webgl=${formatCount(suite.runtimePerFrame.visibleWebglContextsP95)}`,
    );
    lines.push(
      `- terminal fit dirty=${formatCount(suite.terminalFit.dirtyMarks)} resize=${formatCount(suite.terminalFit.dirtyReasonCounts.resize)} intersection=${formatCount(suite.terminalFit.dirtyReasonCounts.intersection)} font-size=${formatCount(suite.terminalFit.dirtyReasonCounts['font-size'])} font-family=${formatCount(suite.terminalFit.dirtyReasonCounts['font-family'])} theme=${formatCount(suite.terminalFit.dirtyReasonCounts.theme)} flushes=${formatCount(suite.terminalFit.flushCalls)} idle-flushes=${formatCount(suite.terminalFit.idleFlushCalls)} lifecycle-fits=${formatCount(suite.terminalFit.executionCounts.lifecycle)} manager-fits=${formatCount(suite.terminalFit.executionCounts.manager)} session-immediate-fits=${formatCount(suite.terminalFit.executionCounts['session-immediate'])} session-raf-fits=${formatCount(suite.terminalFit.executionCounts['session-raf'])} geometry-change-fits=${formatCount(suite.terminalFit.geometryChangeFits)} noop-skips=${formatCount(suite.terminalFit.noopSkips)} schedules=${formatCount(suite.terminalFit.scheduleCalls)} startup=${formatCount(suite.terminalFit.scheduleReasonCounts.startup)} attach=${formatCount(suite.terminalFit.scheduleReasonCounts.attach)} spawn-ready=${formatCount(suite.terminalFit.scheduleReasonCounts['spawn-ready'])} restore=${formatCount(suite.terminalFit.scheduleReasonCounts.restore)} renderer-loss=${formatCount(suite.terminalFit.scheduleReasonCounts['renderer-loss'])} ready=${formatCount(suite.terminalFit.scheduleReasonCounts.ready)} visibility=${formatCount(suite.terminalFit.scheduleReasonCounts.visibility)}`,
    );
    lines.push(
      `- terminal renderer acquire-attempts=${formatCount(suite.terminalRenderer.acquireAttempts)} hits=${formatCount(suite.terminalRenderer.acquireHits)} misses=${formatCount(suite.terminalRenderer.acquireMisses)} evictions=${formatCount(suite.terminalRenderer.webglEvictions)} fallbacks=${formatCount(suite.terminalRenderer.fallbackActivations)} recoveries=${formatCount(suite.terminalRenderer.fallbackRecoveries)} releases=${formatCount(suite.terminalRenderer.explicitReleases)} active-max=${formatCount(suite.terminalRenderer.activeContextsMax)} visible-max=${formatCount(suite.terminalRenderer.visibleContextsMax)} attach-swaps=${formatCount(suite.terminalRenderer.rendererSwapCounts.attach)} restore-swaps=${formatCount(suite.terminalRenderer.rendererSwapCounts.restore)} selected-switch-swaps=${formatCount(suite.terminalRenderer.rendererSwapCounts['selected-switch'])}`,
    );
    lines.push(
      `${isHiddenWakeSuiteName(suite.profile) ? '- hidden-switch round-trip' : '- focused round-trip'} p50=${formatMs(suite.focusedRoundTrip.p50Ms)} p95=${formatMs(suite.focusedRoundTrip.p95Ms)} max=${formatMs(suite.focusedRoundTrip.maxMs)} count=${formatCount(suite.focusedRoundTrip.count)} attempted=${formatCount(suite.focusedRoundTrip.attemptedCount)} timeouts=${formatCount(suite.focusedRoundTrip.timeoutCount)} initially-ready=${String(suite.focusedRoundTrip.initiallyReady)}`,
    );
    if (!isHiddenWakeSuiteName(suite.profile)) {
      lines.push(
        `- focused round-trip split input-dispatch-p95=${formatMs(suite.focusedRoundTrip.inputDispatchP95Ms)} echo-after-dispatch-p95=${formatMs(suite.focusedRoundTrip.echoAfterDispatchP95Ms)} rendered-p95=${formatMs(suite.focusedRoundTrip.renderedP95Ms)} render-after-receive-p95=${formatMs(suite.focusedRoundTrip.renderAfterReceiveP95Ms)} rendered-timeouts=${formatCount(suite.focusedRoundTrip.renderedTimeoutCount)}`,
      );
    }
    if (suite.trace) {
      lines.push(
        `- trace main-thread slices=${formatCount(suite.trace.mainThreadSliceCount)} longtasks=${formatCount(suite.trace.mainThreadLongTasks.count)} total=${formatMs(suite.trace.mainThreadLongTasks.totalMs)} top=${suite.trace.topMainThreadSlices[0]?.name ?? 'n/a'}`,
      );
    }
    if (suite.switchWake) {
      lines.push(
        `- hidden switch first-paint=${formatMs(suite.switchWake.firstPaintMs)} input-ready=${formatMs(suite.switchWake.inputReadyMs)} round-trip=${formatMs(suite.switchWake.roundTripMs)} app-first-paint=${formatMs(suite.switchWake.appFirstPaintMs)} app-input-ready=${formatMs(suite.switchWake.appInputReadyMs)} app-switch=${formatMs(suite.switchWake.appSwitchDurationMs)} reason=${suite.switchWake.appSwitchReason ?? 'none'} measurement-failure=${suite.switchWake.failureReason ?? 'none'} restore=${formatMs(suite.switchWake.restoreTotalMs)} pause=${formatMs(suite.switchWake.pauseMs)} fetch=${formatMs(suite.switchWake.recoveryFetchMs)} apply=${formatMs(suite.switchWake.applyMs)} resume=${formatMs(suite.switchWake.resumeMs)} idle=${formatMs(suite.switchWake.waitForOutputIdleMs)} chunks=${formatCount(suite.switchWake.chunkCount)} later-replays=${formatCount(suite.switchWake.replayEntryCountAfterSwitch)} kind=${suite.switchWake.recoveryKind ?? 'none'} selected-recovery-active=${String(suite.switchWake.selectedRecoveryActive)} selected-recovery-protected=${String(suite.switchWake.selectedRecoveryProtected)} request-state-bytes=${formatCount(suite.switchWake.recoveryRequestStateBytes)} tier=${suite.switchWake.targetSurfaceTier ?? 'unknown'} dormant=${String(suite.switchWake.targetWasDormant)} render-hibernating=${String(suite.switchWake.targetWasRenderHibernating)} switch-target-bytes=${formatCount(suite.switchWake.switchTargetVisibleBytes)} visible-bg-bytes=${formatCount(suite.switchWake.visibleBackgroundBytes)} bytes=${formatCount(suite.switchWake.writtenBytes)}`,
      );
      lines.push(
        `- hidden switch phase samples first-paint pressure=${suite.switchWake.firstPaintFramePressureLevel ?? 'n/a'} focused-bytes=${formatCount(suite.switchWake.firstPaintFocusedBytes)} focused-queue=${formatMs(suite.switchWake.firstPaintFocusedQueueAgeMs)} hidden-bytes=${formatCount(suite.switchWake.firstPaintHiddenBytes)} hidden-queue=${formatMs(suite.switchWake.firstPaintHiddenQueueAgeMs)} non-target-visible-bytes=${formatCount(suite.switchWake.firstPaintNonTargetVisibleBytes)} switch-target-bytes=${formatCount(suite.switchWake.firstPaintSwitchTargetVisibleBytes)} input-ready pressure=${suite.switchWake.inputReadyFramePressureLevel ?? 'n/a'} focused-bytes=${formatCount(suite.switchWake.inputReadyFocusedBytes)} focused-queue=${formatMs(suite.switchWake.inputReadyFocusedQueueAgeMs)} hidden-bytes=${formatCount(suite.switchWake.inputReadyHiddenBytes)} hidden-queue=${formatMs(suite.switchWake.inputReadyHiddenQueueAgeMs)} non-target-visible-bytes=${formatCount(suite.switchWake.inputReadyNonTargetVisibleBytes)} switch-target-bytes=${formatCount(suite.switchWake.inputReadySwitchTargetVisibleBytes)}`,
      );
      lines.push(
        `- hidden switch post-input-ready echo delay=${formatMs(suite.switchWake.postInputReadyEchoDelayMs)} app-echo=${formatMs(suite.switchWake.appPostInputReadyEchoMs)} reason=${suite.switchWake.appPostInputReadyEchoReason ?? 'none'} pressure=${suite.switchWake.appPostInputReadyEchoFramePressureLevel ?? 'n/a'} focused-bytes=${formatCount(suite.switchWake.appPostInputReadyEchoFocusedBytes)} non-target-visible-bytes=${formatCount(suite.switchWake.appPostInputReadyEchoNonTargetVisibleBytes)} visible-background-bytes=${formatCount(suite.switchWake.appPostInputReadyEchoVisibleBackgroundBytes)} focused-queue=${formatMs(suite.switchWake.appPostInputReadyEchoFocusedQueueAgeMs)} visible-background-queue=${formatMs(suite.switchWake.appPostInputReadyEchoVisibleBackgroundQueueAgeMs)}`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function runSuiteAttempt(browser, options, suiteName) {
  const launchedServer = await maybeLaunchServer(options, suiteName);
  const serverUrl = launchedServer?.baseUrl ?? options.serverUrl;
  const authToken = launchedServer?.authToken ?? options.authToken;
  const client = createBrowserServerClient({
    authToken,
    serverUrl,
  });
  const viewport = getViewportSizeForVisibleTerminalCount(options.visibleTerminalCount);
  const context = await browser.newContext(viewport === null ? {} : { viewport });

  await context.addInitScript(
    ([
      displayNameStorageKey,
      clientIdStorageKey,
      injectedExperimentConfig,
      injectedHighLoadMode,
    ]) => {
      globalThis.localStorage.setItem(displayNameStorageKey, 'UI Fluidity Profiler');
      globalThis.sessionStorage.setItem(clientIdStorageKey, 'ui-fluidity-profiler-session');
      globalThis.window.__PARALLEL_CODE_UI_FLUIDITY_DIAGNOSTICS__ = true;
      globalThis.window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true;
      globalThis.window.__TERMINAL_OUTPUT_VISIBLE_LINE_DIAGNOSTICS__ = false;
      globalThis.window.__TERMINAL_PERF__ = true;
      globalThis.window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
      globalThis.window.__PARALLEL_CODE_TERMINAL_REPLAY_TRACE__ = [];
      if (injectedHighLoadMode === null) {
        delete globalThis.window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__;
      } else {
        globalThis.window.__PARALLEL_CODE_TERMINAL_HIGH_LOAD_MODE__ = injectedHighLoadMode;
      }
      if (injectedExperimentConfig === null) {
        delete globalThis.window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;
      } else {
        globalThis.window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = injectedExperimentConfig;
      }
    },
    [
      DISPLAY_NAME_STORAGE_KEY,
      CLIENT_ID_STORAGE_KEY,
      options.injectedExperimentConfig,
      options.injectedHighLoadMode,
    ],
  );

  let page;
  try {
    page = await openUiFluidityPage(context, suiteName, serverUrl, authToken);

    const terminalEntries =
      options.surface === 'agents'
        ? await waitForSeededAgentTerminals(page, launchedServer?.seededTasks ?? [])
        : (await createTerminals(page, options.terminals)).map((terminalIndex) => ({
            terminalIndex,
          }));
    const focusedTerminalIndex = terminalEntries[0]?.terminalIndex;
    if (focusedTerminalIndex === undefined) {
      throw new Error(
        options.surface === 'agents'
          ? 'Expected at least one seeded agent terminal'
          : 'Expected at least one created shell terminal',
      );
    }
    await alignViewportToVisibleTerminalCount(page, options.visibleTerminalCount);

    if (options.surface === 'agents') {
      await waitForSeededAgentsReady(
        client,
        terminalEntries,
        getSeededAgentReadyTimeoutMs(options),
      );
    } else {
      const workloadDurationMs = Math.max(options.durationMs * 3, options.durationMs + 8_000);
      await startTerminalWorkloads(
        page,
        client,
        terminalEntries.map((entry) => entry.terminalIndex),
        suiteName,
        workloadDurationMs,
      );
    }
    const initialRoundTripReady = await waitForRoundTripReady(page, focusedTerminalIndex);

    if (options.surface === 'agents') {
      await launchedServer?.releaseWorkloads?.();
      if (suiteName !== 'hidden_render_wake') {
        await waitForTerminalOutputActivity(page, 8);
      }
    }
    let preparedHiddenSwitchTarget = null;
    if (
      suiteName === 'recent_hidden_switch' ||
      suiteName === 'hidden_render_wake' ||
      suiteName === 'hidden_session_wake'
    ) {
      preparedHiddenSwitchTarget = await waitForHiddenWakePreconditions(
        page,
        options,
        suiteName,
        terminalEntries,
      );
    } else {
      await page.waitForTimeout(WORKLOAD_WARMUP_MS);
    }

    if (isActiveVisibleSelectedSuiteName(suiteName)) {
      if (options.surface !== 'agents') {
        throw new Error('The active_visible_selected suite only supports the agents surface');
      }

      const activeVisibleTargetTaskId = terminalEntries[0]?.taskId;
      if (typeof activeVisibleTargetTaskId !== 'string' || activeVisibleTargetTaskId.length === 0) {
        throw new Error('Expected the active-visible suite to have a selected task target');
      }

      await prepareActiveVisibleSelectedTask(page, activeVisibleTargetTaskId);
      await waitForActiveVisibleOutputActivity(page);
    }

    const inputProbeCount = getInputProbeCount(options, suiteName);
    let inputProbeSummary;
    let switchSummary = null;
    let traceSummary = null;
    const measureWindow = async () => {
      const nextInputProbeSummary = await runFocusedInputProbes(
        page,
        focusedTerminalIndex,
        options.durationMs,
        inputProbeCount,
        options.inputIntervalMs,
      );
      if (nextInputProbeSummary.elapsedMs < options.durationMs) {
        await page.waitForTimeout(options.durationMs - nextInputProbeSummary.elapsedMs);
      }
      await waitForAnimationFrames(page, 2);
      inputProbeSummary = nextInputProbeSummary;
      return nextInputProbeSummary;
    };
    const measureHiddenSwitch = async () => {
      if (options.surface !== 'agents') {
        throw new Error('Hidden wake suites only support the agents surface');
      }

      const targetEntry =
        preparedHiddenSwitchTarget ??
        (suiteName === 'hidden_switch'
          ? await waitForHiddenWakePreconditions(page, options, suiteName, terminalEntries)
          : null);
      if (!targetEntry?.taskId) {
        throw new Error('Failed to select a hidden task switch target');
      }

      const nextSwitchSummary = await measureHiddenTaskSwitch(
        page,
        options.experimentConfig,
        targetEntry.taskId,
        targetEntry.agentId,
      );
      switchSummary = {
        ...nextSwitchSummary,
        targetTaskId: targetEntry.taskId,
      };
      inputProbeSummary = {
        attemptedCount: 1,
        echoAfterDispatch: createEmptyDurationSummary(),
        elapsedMs: Math.round(nextSwitchSummary.inputReadyMs),
        inputDispatch: createEmptyDurationSummary(),
        timeoutCount: nextSwitchSummary.roundTripMs < 0 ? 1 : 0,
      };
      await waitForAnimationFrames(page, 2);
      return nextSwitchSummary;
    };

    await resetMeasuredDiagnostics(page, client);

    if (shouldCaptureTraceForSuite(options, suiteName)) {
      const traceResult = await captureBrowserPerformanceTrace(
        page,
        path.join(options.outDir, `${suiteName}.trace.json`),
        isHiddenWakeSuiteName(suiteName) ? measureHiddenSwitch : measureWindow,
      );
      traceSummary = traceResult.traceSummary;
    } else if (isHiddenWakeSuiteName(suiteName)) {
      await measureHiddenSwitch();
    } else {
      await measureWindow();
    }

    const [backendDiagnosticsSnapshot, terminalLatencySnapshot, uiSnapshot] = await Promise.all([
      collectBackendRuntimeDiagnostics(client),
      page.evaluate(() => globalThis.window.__parallelCodeTerminalLatency?.getSnapshot() ?? null),
      collectUiFluiditySnapshot(page),
    ]);

    if (!backendDiagnosticsSnapshot || !terminalLatencySnapshot || !uiSnapshot) {
      throw new Error('UI fluidity diagnostics snapshots were not available');
    }

    return {
      backendDiagnosticsSnapshot,
      initialRoundTripReady,
      inputProbeSummary,
      switchSummary,
      suiteName,
      terminalLatencySnapshot,
      traceSummary,
      uiSnapshot,
    };
  } finally {
    await page?.close().catch(() => {});
    await context.close().catch(() => {});
    await launchedServer?.stop().catch(() => {});
  }
}

async function runSuite(browser, options, suiteName) {
  const maxAttempts = options.launchServer ? SUITE_BOOTSTRAP_RETRY_LIMIT : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runSuiteAttempt(browser, options, suiteName);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableSuiteBootstrapError(error)) {
        throw error;
      }

      console.warn(
        `[ui-fluidity] retrying ${suiteName} suite bootstrap (${attempt}/${maxAttempts}) after startup failure: ${getErrorMessage(error)}`,
      );
    }
  }

  throw lastError ?? new Error(`Failed to run ${suiteName} UI fluidity suite`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  try {
    const suiteSummaries = [];
    for (const suiteName of options.profiles) {
      if (!SUITE_DEFINITIONS[suiteName]) {
        throw new Error(`Unknown suite profile: ${suiteName}`);
      }

      const suiteResult = await runSuite(browser, options, suiteName);
      const suiteSummary = createSuiteSummary(suiteName, suiteResult);
      suiteSummaries.push(suiteSummary);

      await writeFile(
        path.join(options.outDir, `${suiteName}.json`),
        JSON.stringify(suiteResult, null, 2),
        'utf8',
      );
      const roundTripLabel = isHiddenWakeSuiteName(suiteName)
        ? 'hidden-switch roundtrip'
        : 'roundtrip';
      console.log(
        `[ui-fluidity] ${suiteName} frame-gap p95=${formatMs(suiteSummary.frameGap.p95Ms)} longtask total=${formatMs(suiteSummary.longTasks.totalDurationMs)} ${roundTripLabel} p95=${formatMs(suiteSummary.focusedRoundTrip.p95Ms)}`,
      );
    }

    const runSummary = {
      generatedAt: new Date().toISOString(),
      options,
      suites: suiteSummaries,
    };
    await writeFile(
      path.join(options.outDir, 'summary.json'),
      JSON.stringify(runSummary, null, 2),
      'utf8',
    );
    await writeFile(
      path.join(options.outDir, 'summary.md'),
      createMarkdownSummary(runSummary),
      'utf8',
    );
    console.log(`[ui-fluidity] wrote artifacts to ${options.outDir}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
