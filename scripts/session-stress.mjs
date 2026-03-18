import { randomUUID } from 'crypto';
import { execSync, spawn } from 'child_process';
import { Buffer } from 'buffer';
import fs from 'fs/promises';
import { createServer } from 'net';
import os from 'os';
import { performance } from 'perf_hooks';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { createBrowserServerClient } from './browser-server-client.mjs';
import {
  evaluateSessionStressProfile,
  getSessionStressProfile,
  getSessionStressProfileNames,
  mergeSessionStressOptions,
} from './session-stress-profiles.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.resolve(ROOT_DIR, 'dist-server', 'server', 'main.js');
const DEFAULT_TOKEN = `stress-token-${Date.now()}`;
const SYNTHETIC_TUI_AGENT_COMMAND = process.env.SESSION_STRESS_NODE_COMMAND ?? 'node';
const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;
const MAX_CLIENT_INPUT_DATA_LENGTH = 64 * 1024;
const STRESS_CONTROL_PREFIX = '__SESSION_STRESS_CTL__';
const SYNTHETIC_TUI_AGENT_SOURCE = String.raw`
const controlPrefix = '__SESSION_STRESS_CTL__';
const readyMarker = process.env.STRESS_READY_MARKER || '';
let stdinBuffer = '';
let outputInFlight = false;

process.stdin.setEncoding('utf8');

if (readyMarker) {
  process.stdout.write(readyMarker + '\n');
}

process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  flushBuffer();
});

process.stdin.resume();

function flushBuffer() {
  let newlineIndex = stdinBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    handleLine(line);
    newlineIndex = stdinBuffer.indexOf('\n');
  }
}

function handleLine(line) {
  if (line.startsWith(controlPrefix)) {
    handleControl(line.slice(controlPrefix.length));
    return;
  }

  process.stdout.write(line + '\n');
}

function handleControl(serializedCommand) {
  let command;
  try {
    command = JSON.parse(serializedCommand);
  } catch {
    return;
  }

  if (command?.type === 'start-output') {
    startOutput(command);
  }
}

function startOutput(command) {
  if (outputInFlight) {
    return;
  }

  outputInFlight = true;
  const doneMarker = typeof command.doneMarker === 'string' ? command.doneMarker : '';
  const lineBytes = Number.isFinite(command.lineBytes) ? Math.max(0, Number(command.lineBytes)) : 0;
  const lineCount = Number.isFinite(command.lineCount) ? Math.max(0, Number(command.lineCount)) : 0;
  const prefix = typeof command.prefix === 'string' ? command.prefix : 'stress-output';
  const payload = lineBytes > 0 ? 'X'.repeat(lineBytes) : '';
  let emitted = 0;

  function emit() {
    if (emitted >= lineCount) {
      if (doneMarker) {
        process.stdout.write(doneMarker + '\n');
      }
      outputInFlight = false;
      return;
    }

    emitted += 1;
    process.stdout.write(prefix + ':' + emitted + ':' + payload + '\n');
    setImmediate(emit);
  }

  setImmediate(emit);
}
`;

function parseArgs(argv) {
  const defaults = {
    authToken: null,
    browserChannelBackpressureDrainIntervalMs: 25,
    browserChannelClientDegradedMaxDrainPasses: 2,
    browserChannelClientDegradedMaxQueueAgeMs: 500,
    browserChannelClientDegradedMaxQueuedBytes: 256 * 1024,
    browserChannelCoalescedDataMaxBytes: 256 * 1024,
    inputChunkBytes: 4096,
    inputChunks: 24,
    jitterMs: 0,
    latencyMs: 0,
    lateJoiners: 1,
    lateJoinLiveLineBytes: 1024,
    lateJoinLiveLines: 8,
    lines: 40,
    mixedLineBytes: 2048,
    mixedLines: 20,
    outputLineBytes: 2048,
    packetLoss: 0,
    profile: null,
    reconnects: 1,
    failOnBudget: false,
    outputJsonPath: null,
    quiet: false,
    serverUrl: null,
    skipBuild: false,
    terminals: 12,
    users: 3,
    warmScrollbackLineBytes: 2048,
    warmScrollbackLines: 60,
  };

  const overrides = {};
  const controlOptions = {
    failOnBudget: false,
    outputJsonPath: null,
    quiet: false,
  };
  let profileName = null;

  function requireArgValue(flag, value) {
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }

    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--profile':
        profileName = requireArgValue(arg, next);
        index += 1;
        break;
      case '--server-url':
        overrides.serverUrl = requireArgValue(arg, next);
        index += 1;
        break;
      case '--auth-token':
        overrides.authToken = requireArgValue(arg, next);
        index += 1;
        break;
      case '--users':
        overrides.users = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--browser-channel-backpressure-drain-interval-ms':
        overrides.browserChannelBackpressureDrainIntervalMs = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--browser-channel-client-degraded-max-drain-passes':
        overrides.browserChannelClientDegradedMaxDrainPasses = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--browser-channel-client-degraded-max-queue-age-ms':
        overrides.browserChannelClientDegradedMaxQueueAgeMs = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--browser-channel-client-degraded-max-queued-bytes':
        overrides.browserChannelClientDegradedMaxQueuedBytes = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--browser-channel-coalesced-data-max-bytes':
        overrides.browserChannelCoalescedDataMaxBytes = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--terminals':
        overrides.terminals = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--lines':
        overrides.lines = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--output-line-bytes':
        overrides.outputLineBytes = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--input-chunks':
        overrides.inputChunks = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--input-chunk-bytes':
        overrides.inputChunkBytes = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--mixed-lines':
        overrides.mixedLines = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--mixed-line-bytes':
        overrides.mixedLineBytes = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--reconnects':
        overrides.reconnects = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--late-joiners':
        overrides.lateJoiners = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--late-join-live-lines':
        overrides.lateJoinLiveLines = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--late-join-live-line-bytes':
        overrides.lateJoinLiveLineBytes = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--warm-scrollback-lines':
        overrides.warmScrollbackLines = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--warm-scrollback-line-bytes':
        overrides.warmScrollbackLineBytes = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--latency-ms':
        overrides.latencyMs = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--jitter-ms':
        overrides.jitterMs = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--packet-loss':
        overrides.packetLoss = Number(requireArgValue(arg, next));
        index += 1;
        break;
      case '--output-json':
        controlOptions.outputJsonPath = requireArgValue(arg, next);
        index += 1;
        break;
      case '--fail-on-budget':
        controlOptions.failOnBudget = true;
        break;
      case '--quiet':
        controlOptions.quiet = true;
        break;
      case '--print-profiles':
        printProfiles();
        process.exit(0);
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--skip-build':
        overrides.skipBuild = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const profileArgs = profileName ? getSessionStressProfile(profileName).args : {};
  const runOptions = mergeSessionStressOptions(profileArgs, overrides);

  return {
    ...defaults,
    ...runOptions,
    failOnBudget: controlOptions.failOnBudget,
    outputJsonPath: controlOptions.outputJsonPath,
    profile: profileName,
    quiet: controlOptions.quiet,
  };
}

function printHelp() {
  console.log(`Usage: node scripts/session-stress.mjs [options]

Options:
  --profile <name>          Apply a named stress profile before explicit overrides
  --server-url <url>        Target an existing browser server instead of starting a local one
  --auth-token <token>      Bearer/query token for --server-url (defaults to AUTH_TOKEN)
  --users <n>                Concurrent users bound to the same session (default: 3)
  --terminals <n>            Concurrent terminals/agents in the session (default: 12)
  --browser-channel-backpressure-drain-interval-ms <n>
                             Browser channel drain cadence in ms (default: 25)
  --browser-channel-client-degraded-max-drain-passes <n>
                             Failed drain passes before a client/channel degrades (default: 2)
  --browser-channel-client-degraded-max-queue-age-ms <n>
                             Queue age threshold before a client/channel degrades (default: 500)
  --browser-channel-client-degraded-max-queued-bytes <n>
                             Queued bytes threshold before a client/channel degrades (default: 262144)
  --browser-channel-coalesced-data-max-bytes <n>
                             Max bytes for one coalesced terminal data frame (default: 262144)
  --lines <n>                Output lines per terminal during the output phase; 0 skips it (default: 40)
  --output-line-bytes <n>    Payload bytes per output line (default: 2048)
  --input-chunks <n>         Input writes per terminal during the input phase; 0 skips it (default: 24)
  --input-chunk-bytes <n>    Payload bytes per input write (default: 4096)
  --mixed-lines <n>          Output lines per terminal during the mixed phase; 0 skips it (default: 20)
  --mixed-line-bytes <n>     Payload bytes per mixed-phase output line (default: 2048)
  --reconnects <n>           Reconnect cycles after the first output phase (default: 1)
  --warm-scrollback-lines <n>
                             Output lines per terminal before the late-join replay phase; 0 skips it (default: 60)
  --warm-scrollback-line-bytes <n>
                             Payload bytes per warm scrollback line (default: 2048)
  --late-joiners <n>         Additional users joining after warm scrollback; 0 skips the phase (default: 1)
  --late-join-live-lines <n> Live output lines per terminal during the late-join replay phase (default: 8)
  --late-join-live-line-bytes <n>
                             Payload bytes per late-join live output line (default: 1024)
  --latency-ms <n>           Simulated control-plane latency in ms (default: 0)
  --jitter-ms <n>            Simulated control-plane jitter in ms (default: 0)
  --packet-loss <n>          Simulated retransmission-style loss as 0-1 (default: 0)
  --output-json <path>       Write the full JSON summary to a file
  --fail-on-budget           Exit non-zero when the selected profile exceeds its budgets
  --quiet                    Suppress the pretty JSON stdout dump
  --print-profiles           Print the available named profiles and exit
  --skip-build               Reuse the existing dist-server build instead of recompiling it
                             Ignored when --server-url is set

Available profiles:
  ${getSessionStressProfileNames().join('\n  ')}
`);
}

function printProfiles() {
  for (const profileName of getSessionStressProfileNames()) {
    const profile = getSessionStressProfile(profileName);
    console.log(`${profileName}: ${profile.description}`);
  }
}

function getGitSha() {
  return execSync('git rev-parse --short HEAD', {
    cwd: ROOT_DIR,
    stdio: 'pipe',
  })
    .toString('utf8')
    .trim();
}

function createRunMetadata(options) {
  return {
    generatedAt: new Date().toISOString(),
    gitSha: getGitSha(),
    hostname: os.hostname(),
    nodeVersion: process.version,
    platform: process.platform,
    profile: options.profile,
    targetMode: options.serverUrl ? 'remote' : 'local',
    targetUrl: options.serverUrl,
  };
}

function parseServerMessage(data, isBinary) {
  if (isBinary) {
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (frame.length < CHANNEL_BINARY_HEADER_BYTES || frame[0] !== CHANNEL_DATA_FRAME_TYPE) {
      return null;
    }
    return {
      type: 'channel',
      channelId: frame.toString('ascii', 1, CHANNEL_BINARY_HEADER_BYTES),
      payload: {
        type: 'Data',
        data: frame.subarray(CHANNEL_BINARY_HEADER_BYTES),
      },
    };
  }

  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getChannelText(message) {
  if (
    !message ||
    message.type !== 'channel' ||
    typeof message.payload !== 'object' ||
    message.payload === null
  ) {
    return null;
  }

  if (message.payload.type !== 'Data') {
    return null;
  }

  const data = message.payload.data;
  if (typeof data === 'string') {
    return Buffer.from(data, 'base64').toString('utf8');
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    return Buffer.from(data).toString('utf8');
  }
  return null;
}

function isRecoveryRequiredMessage(message) {
  return (
    message &&
    message.type === 'channel' &&
    typeof message.channelId === 'string' &&
    typeof message.payload === 'object' &&
    message.payload !== null &&
    message.payload.type === 'RecoveryRequired'
  );
}

function createChannelId() {
  return randomUUID();
}

function createTaskId() {
  return `stress-task-${Date.now()}-${randomUUID()}`;
}

function createReadyMarker(agentId) {
  return `__SESSION_STRESS_READY_${agentId}__`;
}

function createOutputDoneMarker(phaseId, agentId) {
  return `__SESSION_STRESS_OUTPUT_DONE_${phaseId}_${agentId}__`;
}

function createInputDoneMarker(phaseId, agentId) {
  return `__SESSION_STRESS_INPUT_DONE_${phaseId}_${agentId}__`;
}

function createInputChunk(phaseId, agentId, writerIndex, chunkIndex, chunkBytes) {
  const prefix = `${phaseId}:${agentId}:${writerIndex}:${chunkIndex}:`;
  const payloadBytes = Math.max(0, chunkBytes - Buffer.byteLength(prefix));
  return `${prefix}${'I'.repeat(payloadBytes)}\n`;
}

function createInputDoneLine(phaseId, agentId) {
  return `${createInputDoneMarker(phaseId, agentId)}\n`;
}

function createStartOutputLine(phaseId, agentId, lineCount, lineBytes) {
  return `${STRESS_CONTROL_PREFIX}${JSON.stringify({
    doneMarker: createOutputDoneMarker(phaseId, agentId),
    lineBytes,
    lineCount,
    prefix: `${phaseId}:${agentId}`,
    type: 'start-output',
  })}\n`;
}

function getSafeChunkEnd(data, start, maxChunkChars) {
  const proposedEnd = Math.min(data.length, start + maxChunkChars);
  if (proposedEnd <= start) {
    return start + 1;
  }

  if (proposedEnd >= data.length) {
    return proposedEnd;
  }

  const previous = data.charCodeAt(proposedEnd - 1);
  const next = data.charCodeAt(proposedEnd);
  const previousIsHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  const nextIsLowSurrogate = next >= 0xdc00 && next <= 0xdfff;

  if (previousIsHighSurrogate && nextIsLowSurrogate) {
    return proposedEnd - 1;
  }

  return proposedEnd;
}

function splitStressInputData(data, maxChunkChars = MAX_CLIENT_INPUT_DATA_LENGTH) {
  if (!data) {
    return [];
  }

  const chunks = [];
  let offset = 0;
  while (offset < data.length) {
    const end = getSafeChunkEnd(data, offset, maxChunkChars);
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve a port')));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startLocalServer(options) {
  if (!options.skipBuild) {
    execSync('npx tsc -p server/tsconfig.json', {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  }

  const port = await reservePort();
  const env = createLocalServerEnv(options, port);

  const serverProcess = spawn('node', [SERVER_ENTRY], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timeout'));
    }, 15_000);

    serverProcess.stdout.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('listening on')) {
        globalThis.clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('Warning')) {
        return;
      }
      process.stderr.write(`[stress-server] ${text}`);
    });

    serverProcess.on('exit', (code) => {
      globalThis.clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}`));
    });

    serverProcess.on('error', (error) => {
      globalThis.clearTimeout(timeout);
      reject(error);
    });
  });

  const client = createBrowserServerClient({
    authToken: DEFAULT_TOKEN,
    serverUrl: `http://127.0.0.1:${port}`,
  });

  return createServerTarget({
    baseUrl: client.baseUrl,
    client,
    mode: 'local',
    port,
    process: serverProcess,
    stop: async () => {
      if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
        return;
      }

      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5_000);
        serverProcess.once('exit', () => {
          globalThis.clearTimeout(timeout);
          resolve();
        });
        serverProcess.kill('SIGTERM');
      });
    },
  });
}

function createRemoteServerTarget(options) {
  if (!options.serverUrl) {
    throw new Error('Missing server URL');
  }

  const client = createBrowserServerClient({
    authToken: options.authToken,
    serverUrl: options.serverUrl,
  });
  const parsedUrl = new globalThis.URL(client.baseUrl);
  const numericPort = parsedUrl.port ? Number(parsedUrl.port) : null;

  return createServerTarget({
    baseUrl: client.baseUrl,
    client,
    mode: 'remote',
    port: Number.isFinite(numericPort) ? numericPort : null,
    process: null,
    stop: async () => {},
  });
}

async function startServerTarget(options) {
  if (options.serverUrl) {
    return createRemoteServerTarget(options);
  }

  return startLocalServer(options);
}

function createLocalServerEnv(options, port) {
  return {
    ...process.env,
    AUTH_TOKEN: DEFAULT_TOKEN,
    BROWSER_CHANNEL_BACKPRESSURE_DRAIN_INTERVAL_MS: String(
      options.browserChannelBackpressureDrainIntervalMs,
    ),
    BROWSER_CHANNEL_CLIENT_DEGRADED_MAX_DRAIN_PASSES: String(
      options.browserChannelClientDegradedMaxDrainPasses,
    ),
    BROWSER_CHANNEL_CLIENT_DEGRADED_MAX_QUEUE_AGE_MS: String(
      options.browserChannelClientDegradedMaxQueueAgeMs,
    ),
    BROWSER_CHANNEL_CLIENT_DEGRADED_MAX_QUEUED_BYTES: String(
      options.browserChannelClientDegradedMaxQueuedBytes,
    ),
    BROWSER_CHANNEL_COALESCED_DATA_MAX_BYTES: String(options.browserChannelCoalescedDataMaxBytes),
    PARALLEL_CODE_USER_DATA_DIR: path.resolve(ROOT_DIR, '.stress-server-data'),
    PORT: String(port),
    SIMULATE_JITTER_MS: String(options.jitterMs),
    SIMULATE_LATENCY_MS: String(options.latencyMs),
    SIMULATE_PACKET_LOSS: String(options.packetLoss),
  };
}

function createServerTarget({ baseUrl, client, mode, port, process, stop }) {
  return {
    baseUrl,
    client,
    label: baseUrl,
    mode,
    port,
    process,
    stop,
  };
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function getClientBufferedAmount(ws) {
  return typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
}

function createClientState(label) {
  return {
    clientId: `stress-client-${label}-${randomUUID()}`,
    label,
    lastSeq: -1,
  };
}

function recordClientLastSeq(clientState, message) {
  if (typeof message?.seq !== 'number' || !Number.isInteger(message.seq)) {
    return;
  }

  if (message.seq > clientState.lastSeq) {
    clientState.lastSeq = message.seq;
  }
}

async function connectClient(serverTarget, clientState) {
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(serverTarget.client.createWebSocketUrl());
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting client ${clientState.label}`));
    }, 10_000);

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: serverTarget.client.authToken,
          clientId: clientState.clientId,
          lastSeq: clientState.lastSeq,
        }),
      );
    });

    socket.on('message', (data, isBinary) => {
      const message = parseServerMessage(data, isBinary);
      recordClientLastSeq(clientState, message);
      if (message?.type !== 'agents') {
        return;
      }

      globalThis.clearTimeout(timeout);
      resolve(socket);
    });

    socket.on('error', (error) => {
      globalThis.clearTimeout(timeout);
      reject(error);
    });
  });

  return ws;
}

async function invokeIpc(serverTarget, channel, body) {
  return serverTarget.client.invokeIpc(channel, body);
}

function isUnknownIpcChannelError(error) {
  return error instanceof Error && /failed \(404\): unknown ipc channel/i.test(error.message);
}

async function spawnAgent(serverTarget, taskId, agent) {
  await invokeIpc(serverTarget, 'spawn_agent', {
    agentId: agent.agentId,
    args: ['-e', SYNTHETIC_TUI_AGENT_SOURCE],
    cols: 80,
    command: SYNTHETIC_TUI_AGENT_COMMAND,
    cwd: '/tmp',
    env: {
      STRESS_READY_MARKER: createReadyMarker(agent.agentId),
    },
    isShell: false,
    onOutput: { __CHANNEL_ID__: agent.channelId },
    rows: 24,
    taskId,
  });
}

async function killAgent(serverTarget, agentId) {
  await invokeIpc(serverTarget, 'kill_agent', { agentId });
}

async function resetBackendDiagnostics(serverTarget) {
  await invokeIpc(serverTarget, 'reset_backend_runtime_diagnostics');
}

async function getBackendDiagnostics(serverTarget) {
  return invokeIpc(serverTarget, 'get_backend_runtime_diagnostics');
}

async function getBrowserReconnectSnapshot(serverTarget) {
  try {
    return await invokeIpc(serverTarget, 'get_browser_reconnect_snapshot');
  } catch (error) {
    if (!isUnknownIpcChannelError(error)) {
      throw error;
    }

    const [appStateJson, runningAgentIds] = await Promise.all([
      invokeIpc(serverTarget, 'load_app_state'),
      invokeIpc(serverTarget, 'list_running_agent_ids'),
    ]);
    return {
      appStateJson,
      runningAgentIds,
    };
  }
}

async function getScrollbackBatch(serverTarget, agentIds) {
  try {
    return await invokeIpc(serverTarget, 'get_scrollback_batch', { agentIds });
  } catch (error) {
    if (!isUnknownIpcChannelError(error)) {
      throw error;
    }

    return Promise.all(
      agentIds.map(async (agentId) => ({
        agentId,
        cols: 80,
        scrollback: await invokeIpc(serverTarget, 'get_agent_scrollback', { agentId }),
      })),
    );
  }
}

function getTotalScrollbackBytes(entries) {
  return entries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.scrollback ?? '', 'base64'),
    0,
  );
}

function getAgentIds(agents) {
  return agents.map((agent) => agent.agentId);
}

function getAgentIdsForChannelIds(agents, channelIds) {
  const agentIdByChannelId = new Map(agents.map((agent) => [agent.channelId, agent.agentId]));
  return Array.from(
    new Set(
      Array.from(channelIds, (channelId) => agentIdByChannelId.get(channelId)).filter(
        (agentId) => typeof agentId === 'string',
      ),
    ),
  );
}

function getReplayAgentIds(agents, resetChannelIds) {
  const resetAgentIds = getAgentIdsForChannelIds(agents, resetChannelIds);
  if (resetAgentIds.length > 0) {
    return resetAgentIds;
  }

  return getAgentIds(agents);
}

async function bindClientToChannels(ws, channelIds) {
  const pending = new Set(channelIds);
  const resetRequiredChannelIds = new Set();
  const completion = new Promise((resolve, reject) => {
    let settleTimer = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pending.size} channel bindings`));
    }, 15_000);

    function cleanup() {
      globalThis.clearTimeout(timeout);
      if (settleTimer !== null) {
        globalThis.clearTimeout(settleTimer);
      }
      ws.removeListener('message', onMessage);
    }

    function settleIfReady() {
      if (pending.size !== 0 || settleTimer !== null) {
        return;
      }

      settleTimer = globalThis.setTimeout(() => {
        cleanup();
        resolve(resetRequiredChannelIds);
      }, 0);
    }

    function onMessage(data, isBinary) {
      const message = parseServerMessage(data, isBinary);
      if (isRecoveryRequiredMessage(message)) {
        resetRequiredChannelIds.add(message.channelId);
        settleIfReady();
        return;
      }

      if (message?.type !== 'channel-bound' || typeof message.channelId !== 'string') {
        return;
      }

      pending.delete(message.channelId);
      settleIfReady();
    }

    ws.on('message', onMessage);
  });

  for (const channelId of channelIds) {
    sendJson(ws, { type: 'bind-channel', channelId });
  }

  await completion;
  return resetRequiredChannelIds;
}

async function waitForChannelMarker(ws, channelId, marker, timeoutMs = 15_000) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for marker ${marker} on ${channelId}`));
    }, timeoutMs);

    function cleanup() {
      globalThis.clearTimeout(timeout);
      ws.removeListener('message', onMessage);
    }

    function onMessage(data, isBinary) {
      const message = parseServerMessage(data, isBinary);
      if (message?.type !== 'channel' || message.channelId !== channelId) {
        return;
      }

      const text = getChannelText(message);
      if (!text || !text.includes(marker)) {
        return;
      }

      cleanup();
      resolve();
    }

    ws.on('message', onMessage);
  });
}

function createClientMarkerWatcher(ws, markersByChannel, timeoutMs, liveDataPrefix = null) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    const seen = new Map();
    let messageCount = 0;
    let bytes = 0;
    const resetChannels = new Set();
    let resetMarkerCount = 0;
    let firstChannelDataMs = null;
    let firstLiveDataMs = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${markersByChannel.size - seen.size} done markers`));
    }, timeoutMs);

    function cleanup() {
      globalThis.clearTimeout(timeout);
      ws.removeListener('message', onMessage);
    }

    function onMessage(data, isBinary) {
      messageCount += 1;
      bytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
      const message = parseServerMessage(data, isBinary);
      if (isRecoveryRequiredMessage(message)) {
        resetChannels.add(message.channelId);
        for (const [marker, channelId] of markersByChannel.entries()) {
          if (channelId !== message.channelId || seen.has(marker)) {
            continue;
          }

          seen.set(marker, performance.now() - startTime);
          resetMarkerCount += 1;
        }

        if (seen.size === markersByChannel.size) {
          cleanup();
          resolve({
            bytes,
            durationMs: performance.now() - startTime,
            firstChannelDataMs,
            firstLiveDataMs,
            messageCount,
            resetChannelCount: resetChannels.size,
            resetMarkerCount,
            timings: seen,
          });
        }
        return;
      }

      if (!message?.channelId) {
        return;
      }

      const text = getChannelText(message);
      if (!text) {
        return;
      }

      const elapsedMs = performance.now() - startTime;
      if (firstChannelDataMs === null) {
        firstChannelDataMs = elapsedMs;
      }
      if (
        firstLiveDataMs === null &&
        typeof liveDataPrefix === 'string' &&
        text.includes(liveDataPrefix)
      ) {
        firstLiveDataMs = elapsedMs;
      }

      for (const [marker, channelId] of markersByChannel.entries()) {
        if (seen.has(marker) || channelId !== message.channelId || !text.includes(marker)) {
          continue;
        }

        seen.set(marker, elapsedMs);
        if (seen.size === markersByChannel.size) {
          cleanup();
          resolve({
            bytes,
            durationMs: performance.now() - startTime,
            firstChannelDataMs,
            firstLiveDataMs,
            messageCount,
            resetChannelCount: resetChannels.size,
            resetMarkerCount,
            timings: seen,
          });
        }
      }
    }

    ws.on('message', onMessage);
  });
}

function createMarkerWatcher(ws, markersByChannel, timeoutMs) {
  return createClientMarkerWatcher(ws, markersByChannel, timeoutMs);
}

function createLateJoinClientWatcher(ws, markersByChannel, timeoutMs, liveDataPrefix) {
  return createClientMarkerWatcher(ws, markersByChannel, timeoutMs, liveDataPrefix);
}

function getPercentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return sorted[index] ?? 0;
}

function summarizeWatcherResults(results) {
  const markerIds = Array.from(results[0]?.timings.keys() ?? []);
  const skews = markerIds.map((markerId) => {
    const samples = results
      .map((result) => result.timings.get(markerId))
      .filter((value) => typeof value === 'number');
    return Math.max(...samples) - Math.min(...samples);
  });

  return {
    avgDurationMs:
      results.reduce((sum, result) => sum + result.durationMs, 0) / Math.max(results.length, 1),
    maxDurationMs: Math.max(...results.map((result) => result.durationMs)),
    maxSkewMs: Math.max(...skews),
    p95SkewMs: getPercentile(skews, 0.95),
    totalResetChannels: results.reduce((sum, result) => sum + result.resetChannelCount, 0),
    totalResetMarkers: results.reduce((sum, result) => sum + result.resetMarkerCount, 0),
    totalBytes: results.reduce((sum, result) => sum + result.bytes, 0),
    totalMessages: results.reduce((sum, result) => sum + result.messageCount, 0),
  };
}

function createPhaseWatchers(clients, markersByChannel, timeoutMs) {
  return clients.map((client) => createMarkerWatcher(client, markersByChannel, timeoutMs));
}

function createLateJoinClientWatchers(clients, markersByChannel, timeoutMs, liveDataPrefix) {
  return clients.map((client) =>
    createLateJoinClientWatcher(client, markersByChannel, timeoutMs, liveDataPrefix),
  );
}

function getAgentWriterClient(clients, agentIndex) {
  return clients[agentIndex % clients.length];
}

function recordBufferedAmount(maxBufferedAmountByClient, clients) {
  for (const [index, client] of clients.entries()) {
    const bufferedAmount = getClientBufferedAmount(client);
    const currentMax = maxBufferedAmountByClient.get(index) ?? 0;
    if (bufferedAmount > currentMax) {
      maxBufferedAmountByClient.set(index, bufferedAmount);
    }
  }
}

function getMaxBufferedAmount(maxBufferedAmountByClient) {
  return Math.max(0, ...maxBufferedAmountByClient.values());
}

function createOutputMarkersByChannel(agents, phaseId) {
  return new Map(
    agents.map((agent) => [createOutputDoneMarker(phaseId, agent.agentId), agent.channelId]),
  );
}

function createMixedMarkersByChannel(agents, phaseId) {
  const markersByChannel = new Map();
  for (const agent of agents) {
    markersByChannel.set(createOutputDoneMarker(phaseId, agent.agentId), agent.channelId);
    markersByChannel.set(createInputDoneMarker(phaseId, agent.agentId), agent.channelId);
  }
  return markersByChannel;
}

function sendTrackedAgentInput(writerClient, clients, maxBufferedAmountByClient, agentId, data) {
  for (const chunk of splitStressInputData(data)) {
    sendJson(writerClient, {
      type: 'input',
      agentId,
      data: chunk,
    });
    recordBufferedAmount(maxBufferedAmountByClient, clients);
  }
  return Buffer.byteLength(data);
}

function normalizePhaseWriteResult(writeResult) {
  if (typeof writeResult === 'number') {
    return {
      sentBytes: writeResult,
      writeMetadata: null,
    };
  }

  if (writeResult && typeof writeResult === 'object') {
    return {
      sentBytes: typeof writeResult.sentBytes === 'number' ? writeResult.sentBytes : 0,
      writeMetadata: writeResult,
    };
  }

  return {
    sentBytes: 0,
    writeMetadata: null,
  };
}

function createPhaseSummary(
  diagnostics,
  maxBufferedAmountByClient,
  results,
  startedAt,
  writeResult,
) {
  const { sentBytes, writeMetadata } = normalizePhaseWriteResult(writeResult);
  const phaseSummary = {
    diagnostics,
    maxClientBufferedAmountBytes: getMaxBufferedAmount(maxBufferedAmountByClient),
    metrics: summarizeWatcherResults(results),
    sentBytes,
    wallClockMs: performance.now() - startedAt,
  };

  if (!writeMetadata) {
    return phaseSummary;
  }

  return {
    ...phaseSummary,
    writeMetadata,
  };
}

function createEmptyPhaseMetrics() {
  return {
    avgDurationMs: 0,
    maxDurationMs: 0,
    maxSkewMs: 0,
    p95SkewMs: 0,
    totalBytes: 0,
    totalMessages: 0,
    totalResetChannels: 0,
    totalResetMarkers: 0,
  };
}

async function createSkippedPhaseSummary(serverTarget) {
  await resetBackendDiagnostics(serverTarget);
  const diagnostics = await getBackendDiagnostics(serverTarget);
  return {
    diagnostics,
    maxClientBufferedAmountBytes: 0,
    metrics: createEmptyPhaseMetrics(),
    sentBytes: 0,
    skipped: true,
    wallClockMs: 0,
  };
}

async function runMeasuredPhase(serverTarget, clients, markersByChannel, timeoutMs, performWrites) {
  const watchers = createPhaseWatchers(clients, markersByChannel, timeoutMs);
  const maxBufferedAmountByClient = new Map();

  await resetBackendDiagnostics(serverTarget);
  const startedAt = performance.now();
  const sentBytes = await performWrites(maxBufferedAmountByClient);
  const results = await Promise.all(watchers);
  const diagnostics = await getBackendDiagnostics(serverTarget);

  return createPhaseSummary(diagnostics, maxBufferedAmountByClient, results, startedAt, sentBytes);
}

async function connectAndBindClient(serverTarget, clientState, channelIds) {
  const connectStartedAt = performance.now();
  const client = await connectClient(serverTarget, clientState);
  const connectMs = performance.now() - connectStartedAt;
  const bindStartedAt = performance.now();
  const resetChannelIds = await bindClientToChannels(client, channelIds);
  const bindMs = performance.now() - bindStartedAt;

  return {
    bindMs,
    client,
    connectMs,
    resetChannelIds,
    totalMs: connectMs + bindMs,
  };
}

async function getScrollbackBatchResult(serverTarget, agentIds) {
  const startedAt = performance.now();
  const entries = await getScrollbackBatch(serverTarget, agentIds);
  return {
    agentCount: agentIds.length,
    entries,
    returnedBytes: getTotalScrollbackBytes(entries),
    wallClockMs: performance.now() - startedAt,
  };
}

function getAverage(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeLateJoinClientResults(results, replayResults) {
  const firstChannelDataMsValues = results
    .map((result) => result.firstChannelDataMs)
    .filter((value) => typeof value === 'number');
  const firstLiveDataMsValues = results
    .map((result) =>
      typeof result.firstLiveDataMs === 'number' ? result.firstLiveDataMs : result.durationMs,
    )
    .filter((value) => typeof value === 'number');
  const readyMsValues = results
    .map((result, index) =>
      Math.max(
        replayResults[index]?.wallClockMs ?? 0,
        typeof result.firstLiveDataMs === 'number' ? result.firstLiveDataMs : result.durationMs,
      ),
    )
    .filter((value) => typeof value === 'number');

  return {
    avgFirstChannelDataMs: getAverage(firstChannelDataMsValues),
    avgFirstLiveDataMs: getAverage(firstLiveDataMsValues),
    avgReadyMs: getAverage(readyMsValues),
    count: results.length,
    maxFirstChannelDataMs: Math.max(0, ...firstChannelDataMsValues),
    maxFirstLiveDataMs: Math.max(0, ...firstLiveDataMsValues),
    maxReadyMs: Math.max(0, ...readyMsValues),
    metrics: summarizeWatcherResults(results),
  };
}

function summarizeReplayResults(results) {
  const durations = results.map((result) => result.wallClockMs);
  return {
    avgClientWallClockMs: getAverage(durations),
    maxClientWallClockMs: Math.max(0, ...durations),
    requestCount: results.length,
    totalRequestedAgents: results.reduce((total, result) => total + result.agentCount, 0),
    totalReturnedBytes: results.reduce((total, result) => total + result.returnedBytes, 0),
  };
}

function getLateJoinPhaseTimeoutMs(serverTarget, agentCount, lateJoinerCount) {
  const baseMs = 30_000;
  const remoteExtraMs = serverTarget.mode === 'remote' ? 15_000 : 0;
  const agentExtraMs = Math.max(0, agentCount - 8) * 750;
  const lateJoinerExtraMs = Math.max(0, lateJoinerCount - 1) * 5_000;
  return baseMs + remoteExtraMs + agentExtraMs + lateJoinerExtraMs;
}

async function runReconnectOutputBurst(
  serverTarget,
  activeClients,
  reconnectingState,
  staleClient,
  agents,
  channelIds,
  phaseId,
  lineCount,
  lineBytes,
) {
  await resetBackendDiagnostics(serverTarget);

  const reconnectStartedAt = performance.now();
  staleClient?.close();
  const replacement = await connectClient(serverTarget, reconnectingState);
  activeClients.push(replacement);
  const resetChannelIds = await bindClientToChannels(replacement, channelIds);
  const replayAgentIds = getReplayAgentIds(agents, resetChannelIds);

  const restorePromises = [getBrowserReconnectSnapshot(serverTarget)];
  if (replayAgentIds.length > 0) {
    restorePromises.push(getScrollbackBatch(serverTarget, replayAgentIds));
  }
  await Promise.all(restorePromises);

  const reconnectMs = performance.now() - reconnectStartedAt;
  if (lineCount <= 0) {
    const diagnostics = await getBackendDiagnostics(serverTarget);
    return {
      ...(await createSkippedPhaseSummary(serverTarget)),
      diagnostics,
      reconnectMs,
    };
  }

  const watchers = createPhaseWatchers(
    activeClients,
    createOutputMarkersByChannel(agents, phaseId),
    30_000,
  );
  const maxBufferedAmountByClient = new Map();
  const startedAt = performance.now();

  for (const [agentIndex, agent] of agents.entries()) {
    const writerClient = getAgentWriterClient(activeClients, agentIndex);
    sendTrackedAgentInput(
      writerClient,
      activeClients,
      maxBufferedAmountByClient,
      agent.agentId,
      createStartOutputLine(phaseId, agent.agentId, lineCount, lineBytes),
    );
  }

  const results = await Promise.all(watchers);
  const diagnostics = await getBackendDiagnostics(serverTarget);

  return {
    reconnectMs,
    ...createPhaseSummary(diagnostics, maxBufferedAmountByClient, results, startedAt),
  };
}

async function runOutputPhase(serverTarget, clients, agents, phaseId, lineCount, lineBytes) {
  if (lineCount <= 0) {
    return createSkippedPhaseSummary(serverTarget);
  }

  return runMeasuredPhase(
    serverTarget,
    clients,
    createOutputMarkersByChannel(agents, phaseId),
    30_000,
    async (maxBufferedAmountByClient) => {
      for (const [agentIndex, agent] of agents.entries()) {
        const writerClient = getAgentWriterClient(clients, agentIndex);
        sendTrackedAgentInput(
          writerClient,
          clients,
          maxBufferedAmountByClient,
          agent.agentId,
          createStartOutputLine(phaseId, agent.agentId, lineCount, lineBytes),
        );
      }
    },
  );
}

async function runInputPhase(serverTarget, clients, agents, phaseId, chunkCount, chunkBytes) {
  if (chunkCount <= 0) {
    return createSkippedPhaseSummary(serverTarget);
  }

  return runMeasuredPhase(
    serverTarget,
    clients,
    new Map(
      agents.map((agent) => [createInputDoneMarker(phaseId, agent.agentId), agent.channelId]),
    ),
    30_000,
    async (maxBufferedAmountByClient) => {
      let sentBytes = 0;

      for (const [agentIndex, agent] of agents.entries()) {
        const writerClient = getAgentWriterClient(clients, agentIndex);
        const writerIndex = agentIndex % clients.length;
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          sentBytes += sendTrackedAgentInput(
            writerClient,
            clients,
            maxBufferedAmountByClient,
            agent.agentId,
            createInputChunk(phaseId, agent.agentId, writerIndex, chunkIndex, chunkBytes),
          );
        }

        sentBytes += sendTrackedAgentInput(
          writerClient,
          clients,
          maxBufferedAmountByClient,
          agent.agentId,
          createInputDoneLine(phaseId, agent.agentId),
        );
      }

      return sentBytes;
    },
  );
}

async function runMixedPhase(
  serverTarget,
  clients,
  agents,
  phaseId,
  outputLineCount,
  outputLineBytes,
  inputChunkCount,
  inputChunkBytes,
) {
  if (outputLineCount <= 0) {
    return createSkippedPhaseSummary(serverTarget);
  }

  return runMeasuredPhase(
    serverTarget,
    clients,
    createMixedMarkersByChannel(agents, phaseId),
    45_000,
    async (maxBufferedAmountByClient) => {
      let sentBytes = 0;

      for (const [agentIndex, agent] of agents.entries()) {
        const writerClient = getAgentWriterClient(clients, agentIndex);
        const writerIndex = agentIndex % clients.length;
        sentBytes += sendTrackedAgentInput(
          writerClient,
          clients,
          maxBufferedAmountByClient,
          agent.agentId,
          createStartOutputLine(phaseId, agent.agentId, outputLineCount, outputLineBytes),
        );

        for (let chunkIndex = 0; chunkIndex < inputChunkCount; chunkIndex += 1) {
          sentBytes += sendTrackedAgentInput(
            writerClient,
            clients,
            maxBufferedAmountByClient,
            agent.agentId,
            createInputChunk(phaseId, agent.agentId, writerIndex, chunkIndex, inputChunkBytes),
          );
        }

        sentBytes += sendTrackedAgentInput(
          writerClient,
          clients,
          maxBufferedAmountByClient,
          agent.agentId,
          createInputDoneLine(phaseId, agent.agentId),
        );
      }

      return sentBytes;
    },
  );
}

async function runLateJoinScrollbackPhase(
  serverTarget,
  existingClients,
  allClients,
  agents,
  warmScrollbackLineCount,
  lateJoinerCount,
  liveLineCount,
  liveLineBytes,
) {
  if (lateJoinerCount <= 0 || liveLineCount <= 0 || warmScrollbackLineCount <= 0) {
    return {
      ...(await createSkippedPhaseSummary(serverTarget)),
      connectAndBind: {
        avgBindMs: 0,
        avgConnectMs: 0,
        avgTotalMs: 0,
        maxBindMs: 0,
        maxConnectMs: 0,
        maxTotalMs: 0,
      },
      existingClientImpact: {
        ...createEmptyPhaseMetrics(),
      },
      lateJoinClients: {
        avgFirstChannelDataMs: 0,
        avgFirstLiveDataMs: 0,
        avgReadyMs: 0,
        count: 0,
        maxFirstChannelDataMs: 0,
        maxFirstLiveDataMs: 0,
        maxReadyMs: 0,
        metrics: createEmptyPhaseMetrics(),
      },
      replay: {
        avgClientWallClockMs: 0,
        maxClientWallClockMs: 0,
        requestCount: 0,
        totalReturnedBytes: 0,
        totalRequestedAgents: 0,
        wallClockMs: 0,
      },
    };
  }

  const lateJoinStates = Array.from({ length: lateJoinerCount }, (_, index) =>
    createClientState(`late-join-${index}`),
  );
  const channelIds = agents.map((agent) => agent.channelId);
  const connectAndBindResults = await Promise.all(
    lateJoinStates.map((clientState) =>
      connectAndBindClient(serverTarget, clientState, channelIds),
    ),
  );
  const lateJoinClients = connectAndBindResults.map((result) => result.client);
  allClients.push(...lateJoinClients);
  const lateJoinReplayAgentIdsByClient = connectAndBindResults.map((result) =>
    getReplayAgentIds(agents, result.resetChannelIds),
  );

  const phaseTimeoutMs = getLateJoinPhaseTimeoutMs(serverTarget, agents.length, lateJoinerCount);
  const liveMarkersByChannel = createOutputMarkersByChannel(agents, 'late-join-live');
  const liveDataPrefix = 'late-join-live:';
  const existingClientWatchers = createPhaseWatchers(
    existingClients,
    liveMarkersByChannel,
    phaseTimeoutMs,
  );
  const lateJoinClientWatchers = createLateJoinClientWatchers(
    lateJoinClients,
    liveMarkersByChannel,
    phaseTimeoutMs,
    liveDataPrefix,
  );
  const combinedClients = [...existingClients, ...lateJoinClients];
  let replayDurationMs = 0;

  const phaseSummary = await runMeasuredPhase(
    serverTarget,
    combinedClients,
    liveMarkersByChannel,
    phaseTimeoutMs,
    async (maxBufferedAmountByClient) => {
      let sentBytes = 0;
      const replayStartedAt = performance.now();
      const scrollbackBatchPromise = Promise.all(
        lateJoinReplayAgentIdsByClient.map((ids) => getScrollbackBatchResult(serverTarget, ids)),
      );

      for (const [agentIndex, agent] of agents.entries()) {
        const writerClient = getAgentWriterClient(existingClients, agentIndex);
        sentBytes += sendTrackedAgentInput(
          writerClient,
          combinedClients,
          maxBufferedAmountByClient,
          agent.agentId,
          createStartOutputLine('late-join-live', agent.agentId, liveLineCount, liveLineBytes),
        );
      }

      const scrollbackResults = await scrollbackBatchPromise;
      replayDurationMs = performance.now() - replayStartedAt;
      return {
        sentBytes,
        scrollbackResults,
      };
    },
  );

  const scrollbackResults = phaseSummary.writeMetadata?.scrollbackResults ?? [];
  const [existingClientResults, lateJoinClientResults] = await Promise.all([
    Promise.all(existingClientWatchers),
    Promise.all(lateJoinClientWatchers),
  ]);
  const replaySummary = summarizeReplayResults(scrollbackResults);

  return {
    ...phaseSummary,
    connectAndBind: {
      avgBindMs: getAverage(connectAndBindResults.map((result) => result.bindMs)),
      avgConnectMs: getAverage(connectAndBindResults.map((result) => result.connectMs)),
      avgTotalMs: getAverage(connectAndBindResults.map((result) => result.totalMs)),
      maxBindMs: Math.max(0, ...connectAndBindResults.map((result) => result.bindMs)),
      maxConnectMs: Math.max(0, ...connectAndBindResults.map((result) => result.connectMs)),
      maxTotalMs: Math.max(0, ...connectAndBindResults.map((result) => result.totalMs)),
    },
    existingClientImpact: summarizeWatcherResults(existingClientResults),
    lateJoinClients: summarizeLateJoinClientResults(lateJoinClientResults, scrollbackResults),
    metrics: summarizeWatcherResults([...existingClientResults, ...lateJoinClientResults]),
    replay: {
      ...replaySummary,
      wallClockMs: replayDurationMs,
    },
  };
}

function getNumericValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getPhaseEntries(summary) {
  const entries = [
    ['output', summary.phases.output],
    ['input', summary.phases.input],
    ['mixed', summary.phases.mixed],
    ['warmScrollback', summary.phases.warmScrollback],
    ['lateJoin', summary.phases.lateJoin],
    ...(summary.phases.reconnectOutputBursts ?? []).map((phase, index) => [
      `reconnectOutputBursts[${index}]`,
      phase,
    ]),
  ];

  return entries.filter((entry) => entry[1] && entry[1].skipped !== true);
}

function getMaxPhaseMetric(summary, getValue) {
  return Math.max(
    0,
    ...getPhaseEntries(summary).map(([, phase]) => getNumericValue(getValue(phase))),
  );
}

function getTotalPhaseMetric(summary, getValue) {
  return getPhaseEntries(summary).reduce(
    (total, [, phase]) => total + getNumericValue(getValue(phase)),
    0,
  );
}

function createDiagnosticsRollup(summary) {
  return {
    browserChannels: {
      maxDegradedClientChannels: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserChannels?.degradedClientChannels,
      ),
      maxQueuedBytes: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserChannels?.maxQueuedBytes,
      ),
      maxQueueAgeMs: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserChannels?.maxQueueAgeMs,
      ),
      recoveredClientChannels: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserChannels?.recoveredClientChannels,
      ),
      resetBindings: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserChannels?.resetBindings,
      ),
      transportBusyDeferrals: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserChannels?.transportBusyDeferrals,
      ),
    },
    browserControl: {
      backpressureRejects: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserControl?.backpressureRejects,
      ),
      delayedQueueMaxAgeMs: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserControl?.delayedQueueMaxAgeMs,
      ),
      delayedQueueMaxBytes: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserControl?.delayedQueueMaxBytes,
      ),
      delayedQueueMaxDepth: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserControl?.delayedQueueMaxDepth,
      ),
      notOpenRejects: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserControl?.notOpenRejects,
      ),
      sendErrors: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.browserControl?.sendErrors,
      ),
    },
    ptyInput: {
      maxQueuedChars: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.ptyInput?.maxQueuedChars,
      ),
      totalCoalescedMessages: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.ptyInput?.coalescedMessages,
      ),
      totalFlushes: getTotalPhaseMetric(summary, (phase) => phase.diagnostics?.ptyInput?.flushes),
    },
    reconnectSnapshots: {
      cacheHits: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.reconnectSnapshots?.cacheHits,
      ),
      cacheInvalidations: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.reconnectSnapshots?.cacheInvalidations,
      ),
      cacheMisses: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.reconnectSnapshots?.cacheMisses,
      ),
    },
    scrollbackReplay: {
      batchRequests: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.scrollbackReplay?.batchRequests,
      ),
      cacheHits: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.scrollbackReplay?.cacheHits,
      ),
      cacheMisses: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.scrollbackReplay?.cacheMisses,
      ),
      maxDurationMs: getMaxPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.scrollbackReplay?.maxDurationMs,
      ),
      totalReturnedBytes: getTotalPhaseMetric(
        summary,
        (phase) => phase.diagnostics?.scrollbackReplay?.returnedBytes,
      ),
    },
  };
}

function createTopSuspects(summary, diagnosticsRollup) {
  const suspects = [];
  if (diagnosticsRollup.browserControl.backpressureRejects > 0) {
    suspects.push({
      area: 'browser-control',
      metric: 'backpressureRejects',
      value: diagnosticsRollup.browserControl.backpressureRejects,
      note: 'Slow-link websocket delivery is still shedding sends under this workload.',
    });
  }
  if (diagnosticsRollup.browserControl.delayedQueueMaxAgeMs >= 100) {
    suspects.push({
      area: 'browser-control',
      metric: 'delayedQueueMaxAgeMs',
      value: diagnosticsRollup.browserControl.delayedQueueMaxAgeMs,
      note: 'A client transport queue stayed busy long enough to become a likely fanout bottleneck.',
    });
  }
  if (diagnosticsRollup.browserChannels.maxDegradedClientChannels > 0) {
    suspects.push({
      area: 'browser-channels',
      metric: 'maxDegradedClientChannels',
      value: diagnosticsRollup.browserChannels.maxDegradedClientChannels,
      note: 'One or more terminal subscribers crossed degraded-mode thresholds.',
    });
  }
  if (diagnosticsRollup.scrollbackReplay.maxDurationMs >= 500) {
    suspects.push({
      area: 'scrollback-replay',
      metric: 'maxDurationMs',
      value: diagnosticsRollup.scrollbackReplay.maxDurationMs,
      note: 'Late join or reconnect replay is contributing measurable restore latency.',
    });
  }
  if (
    diagnosticsRollup.reconnectSnapshots.cacheMisses > 1 &&
    diagnosticsRollup.reconnectSnapshots.cacheMisses >
      diagnosticsRollup.reconnectSnapshots.cacheHits
  ) {
    suspects.push({
      area: 'reconnect-snapshot',
      metric: 'cacheMisses',
      value: diagnosticsRollup.reconnectSnapshots.cacheMisses,
      note: 'Reconnect dedupe reuse is low relative to restore demand in this run.',
    });
  }
  if (diagnosticsRollup.ptyInput.maxQueuedChars >= 64 * 1024) {
    suspects.push({
      area: 'pty-input',
      metric: 'maxQueuedChars',
      value: diagnosticsRollup.ptyInput.maxQueuedChars,
      note: 'PTY input batching is carrying substantial queued text during at least one phase.',
    });
  }
  if ((summary.phases.lateJoin?.lateJoinClients?.maxReadyMs ?? 0) >= 5_000) {
    suspects.push({
      area: 'late-join',
      metric: 'maxReadyMs',
      value: summary.phases.lateJoin.lateJoinClients.maxReadyMs,
      note: 'Late joiners are becoming usable slowly even though the core transport counters stay mostly quiet.',
    });
  }
  if ((summary.phases.lateJoin?.existingClientImpact?.maxSkewMs ?? 0) >= 1_500) {
    suspects.push({
      area: 'late-join',
      metric: 'existingClientImpact.maxSkewMs',
      value: summary.phases.lateJoin.existingClientImpact.maxSkewMs,
      note: 'Existing viewers saw measurable live-output skew while late join replay was in flight.',
    });
  }

  if (suspects.length === 0) {
    suspects.push({
      area: 'none',
      metric: 'none',
      value: 0,
      note: 'No obvious bottleneck counters spiked in this run.',
    });
  }

  return suspects;
}

async function writeSummaryArtifact(outputJsonPath, summary) {
  const artifactPath = path.resolve(ROOT_DIR, outputJsonPath);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return artifactPath;
}

function formatBudgetSummary(evaluation) {
  if (!evaluation) {
    return null;
  }

  const failedChecks = evaluation.checks.filter((check) => !check.pass);
  if (failedChecks.length === 0) {
    return `profile=${evaluation.profileName} budgets=pass`;
  }

  return `profile=${evaluation.profileName} budgets=fail failed=${failedChecks
    .map((check) => `${check.label}:${check.actual}`)
    .join(',')}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const serverTarget = await startServerTarget(options);
  const taskId = createTaskId();
  const agents = Array.from({ length: options.terminals }, (_, index) => ({
    agentId: `stress-agent-${index}-${Date.now()}`,
    channelId: createChannelId(),
  }));
  const summary = {
    config: options,
    phases: {},
    port: serverTarget.port,
    taskId,
    target: serverTarget.baseUrl,
  };

  const allClients = [];

  try {
    const authStartedAt = performance.now();
    const clientStates = Array.from({ length: options.users }, (_, index) =>
      createClientState(`user-${index}`),
    );
    const initialClients = await Promise.all(
      clientStates.map((clientState) => connectClient(serverTarget, clientState)),
    );
    allClients.push(...initialClients);
    summary.phases.authMs = performance.now() - authStartedAt;

    const channelIds = agents.map((agent) => agent.channelId);
    const primaryClient = initialClients[0];
    const spawnStartedAt = performance.now();
    await bindClientToChannels(primaryClient, channelIds);
    for (const agent of agents) {
      await spawnAgent(serverTarget, taskId, agent);
      await waitForChannelMarker(primaryClient, agent.channelId, createReadyMarker(agent.agentId));
    }
    summary.phases.spawnMs = performance.now() - spawnStartedAt;

    const bindStartedAt = performance.now();
    await Promise.all(
      initialClients.slice(1).map((client) => bindClientToChannels(client, channelIds)),
    );
    summary.phases.initialBindMs = performance.now() - bindStartedAt;

    summary.phases.output = await runOutputPhase(
      serverTarget,
      initialClients,
      agents,
      'output-1',
      options.lines,
      options.outputLineBytes,
    );

    summary.phases.input = await runInputPhase(
      serverTarget,
      initialClients,
      agents,
      'input-1',
      options.inputChunks,
      options.inputChunkBytes,
    );

    summary.phases.mixed = await runMixedPhase(
      serverTarget,
      initialClients,
      agents,
      'mixed-1',
      options.mixedLines,
      options.mixedLineBytes,
      options.inputChunks,
      options.inputChunkBytes,
    );

    const reconnectOutputBursts = [];
    let activeClients = [...initialClients];
    let activeClientStates = [...clientStates];
    for (let reconnectIndex = 0; reconnectIndex < options.reconnects; reconnectIndex += 1) {
      const staleClient = activeClients.pop();
      const reconnectingState = activeClientStates.pop();
      if (!reconnectingState) {
        throw new Error('Missing reconnect client state');
      }
      activeClientStates.push(reconnectingState);
      const reconnectBurst = await runReconnectOutputBurst(
        serverTarget,
        activeClients,
        reconnectingState,
        staleClient,
        agents,
        channelIds,
        `reconnect-${reconnectIndex + 1}`,
        options.lines,
        options.outputLineBytes,
      );
      const replacementClient = activeClients[activeClients.length - 1];
      if (replacementClient) {
        allClients.push(replacementClient);
      }

      reconnectOutputBursts.push(reconnectBurst);
    }
    summary.phases.reconnectOutputBursts = reconnectOutputBursts;

    summary.phases.warmScrollback = await runOutputPhase(
      serverTarget,
      activeClients,
      agents,
      'warm-scrollback',
      options.warmScrollbackLines,
      options.warmScrollbackLineBytes,
    );

    summary.phases.lateJoin = await runLateJoinScrollbackPhase(
      serverTarget,
      activeClients,
      allClients,
      agents,
      options.warmScrollbackLines,
      options.lateJoiners,
      options.lateJoinLiveLines,
      options.lateJoinLiveLineBytes,
    );

    const diagnosticsRollup = createDiagnosticsRollup(summary);
    const topSuspects = createTopSuspects(summary, diagnosticsRollup);
    const evaluation = options.profile
      ? evaluateSessionStressProfile(options.profile, summary)
      : null;

    summary.analysis = {
      diagnosticsRollup,
      topSuspects,
    };
    summary.meta = createRunMetadata(options);
    summary.evaluation = evaluation;

    let artifactPath = null;
    if (options.outputJsonPath) {
      artifactPath = await writeSummaryArtifact(options.outputJsonPath, summary);
    }

    if (!options.quiet) {
      console.log(JSON.stringify(summary, null, 2));
    }

    const budgetSummary = formatBudgetSummary(summary.evaluation);
    const artifactSuffix = artifactPath ? ` artifact=${artifactPath}` : '';
    console.log(
      `[session-stress] target=${serverTarget.baseUrl} users=${options.users} terminals=${options.terminals} output=${summary.phases.output.wallClockMs.toFixed(1)}ms input=${summary.phases.input.wallClockMs.toFixed(1)}ms mixed=${summary.phases.mixed.wallClockMs.toFixed(1)}ms lateJoin=${summary.phases.lateJoin.wallClockMs.toFixed(1)}ms${budgetSummary ? ` ${budgetSummary}` : ''}${artifactSuffix}`,
    );

    for (const suspect of topSuspects.slice(0, 3)) {
      console.log(
        `[session-stress] suspect area=${suspect.area} metric=${suspect.metric} value=${suspect.value} note=${suspect.note}`,
      );
    }

    if (options.failOnBudget && evaluation && !evaluation.pass) {
      throw new Error(budgetSummary ?? 'Session stress profile failed budgets');
    }
  } finally {
    await Promise.allSettled(agents.map((agent) => killAgent(serverTarget, agent.agentId)));
    for (const client of allClients) {
      try {
        client.close();
      } catch {
        // Ignore best-effort close failures during teardown.
      }
    }
    await serverTarget.stop();
  }
}

await main();
