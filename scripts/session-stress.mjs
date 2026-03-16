import { randomUUID } from 'crypto';
import { execSync, spawn } from 'child_process';
import { Buffer } from 'buffer';
import { createServer } from 'net';
import { performance } from 'perf_hooks';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.resolve(ROOT_DIR, 'dist-server', 'server', 'main.js');
const DEFAULT_TOKEN = `stress-token-${Date.now()}`;
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
    reconnects: 1,
    skipBuild: false,
    terminals: 12,
    users: 3,
    warmScrollbackLineBytes: 2048,
    warmScrollbackLines: 60,
  };

  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--users':
        options.users = Number(next);
        index += 1;
        break;
      case '--browser-channel-backpressure-drain-interval-ms':
        options.browserChannelBackpressureDrainIntervalMs = Number(next);
        index += 1;
        break;
      case '--browser-channel-client-degraded-max-drain-passes':
        options.browserChannelClientDegradedMaxDrainPasses = Number(next);
        index += 1;
        break;
      case '--browser-channel-client-degraded-max-queue-age-ms':
        options.browserChannelClientDegradedMaxQueueAgeMs = Number(next);
        index += 1;
        break;
      case '--browser-channel-client-degraded-max-queued-bytes':
        options.browserChannelClientDegradedMaxQueuedBytes = Number(next);
        index += 1;
        break;
      case '--browser-channel-coalesced-data-max-bytes':
        options.browserChannelCoalescedDataMaxBytes = Number(next);
        index += 1;
        break;
      case '--terminals':
        options.terminals = Number(next);
        index += 1;
        break;
      case '--lines':
        options.lines = Number(next);
        index += 1;
        break;
      case '--output-line-bytes':
        options.outputLineBytes = Number(next);
        index += 1;
        break;
      case '--input-chunks':
        options.inputChunks = Number(next);
        index += 1;
        break;
      case '--input-chunk-bytes':
        options.inputChunkBytes = Number(next);
        index += 1;
        break;
      case '--mixed-lines':
        options.mixedLines = Number(next);
        index += 1;
        break;
      case '--mixed-line-bytes':
        options.mixedLineBytes = Number(next);
        index += 1;
        break;
      case '--reconnects':
        options.reconnects = Number(next);
        index += 1;
        break;
      case '--late-joiners':
        options.lateJoiners = Number(next);
        index += 1;
        break;
      case '--late-join-live-lines':
        options.lateJoinLiveLines = Number(next);
        index += 1;
        break;
      case '--late-join-live-line-bytes':
        options.lateJoinLiveLineBytes = Number(next);
        index += 1;
        break;
      case '--warm-scrollback-lines':
        options.warmScrollbackLines = Number(next);
        index += 1;
        break;
      case '--warm-scrollback-line-bytes':
        options.warmScrollbackLineBytes = Number(next);
        index += 1;
        break;
      case '--latency-ms':
        options.latencyMs = Number(next);
        index += 1;
        break;
      case '--jitter-ms':
        options.jitterMs = Number(next);
        index += 1;
        break;
      case '--packet-loss':
        options.packetLoss = Number(next);
        index += 1;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/session-stress.mjs [options]

Options:
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
  --packet-loss <n>          Simulated control-plane packet loss as 0-1 (default: 0)
  --skip-build               Reuse the existing dist-server build instead of recompiling it
`);
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

function isResetRequiredMessage(message) {
  return (
    message &&
    message.type === 'channel' &&
    typeof message.channelId === 'string' &&
    typeof message.payload === 'object' &&
    message.payload !== null &&
    message.payload.type === 'ResetRequired'
  );
}

function createChannelId() {
  return randomUUID();
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

async function startServer(options) {
  if (!options.skipBuild) {
    execSync('npx tsc -p server/tsconfig.json', {
      cwd: ROOT_DIR,
      stdio: 'pipe',
    });
  }

  const port = await reservePort();
  const env = {
    ...process.env,
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
    PORT: String(port),
    AUTH_TOKEN: DEFAULT_TOKEN,
    PARALLEL_CODE_USER_DATA_DIR: path.resolve(ROOT_DIR, '.stress-server-data'),
    SIMULATE_LATENCY_MS: String(options.latencyMs),
    SIMULATE_JITTER_MS: String(options.jitterMs),
    SIMULATE_PACKET_LOSS: String(options.packetLoss),
  };

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

  return {
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

async function connectClient(port, clientState) {
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${DEFAULT_TOKEN}`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting client ${clientState.label}`));
    }, 10_000);

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: DEFAULT_TOKEN,
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

async function invokeIpc(port, channel, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${channel}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEFAULT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${channel} failed (${response.status}): ${payload.error ?? 'unknown error'}`);
  }

  return payload.result;
}

async function spawnAgent(port, agent) {
  await invokeIpc(port, 'spawn_agent', {
    agentId: agent.agentId,
    args: ['-e', SYNTHETIC_TUI_AGENT_SOURCE],
    cols: 80,
    command: process.execPath,
    cwd: '/tmp',
    env: {
      STRESS_READY_MARKER: createReadyMarker(agent.agentId),
    },
    isShell: false,
    onOutput: { __CHANNEL_ID__: agent.channelId },
    rows: 24,
    taskId: 'stress-task',
  });
}

async function killAgent(port, agentId) {
  await invokeIpc(port, 'kill_agent', { agentId });
}

async function resetBackendDiagnostics(port) {
  await invokeIpc(port, 'reset_backend_runtime_diagnostics');
}

async function getBackendDiagnostics(port) {
  return invokeIpc(port, 'get_backend_runtime_diagnostics');
}

async function getScrollbackBatch(port, agentIds) {
  return invokeIpc(port, 'get_scrollback_batch', { agentIds });
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
      if (isResetRequiredMessage(message)) {
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

function createMarkerWatcher(ws, markersByChannel, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    const seen = new Map();
    let messageCount = 0;
    let bytes = 0;
    const resetChannels = new Set();
    let resetMarkerCount = 0;
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
      if (isResetRequiredMessage(message)) {
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

      for (const [marker, channelId] of markersByChannel.entries()) {
        if (seen.has(marker) || channelId !== message.channelId || !text.includes(marker)) {
          continue;
        }

        seen.set(marker, performance.now() - startTime);
        if (seen.size === markersByChannel.size) {
          cleanup();
          resolve({
            bytes,
            durationMs: performance.now() - startTime,
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

function createPhaseSummary(diagnostics, maxBufferedAmountByClient, results, startedAt, sentBytes) {
  const summary = {
    diagnostics,
    maxClientBufferedAmountBytes: getMaxBufferedAmount(maxBufferedAmountByClient),
    metrics: summarizeWatcherResults(results),
    wallClockMs: performance.now() - startedAt,
  };

  if (typeof sentBytes === 'number') {
    return {
      ...summary,
      sentBytes,
    };
  }

  return summary;
}

async function createSkippedPhaseSummary(port) {
  await resetBackendDiagnostics(port);
  const diagnostics = await getBackendDiagnostics(port);
  return {
    diagnostics,
    maxClientBufferedAmountBytes: 0,
    metrics: {
      avgDurationMs: 0,
      maxDurationMs: 0,
      maxSkewMs: 0,
      p95SkewMs: 0,
      totalBytes: 0,
      totalMessages: 0,
      totalResetChannels: 0,
      totalResetMarkers: 0,
    },
    sentBytes: 0,
    skipped: true,
    wallClockMs: 0,
  };
}

async function runMeasuredPhase(port, clients, markersByChannel, timeoutMs, performWrites) {
  const watchers = createPhaseWatchers(clients, markersByChannel, timeoutMs);
  const maxBufferedAmountByClient = new Map();

  await resetBackendDiagnostics(port);
  const startedAt = performance.now();
  const sentBytes = await performWrites(maxBufferedAmountByClient);
  const results = await Promise.all(watchers);
  const diagnostics = await getBackendDiagnostics(port);

  return createPhaseSummary(diagnostics, maxBufferedAmountByClient, results, startedAt, sentBytes);
}

async function runOutputPhase(port, clients, agents, phaseId, lineCount, lineBytes) {
  if (lineCount <= 0) {
    return createSkippedPhaseSummary(port);
  }

  return runMeasuredPhase(
    port,
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

async function runInputPhase(port, clients, agents, phaseId, chunkCount, chunkBytes) {
  if (chunkCount <= 0) {
    return createSkippedPhaseSummary(port);
  }

  return runMeasuredPhase(
    port,
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
  port,
  clients,
  agents,
  phaseId,
  outputLineCount,
  outputLineBytes,
  inputChunkCount,
  inputChunkBytes,
) {
  if (outputLineCount <= 0) {
    return createSkippedPhaseSummary(port);
  }

  return runMeasuredPhase(
    port,
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
  port,
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
      ...(await createSkippedPhaseSummary(port)),
      connectAndBindMs: 0,
      replay: {
        requestCount: 0,
        totalReturnedBytes: 0,
        wallClockMs: 0,
      },
    };
  }

  const lateJoinStates = Array.from({ length: lateJoinerCount }, (_, index) =>
    createClientState(`late-join-${index}`),
  );
  const channelIds = agents.map((agent) => agent.channelId);
  const connectAndBindStartedAt = performance.now();
  const lateJoinClients = await Promise.all(
    lateJoinStates.map((clientState) => connectClient(port, clientState)),
  );
  allClients.push(...lateJoinClients);
  const lateJoinResetChannelIdsByClient = await Promise.all(
    lateJoinClients.map((client) => bindClientToChannels(client, channelIds)),
  );
  const connectAndBindMs = performance.now() - connectAndBindStartedAt;
  const lateJoinReplayAgentIdsByClient = lateJoinResetChannelIdsByClient.map(
    (channelIdsForClient) => getReplayAgentIds(agents, channelIdsForClient),
  );

  const combinedClients = [...existingClients, ...lateJoinClients];
  let replayDurationMs = 0;
  let returnedBytes = 0;

  const phaseSummary = await runMeasuredPhase(
    port,
    combinedClients,
    createOutputMarkersByChannel(agents, 'late-join-live'),
    30_000,
    async (maxBufferedAmountByClient) => {
      const replayStartedAt = performance.now();
      const scrollbackBatchPromise = Promise.all(
        lateJoinReplayAgentIdsByClient.map((ids) => getScrollbackBatch(port, ids)),
      );

      for (const [agentIndex, agent] of agents.entries()) {
        const writerClient = getAgentWriterClient(existingClients, agentIndex);
        sendTrackedAgentInput(
          writerClient,
          combinedClients,
          maxBufferedAmountByClient,
          agent.agentId,
          createStartOutputLine('late-join-live', agent.agentId, liveLineCount, liveLineBytes),
        );
      }

      const scrollbackBatches = await scrollbackBatchPromise;
      replayDurationMs = performance.now() - replayStartedAt;
      returnedBytes = scrollbackBatches.reduce(
        (total, entries) => total + getTotalScrollbackBytes(entries),
        0,
      );
    },
  );

  return {
    ...phaseSummary,
    connectAndBindMs,
    replay: {
      requestCount: lateJoinReplayAgentIdsByClient.length,
      totalReturnedBytes: returnedBytes,
      wallClockMs: replayDurationMs,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = await startServer(options);
  const agents = Array.from({ length: options.terminals }, (_, index) => ({
    agentId: `stress-agent-${index}-${Date.now()}`,
    channelId: createChannelId(),
  }));
  const summary = {
    config: options,
    phases: {},
    port: server.port,
  };

  const allClients = [];

  try {
    const authStartedAt = performance.now();
    const clientStates = Array.from({ length: options.users }, (_, index) =>
      createClientState(`user-${index}`),
    );
    const initialClients = await Promise.all(
      clientStates.map((clientState) => connectClient(server.port, clientState)),
    );
    allClients.push(...initialClients);
    summary.phases.authMs = performance.now() - authStartedAt;

    const channelIds = agents.map((agent) => agent.channelId);
    const primaryClient = initialClients[0];
    const spawnStartedAt = performance.now();
    await bindClientToChannels(primaryClient, channelIds);
    for (const agent of agents) {
      await spawnAgent(server.port, agent);
      await waitForChannelMarker(primaryClient, agent.channelId, createReadyMarker(agent.agentId));
    }
    summary.phases.spawnMs = performance.now() - spawnStartedAt;

    const bindStartedAt = performance.now();
    await Promise.all(
      initialClients.slice(1).map((client) => bindClientToChannels(client, channelIds)),
    );
    summary.phases.initialBindMs = performance.now() - bindStartedAt;

    summary.phases.output = await runOutputPhase(
      server.port,
      initialClients,
      agents,
      'output-1',
      options.lines,
      options.outputLineBytes,
    );

    summary.phases.input = await runInputPhase(
      server.port,
      initialClients,
      agents,
      'input-1',
      options.inputChunks,
      options.inputChunkBytes,
    );

    summary.phases.mixed = await runMixedPhase(
      server.port,
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
      const reconnectStartedAt = performance.now();
      const staleClient = activeClients.pop();
      const reconnectingState = activeClientStates.pop();
      staleClient?.close();
      if (!reconnectingState) {
        throw new Error('Missing reconnect client state');
      }
      const replacement = await connectClient(server.port, reconnectingState);
      allClients.push(replacement);
      activeClients.push(replacement);
      activeClientStates.push(reconnectingState);
      await bindClientToChannels(replacement, channelIds);
      await getScrollbackBatch(server.port, getAgentIds(agents));

      reconnectOutputBursts.push({
        reconnectMs: performance.now() - reconnectStartedAt,
        ...(await runOutputPhase(
          server.port,
          activeClients,
          agents,
          `reconnect-${reconnectIndex + 1}`,
          options.lines,
          options.outputLineBytes,
        )),
      });
    }
    summary.phases.reconnectOutputBursts = reconnectOutputBursts;

    summary.phases.warmScrollback = await runOutputPhase(
      server.port,
      activeClients,
      agents,
      'warm-scrollback',
      options.warmScrollbackLines,
      options.warmScrollbackLineBytes,
    );

    summary.phases.lateJoin = await runLateJoinScrollbackPhase(
      server.port,
      activeClients,
      allClients,
      agents,
      options.warmScrollbackLines,
      options.lateJoiners,
      options.lateJoinLiveLines,
      options.lateJoinLiveLineBytes,
    );

    console.log(JSON.stringify(summary, null, 2));
    console.log(
      `[session-stress] users=${options.users} terminals=${options.terminals} output=${summary.phases.output.wallClockMs.toFixed(1)}ms input=${summary.phases.input.wallClockMs.toFixed(1)}ms mixed=${summary.phases.mixed.wallClockMs.toFixed(1)}ms lateJoin=${summary.phases.lateJoin.wallClockMs.toFixed(1)}ms`,
    );
  } finally {
    await Promise.allSettled(agents.map((agent) => killAgent(server.port, agent.agentId)));
    for (const client of allClients) {
      try {
        client.close();
      } catch {
        // Ignore best-effort close failures during teardown.
      }
    }
    await server.stop();
  }
}

await main();
