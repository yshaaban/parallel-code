import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { chromium } from '@playwright/test';

import { createBrowserServerClient } from './browser-server-client.mjs';

const GET_BACKEND_RUNTIME_DIAGNOSTICS = 'get_backend_runtime_diagnostics';
const RESET_BACKEND_RUNTIME_DIAGNOSTICS = 'reset_backend_runtime_diagnostics';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:43117';
const DEFAULT_AUTH_TOKEN = 'parallel-code-local-browser';
const CLIENT_ID_STORAGE_KEY = 'parallel-code-client-id';
const DISPLAY_NAME_STORAGE_KEY = 'parallel-code-display-name';
const BUILD_METADATA_PATH = '/build-metadata.json';
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';
const TERMINAL_READY_SELECTOR = '.xterm-helper-textarea, .xterm textarea';
const BACKGROUND_NOISE_COMMAND = 'node scripts/fixtures/tui-statusline.mjs 1500 10';
const APP_SHELL_SELECTOR = '.app-shell';
const CLEAR_LINE_SETTLE_MS = 100;
const NOISE_START_SETTLE_MS = 250;
const NOISE_STOP_SETTLE_MS = 150;
const PROFILE_TERMINAL_OPEN_SHORTCUT = 'Control+Shift+D';
const SERVER_START_TIMEOUT_MS = 20_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const TERMINAL_ATTACH_TIMEOUT_MS = 10_000;
const TERMINAL_READY_TIMEOUT_MS = 20_000;
const TRACE_POLL_INTERVAL_MS = 100;
const TRACE_READY_TIMEOUT_BUFFER_MS = 3_000;
const TRACE_RESULT_TIMEOUT_BUFFER_MS = 2_000;
const API_RTT_SAMPLE_COUNT = 12;
const API_RTT_SAMPLE_DELAY_MS = 80;
const VISUAL_ECHO_TIMEOUT_MS = 10_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STANDALONE_SERVER_ENTRY = path.resolve(__dirname, '..', 'dist-server', 'server', 'main.js');

function parseArgs(argv) {
  const options = {
    authToken: process.env.AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN,
    keepServer: false,
    keepProfileTerminal: false,
    launchServer: false,
    serverUrl: process.env.SERVER_URL ?? DEFAULT_SERVER_URL,
    settleMs: Number.parseInt(process.env.TERMINAL_TRACE_SETTLE_MS ?? '3000', 10),
    skipTrace: false,
    skipVisualEcho: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--server-url') {
      options.serverUrl = argv[index + 1] ?? options.serverUrl;
      index += 1;
      continue;
    }

    if (arg === '--auth-token') {
      options.authToken = argv[index + 1] ?? options.authToken;
      index += 1;
      continue;
    }

    if (arg === '--keep-server') {
      options.keepServer = true;
      continue;
    }

    if (arg === '--keep-profile-terminal') {
      options.keepProfileTerminal = true;
      continue;
    }

    if (arg === '--launch-server') {
      options.launchServer = true;
      continue;
    }

    if (arg === '--skip-trace') {
      options.skipTrace = true;
      continue;
    }

    if (arg === '--skip-visual-echo') {
      options.skipVisualEcho = true;
      continue;
    }

    if (arg === '--settle-ms') {
      options.settleMs = Number.parseInt(argv[index + 1] ?? String(options.settleMs), 10);
      index += 1;
    }
  }

  return options;
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  return `${value.toFixed(2)}ms`;
}

function summarizeSamples(samples) {
  if (samples.length === 0) {
    return {
      count: 0,
      max: 0,
      min: 0,
      p50: 0,
      p95: 0,
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);

  function percentile(fraction) {
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction));
    return sorted[index];
  }

  return {
    count: sorted.length,
    max: sorted[sorted.length - 1],
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function describeRttSummary(summary) {
  return [
    `count=${summary.count}`,
    `p50=${formatMs(summary.p50)}`,
    `p95=${formatMs(summary.p95)}`,
    `min=${formatMs(summary.min)}`,
    `max=${formatMs(summary.max)}`,
  ].join(' | ');
}

function describeSummary(summary) {
  return [
    `count=${summary.count}`,
    `e2e p50=${formatMs(summary.endToEndMs.p50)} p95=${formatMs(summary.endToEndMs.p95)}`,
    `buffer p50=${formatMs(summary.clientBufferMs.p50)}`,
    `send p50=${formatMs(summary.clientSendMs.p50)}`,
    `send->echo p50=${formatMs(summary.sendToEchoMs.p50)}`,
    `server queue p50=${formatMs(summary.serverQueueMs.p50)}`,
    `pty echo p50=${formatMs(summary.ptyEchoMs.p50)}`,
    `backend output buffer p50=${formatMs(summary.backendOutputBufferMs.p50)}`,
    `browser delivery p50=${formatMs(summary.browserDeliveryMs.p50)}`,
    `browser transport delivery p50=${formatMs(summary.browserTransportDeliveryMs.p50)}`,
    `browser channel dispatch p50=${formatMs(summary.browserChannelDispatchMs.p50)}`,
    `transport residual p50=${formatMs(summary.transportResidualMs.p50)}`,
    `render p50=${formatMs(summary.renderMs.p50)}`,
  ].join(' | ');
}

function getTraceDuration(sample, startKey, endKey) {
  const start = sample.stages[startKey];
  const end = sample.stages[endKey];
  if (start === null || end === null) {
    return null;
  }

  return Math.max(0, end - start);
}

function getTerminalStatusLocator(page, terminalIndex) {
  return page.locator(TERMINAL_STATUS_SELECTOR).nth(terminalIndex);
}

function getTerminalReadyLocator(page, terminalIndex) {
  return getTerminalStatusLocator(page, terminalIndex).locator(TERMINAL_READY_SELECTOR).first();
}

async function waitForTerminalStatus(page, terminalIndex, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const statusRoot = getTerminalStatusLocator(page, terminalIndex);
  while (Date.now() < deadline) {
    const status = await statusRoot.getAttribute('data-terminal-status').catch(() => null);
    if (status === expectedStatus) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, TRACE_POLL_INTERVAL_MS));
  }

  const status = await statusRoot.getAttribute('data-terminal-status').catch(() => null);
  throw new Error(
    `Timed out waiting for terminal ${terminalIndex} to reach ${expectedStatus}; last status=${status ?? 'missing'}`,
  );
}

async function readTerminalStatusSnapshot(page) {
  return page.locator(TERMINAL_STATUS_SELECTOR).evaluateAll((elements) =>
    elements.map((element, index) => ({
      agentId: element.getAttribute('data-terminal-agent-id'),
      index,
      paintReady: element.getAttribute('data-terminal-paint-ready') === 'true',
      status: element.getAttribute('data-terminal-status'),
      textTail: (element.textContent ?? '').replace(/\s+/gu, ' ').slice(-240),
    })),
  );
}

function printSlowSamples(snapshot) {
  const sorted = [...snapshot.completedTraces]
    .filter((sample) => sample.completed)
    .sort((left, right) => {
      const leftDuration = getTraceDuration(left, 'startedAtMs', 'outputRenderedAtMs') ?? 0;
      const rightDuration = getTraceDuration(right, 'startedAtMs', 'outputRenderedAtMs') ?? 0;
      return rightDuration - leftDuration;
    })
    .slice(0, 5);

  if (sorted.length === 0) {
    console.log(
      `  no completed traces recorded (active=${snapshot.activeTraceCount} dropped=${snapshot.droppedTraces})`,
    );
    return;
  }

  for (const sample of sorted) {
    const endToEndMs = getTraceDuration(sample, 'startedAtMs', 'outputRenderedAtMs');
    const clientBufferMs = getTraceDuration(sample, 'startedAtMs', 'bufferedAtMs');
    const clientSendMs = getTraceDuration(sample, 'bufferedAtMs', 'sendStartedAtMs');
    const sendToEchoMs = getTraceDuration(sample, 'sendStartedAtMs', 'outputReceivedAtMs');
    const serverQueueMs = getTraceDuration(sample, 'serverReceivedAtMs', 'ptyWrittenAtMs');
    const ptyEchoMs = getTraceDuration(sample, 'ptyWrittenAtMs', 'ptyOutputReceivedAtMs');
    const backendOutputBufferMs = getTraceDuration(
      sample,
      'ptyOutputReceivedAtMs',
      'backendOutputFlushedAtMs',
    );
    const browserDeliveryMs = getTraceDuration(
      sample,
      'backendOutputFlushedAtMs',
      'outputReceivedAtMs',
    );
    const browserTransportDeliveryMs = getTraceDuration(
      sample,
      'backendOutputFlushedAtMs',
      'outputTransportReceivedAtMs',
    );
    const browserChannelDispatchMs = getTraceDuration(
      sample,
      'outputTransportReceivedAtMs',
      'outputReceivedAtMs',
    );
    const renderMs = getTraceDuration(sample, 'outputReceivedAtMs', 'outputRenderedAtMs');
    const transportResidualMs =
      sendToEchoMs !== null && serverQueueMs !== null
        ? Math.max(0, sendToEchoMs - serverQueueMs)
        : null;
    console.log(
      `  ${sample.requestId} ${sample.inputKind} chars=${sample.inputChars} e2e=${formatMs(endToEndMs ?? NaN)} ` +
        `buffer=${formatMs(clientBufferMs ?? NaN)} send=${formatMs(clientSendMs ?? NaN)} ` +
        `send->echo=${formatMs(sendToEchoMs ?? NaN)} server-queue=${formatMs(serverQueueMs ?? NaN)} ` +
        `pty-echo=${formatMs(ptyEchoMs ?? NaN)} backend-output-buffer=${formatMs(backendOutputBufferMs ?? NaN)} ` +
        `browser-delivery=${formatMs(browserDeliveryMs ?? NaN)} ` +
        `browser-transport-delivery=${formatMs(browserTransportDeliveryMs ?? NaN)} ` +
        `browser-channel-dispatch=${formatMs(browserChannelDispatchMs ?? NaN)} ` +
        `transport-residual=${formatMs(transportResidualMs ?? NaN)} ` +
        `render=${formatMs(renderMs ?? NaN)} preview=${JSON.stringify(sample.inputPreview)}`,
    );
  }
}

async function getTerminalInputTracingSnapshot(client) {
  const diagnostics = await client.invokeIpc(GET_BACKEND_RUNTIME_DIAGNOSTICS);
  return diagnostics.terminalInputTracing;
}

async function fetchBuildMetadata(client) {
  const url = new URL(client.baseUrl);
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  url.pathname = `${basePath}${BUILD_METADATA_PATH}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${client.authToken}`,
    },
  });

  if (!response.ok) {
    return {
      error: `metadata request failed with ${response.status}`,
    };
  }

  return response.json().catch(() => ({ error: 'metadata response was not valid JSON' }));
}

async function measureApiRtt(client) {
  const samples = [];
  for (let index = 0; index < API_RTT_SAMPLE_COUNT; index += 1) {
    const startedAtMs = globalThis.performance.now();
    await client.invokeIpc(GET_BACKEND_RUNTIME_DIAGNOSTICS);
    samples.push(globalThis.performance.now() - startedAtMs);
    await new Promise((resolve) => setTimeout(resolve, API_RTT_SAMPLE_DELAY_MS));
  }

  return {
    samples,
    summary: summarizeSamples(samples),
  };
}

function getCompletedTraceCount(snapshot) {
  return snapshot.completedTraces.filter((sample) => sample.completed).length;
}

async function waitForCompletedTraces(client, minimumCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getTerminalInputTracingSnapshot(client);
    const completedCount = getCompletedTraceCount(snapshot);
    if (completedCount >= minimumCount) {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, TRACE_POLL_INTERVAL_MS));
  }

  return getTerminalInputTracingSnapshot(client);
}

async function waitForTracingReady(page, client, terminalIndex, settleMs) {
  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('x');
  const snapshot = await waitForCompletedTraces(
    client,
    1,
    settleMs + TRACE_READY_TIMEOUT_BUFFER_MS,
  );

  if (snapshot.summary.count < 1) {
    throw new Error(
      `Terminal input tracing never became ready (completed=${snapshot.summary.count} active=${snapshot.activeTraceCount} dropped=${snapshot.droppedTraces})`,
    );
  }

  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
}

async function createProfileTerminal(page) {
  const terminalCount = await page.locator(TERMINAL_STATUS_SELECTOR).count();
  const openTerminalButton = page.locator('button[title*="Open terminal"]').first();
  if ((await openTerminalButton.count()) > 0) {
    await openTerminalButton.scrollIntoViewIfNeeded();
    await openTerminalButton.click();
  } else {
    await page.locator(APP_SHELL_SELECTOR).click({
      force: true,
      position: { x: 12, y: 12 },
    });
    await page.keyboard.press(PROFILE_TERMINAL_OPEN_SHORTCUT);
  }

  const statusRoot = getTerminalStatusLocator(page, terminalCount);
  await statusRoot.waitFor({
    state: 'attached',
    timeout: TERMINAL_ATTACH_TIMEOUT_MS,
  });
  await getTerminalReadyLocator(page, terminalCount).waitFor({
    state: 'attached',
    timeout: TERMINAL_ATTACH_TIMEOUT_MS,
  });
  await waitForTerminalStatus(page, terminalCount, 'ready', TERMINAL_READY_TIMEOUT_MS);
  return terminalCount;
}

async function focusTerminal(page, terminalIndex) {
  const statusRoot = getTerminalStatusLocator(page, terminalIndex);
  await statusRoot.scrollIntoViewIfNeeded();
  await statusRoot.click({
    force: true,
    position: { x: 24, y: 24 },
  });
  await getTerminalReadyLocator(page, terminalIndex).focus();
}

async function clearTerminalLine(page, terminalIndex) {
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('Control+U');
  await page.waitForTimeout(CLEAR_LINE_SETTLE_MS);
}

async function startBackgroundNoise(page) {
  const terminalIndex = await createProfileTerminal(page);
  await focusTerminal(page, terminalIndex);
  await page.keyboard.type(BACKGROUND_NOISE_COMMAND);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(NOISE_START_SETTLE_MS);
  return terminalIndex;
}

async function stopBackgroundNoise(page, terminalIndex) {
  await focusTerminal(page, terminalIndex);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(NOISE_STOP_SETTLE_MS);
}

async function runPattern(page, client, terminalIndex, pattern, settleMs) {
  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
  await focusTerminal(page, terminalIndex);
  await pattern.run(page);
  await page.waitForTimeout(settleMs);
  return waitForCompletedTraces(
    client,
    pattern.minimumTraces ?? 1,
    settleMs + TRACE_RESULT_TIMEOUT_BUFFER_MS,
  );
}

function createVisualMarker(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

async function waitForTerminalText(page, terminalIndex, marker) {
  return page.evaluate(
    ({ marker: expectedMarker, terminalIndex: index, timeoutMs }) =>
      new Promise((resolve) => {
        const statusRoot = globalThis.document.querySelectorAll('[data-terminal-status]')[index];
        const startedAtMs = globalThis.performance.now();
        let latestTail = '';

        function readTail() {
          latestTail = (statusRoot?.textContent ?? '').slice(-600);
          return latestTail;
        }

        function cleanup() {
          observer.disconnect();
          globalThis.clearTimeout(timeout);
        }

        function complete(seen, seenAtMs) {
          cleanup();
          resolve({
            elapsedMs: seenAtMs === null ? null : seenAtMs - startedAtMs,
            seen,
            seenAtMs,
            startedAtMs,
            textTail: latestTail,
          });
        }

        function check() {
          if (readTail().includes(expectedMarker)) {
            complete(true, globalThis.performance.now());
            return true;
          }

          return false;
        }

        const observer = new globalThis.MutationObserver(() => {
          check();
        });
        const timeout = globalThis.setTimeout(() => {
          readTail();
          complete(false, null);
        }, timeoutMs);

        if (statusRoot) {
          observer.observe(statusRoot, {
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
        check();
      }),
    { marker, terminalIndex, timeoutMs: VISUAL_ECHO_TIMEOUT_MS },
  );
}

async function runVisualPattern(page, client, terminalIndex, pattern) {
  await clearTerminalLine(page, terminalIndex);
  await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS);
  await focusTerminal(page, terminalIndex);

  const marker = pattern.createMarker();
  const waitForMarker = waitForTerminalText(page, terminalIndex, marker);
  const inputStartedAtMs = globalThis.performance.now();
  await pattern.run(page, marker);
  const inputSubmittedMs = globalThis.performance.now() - inputStartedAtMs;
  const visualEcho = await waitForMarker;
  const snapshot = await getTerminalInputTracingSnapshot(client);

  return {
    inputSubmittedMs,
    markerLength: marker.length,
    name: pattern.name,
    traceActive: snapshot.activeTraceCount,
    traceCompleted: snapshot.summary.count,
    traceDropped: snapshot.droppedTraces,
    visualEcho,
  };
}

const PATTERNS = [
  {
    name: 'single-key',
    async run(page) {
      await page.keyboard.press('x');
    },
  },
  {
    name: 'rapid-word',
    minimumTraces: 1,
    async run(page) {
      await page.keyboard.type('latencyprobe');
    },
  },
  {
    name: 'repeat-key-burst',
    minimumTraces: 1,
    async run(page) {
      for (let index = 0; index < 16; index += 1) {
        await page.keyboard.press('a');
      }
    },
  },
  {
    name: 'repeat-key-held',
    minimumTraces: 1,
    async run(page) {
      await page.keyboard.down('a');
      for (let index = 1; index < 16; index += 1) {
        await page.waitForTimeout(16);
        await page.keyboard.down('a');
      }
      await page.keyboard.up('a');
    },
  },
  {
    name: 'paste-burst',
    minimumTraces: 1,
    async run(page) {
      await page.keyboard.insertText(`PASTE_${'XYZ123'.repeat(32)}`);
    },
  },
];

const VISUAL_PATTERNS = [
  {
    createMarker: () => createVisualMarker('single_insert'),
    name: 'visual-single-insert',
    async run(page, marker) {
      await page.keyboard.insertText(marker);
    },
  },
  {
    createMarker: () => createVisualMarker('rapid_word'),
    name: 'visual-rapid-word',
    async run(page, marker) {
      await page.keyboard.type(marker);
    },
  },
  {
    createMarker: () => `visual${randomBytes(8).toString('hex')}`,
    name: 'visual-press-sequence',
    async run(page, marker) {
      for (const char of marker) {
        await page.keyboard.press(char);
      }
    },
  },
];

const SUITES = [
  {
    name: 'quiet',
  },
  {
    backgroundNoise: true,
    name: 'background-noise',
  },
];

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to reserve a localhost port for terminal profiling'));
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

function waitForServerReady(serverProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the standalone server to start'));
    }, SERVER_START_TIMEOUT_MS);

    function cleanup() {
      globalThis.clearTimeout(timeout);
      serverProcess.stdout.off('data', handleStdout);
      serverProcess.stderr.off('data', handleStderr);
      serverProcess.off('exit', handleExit);
    }

    function handleStdout(chunk) {
      const text = chunk.toString();
      if (text.includes('Parallel Code server listening on')) {
        cleanup();
        resolve();
      }
    }

    function handleStderr(chunk) {
      const text = chunk.toString();
      if (text.trim().length > 0) {
        process.stderr.write(text);
      }
    }

    function handleExit(code) {
      cleanup();
      reject(new Error(`Standalone server exited early with code ${code ?? 'null'}`));
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

async function maybeLaunchServer(options) {
  if (!options.launchServer) {
    return null;
  }

  const port = await reservePort();
  const authToken = `terminal-profiler-${randomBytes(12).toString('hex')}`;
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'parallel-code-terminal-profiler-'));
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
    await waitForServerReady(serverProcess);
  } catch (error) {
    await stopServerProcess(serverProcess).catch(() => {});
    await rm(userDataPath, { force: true, recursive: true }).catch(() => {});
    throw error;
  }

  return {
    authToken,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      if (options.keepServer) {
        console.log(`Keeping standalone server alive at http://127.0.0.1:${port}`);
        return;
      }

      await stopServerProcess(serverProcess);
      await rm(userDataPath, { force: true, recursive: true });
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const launchedServer = await maybeLaunchServer(options);
  const serverUrl = launchedServer?.baseUrl ?? options.serverUrl;
  const authToken = launchedServer?.authToken ?? options.authToken;
  const client = createBrowserServerClient({
    authToken,
    serverUrl,
  });
  let browser;
  let context;
  let page;
  let profileTerminalAgentId = null;
  try {
    const buildMetadata = await fetchBuildMetadata(client);
    console.log(`[build] ${JSON.stringify(buildMetadata)}`);
    const apiRtt = await measureApiRtt(client);
    console.log(`[api-rtt] ${describeRttSummary(apiRtt.summary)}`);

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.addInitScript(
      ([displayNameStorageKey, clientIdStorageKey]) => {
        globalThis.localStorage.setItem(displayNameStorageKey, 'Latency Profiler');
        globalThis.sessionStorage.setItem(clientIdStorageKey, 'latency-profiler-session');
      },
      [DISPLAY_NAME_STORAGE_KEY, CLIENT_ID_STORAGE_KEY],
    );
    page = await context.newPage();
    const authedUrl = new URL('/', serverUrl);
    authedUrl.searchParams.set('token', authToken);
    console.log(`Opening ${authedUrl.toString()}`);
    await page.goto(authedUrl.toString());
    await page.locator(APP_SHELL_SELECTOR).waitFor({ state: 'visible' });
    const profileTerminalIndex = await createProfileTerminal(page);
    const terminalStatuses = await readTerminalStatusSnapshot(page);
    profileTerminalAgentId = terminalStatuses[profileTerminalIndex]?.agentId ?? null;
    console.log(
      `[terminal] profile index=${profileTerminalIndex} agent=${profileTerminalAgentId ?? 'unknown'}`,
    );

    let traceReady = false;
    if (!options.skipTrace) {
      try {
        await waitForTracingReady(page, client, profileTerminalIndex, options.settleMs);
        traceReady = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[trace] disabled: ${message}`);
        await client.invokeIpc(RESET_BACKEND_RUNTIME_DIAGNOSTICS).catch(() => {});
      }
    }

    if (!options.skipVisualEcho) {
      console.log(`\n[suite] visual-echo`);
      for (const pattern of VISUAL_PATTERNS) {
        console.log(`\n[pattern] ${pattern.name}`);
        const result = await runVisualPattern(page, client, profileTerminalIndex, pattern);
        console.log(
          `  marker chars=${result.markerLength} submitted=${formatMs(result.inputSubmittedMs)} ` +
            `visual=${formatMs(result.visualEcho.elapsedMs ?? NaN)} seen=${result.visualEcho.seen} ` +
            `trace-completed=${result.traceCompleted} trace-active=${result.traceActive} ` +
            `trace-dropped=${result.traceDropped}`,
        );
        if (!result.visualEcho.seen) {
          console.log(`  tail=${JSON.stringify(result.visualEcho.textTail)}`);
        }
      }
    }

    if (traceReady) {
      for (const suite of SUITES) {
        console.log(`\n[suite] ${suite.name}`);
        let noiseTerminalIndex = null;
        if (suite.backgroundNoise) {
          noiseTerminalIndex = await startBackgroundNoise(page);
        }

        try {
          for (const pattern of PATTERNS) {
            console.log(`\n[pattern] ${pattern.name}`);
            const snapshot = await runPattern(
              page,
              client,
              profileTerminalIndex,
              pattern,
              options.settleMs,
            );
            console.log(`  ${describeSummary(snapshot.summary)}`);
            printSlowSamples(snapshot);
          }
        } finally {
          if (noiseTerminalIndex !== null) {
            await stopBackgroundNoise(page, noiseTerminalIndex);
          }
        }
      }
    }
  } finally {
    if (profileTerminalAgentId && !options.keepProfileTerminal) {
      await client.invokeIpc('kill_agent', { agentId: profileTerminalAgentId }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[cleanup] failed to kill profile terminal ${profileTerminalAgentId}: ${message}`,
        );
      });
    }
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await launchedServer?.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
