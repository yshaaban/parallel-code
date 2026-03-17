import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { WebSocket } from 'ws';
import { MAX_CLIENT_INPUT_DATA_LENGTH } from '../electron/remote/protocol.js';
import type { BackendRuntimeDiagnosticsSnapshot } from '../electron/ipc/runtime-diagnostics.js';
import { splitTerminalInputChunks } from '../src/lib/terminal-input-batching.js';
import {
  channelMessageContains,
  createChannelId,
  expectNoMessage,
  getServerUrl,
  getChannelText,
  invokeIpcViaHttp,
  killAgentViaHttp,
  parseServerMessage,
  sendJson,
  spawnAgentViaHttp,
  startServer,
  stopServer,
  TEST_TOKEN,
  trackSocketMessages,
  waitForMessage,
  waitForSocketClose,
  writeToAgentViaHttp,
  type WsMessageData,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TERMINAL_COUNT = 8;
const USER_COUNT = 3;
const BURST_LINE_COUNT = 20;
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

interface StressAgent {
  agentId: string;
  channelId: string;
}

interface StressClientState {
  clientId: string;
  lastSeq: number;
  label: string;
}

interface MarkerTimings {
  byMarker: Map<string, number>;
  durationMs: number;
}

interface ScrollbackBatchEntry {
  agentId: string;
  cols: number;
  scrollback: string | null;
}

interface TaskCommandControllersResult {
  controllers: Array<{
    action: string | null;
    controllerId: string | null;
    taskId: string;
    version: number;
  }>;
}

function createStressAgents(prefix: string, count: number): StressAgent[] {
  return Array.from({ length: count }, (_, index) => ({
    agentId: `${prefix}-agent-${index}`,
    channelId: createChannelId(),
  }));
}

function getAgentIds(agents: StressAgent[]): string[] {
  return agents.map((agent) => agent.agentId);
}

function getAgentIdsForChannelIds(agents: StressAgent[], channelIds: Set<string>): string[] {
  const agentIdByChannelId = new Map(agents.map((agent) => [agent.channelId, agent.agentId]));
  return Array.from(
    new Set(
      Array.from(channelIds, (channelId) => agentIdByChannelId.get(channelId)).filter(
        (agentId): agentId is string => typeof agentId === 'string',
      ),
    ),
  );
}

function getReplayAgentIds(agents: StressAgent[], resetChannelIds: Set<string>): string[] {
  const resetAgentIds = getAgentIdsForChannelIds(agents, resetChannelIds);
  if (resetAgentIds.length > 0) {
    return resetAgentIds;
  }

  return getAgentIds(agents);
}

function isResetRequiredMessage(message: unknown): message is {
  channelId: string;
  payload: { type: 'ResetRequired' };
  type: 'channel';
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'channel' &&
    'channelId' in message &&
    typeof message.channelId === 'string' &&
    'payload' in message &&
    typeof message.payload === 'object' &&
    message.payload !== null &&
    'type' in message.payload &&
    message.payload.type === 'ResetRequired'
  );
}

function createBurstDoneMarker(burstId: string, agentId: string): string {
  return `__SESSION_STRESS_DONE_${burstId}_${agentId}__`;
}

function createReadyMarker(agentId: string): string {
  return `__SESSION_STRESS_READY_${agentId}__`;
}

function createOutputDoneMarker(phaseId: string, agentId: string): string {
  return `__SESSION_STRESS_OUTPUT_DONE_${phaseId}_${agentId}__`;
}

function createInputDoneMarker(phaseId: string, agentId: string): string {
  return `__SESSION_STRESS_INPUT_DONE_${phaseId}_${agentId}__`;
}

function createBurstCommand(burstId: string, agentId: string, lineCount: number): string {
  const doneMarker = createBurstDoneMarker(burstId, agentId);
  return `for i in $(seq 1 ${lineCount}); do echo "${burstId}:${agentId}:$i"; done; echo "${doneMarker}"\n`;
}

function createStartOutputLine(
  phaseId: string,
  agentId: string,
  lineCount: number,
  lineBytes: number,
): string {
  return `${STRESS_CONTROL_PREFIX}${JSON.stringify({
    doneMarker: createOutputDoneMarker(phaseId, agentId),
    lineBytes,
    lineCount,
    prefix: `${phaseId}:${agentId}`,
    type: 'start-output',
  })}\n`;
}

function createInputChunk(
  phaseId: string,
  agentId: string,
  writerIndex: number,
  chunkIndex: number,
  chunkBytes: number,
): string {
  const prefix = `${phaseId}:${agentId}:${writerIndex}:${chunkIndex}:`;
  const payloadBytes = Math.max(0, chunkBytes - Buffer.byteLength(prefix));
  return `${prefix}${'I'.repeat(payloadBytes)}\n`;
}

async function resetBackendDiagnostics(): Promise<void> {
  await invokeIpcViaHttp('reset_backend_runtime_diagnostics', undefined);
}

async function getBackendDiagnostics(): Promise<BackendRuntimeDiagnosticsSnapshot> {
  return invokeIpcViaHttp<BackendRuntimeDiagnosticsSnapshot>(
    'get_backend_runtime_diagnostics',
    undefined,
  );
}

async function getScrollbackBatch(agentIds: string[]): Promise<ScrollbackBatchEntry[]> {
  return invokeIpcViaHttp<ScrollbackBatchEntry[]>('get_scrollback_batch', { agentIds });
}

function getTotalScrollbackBytes(entries: ScrollbackBatchEntry[]): number {
  return entries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.scrollback ?? '', 'base64'),
    0,
  );
}

function createStressClientState(label: string): StressClientState {
  return {
    clientId: `session-stress-${label}-${Date.now()}`,
    label,
    lastSeq: -1,
  };
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function getTaskControllerId(taskId: string): Promise<string | null> {
  const result = await invokeIpcViaHttp<TaskCommandControllersResult>(
    'get_task_command_controllers',
    undefined,
  );
  return (
    result.controllers.find((controller) => controller.taskId === taskId)?.controllerId ?? null
  );
}

async function waitForTaskControllerId(
  taskId: string,
  controllerId: string | null,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await getTaskControllerId(taskId)) === controllerId) {
      return;
    }

    await waitForDelay(25);
  }

  throw new Error(`Timed out waiting for task controller ${controllerId ?? 'null'} on ${taskId}`);
}

async function acquireTaskControl(
  taskId: string,
  clientId: string,
  options: {
    takeover?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await invokeIpcViaHttp<{
      action: string | null;
      acquired: boolean;
      controllerId: string | null;
      taskId: string;
      version: number;
    }>('acquire_task_command_lease', {
      action: 'type in the terminal',
      clientId,
      taskId,
      ...(options.takeover ? { takeover: true } : {}),
    });

    if (result.acquired && result.controllerId === clientId) {
      return;
    }

    await waitForDelay(25);
  }

  throw new Error(`Timed out acquiring task control for ${clientId} on ${taskId}`);
}

async function releaseTaskControl(taskId: string, clientId: string): Promise<void> {
  await invokeIpcViaHttp('release_task_command_lease', {
    clientId,
    taskId,
  });
}

async function waitForAcceptedInput(
  ws: WebSocket,
  options: {
    agentId: string;
    requestId: string;
  },
): Promise<void> {
  const ackPromise = waitForMessage(
    ws,
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'agent-command-result' &&
      'agentId' in message &&
      message.agentId === options.agentId &&
      'command' in message &&
      message.command === 'input' &&
      'requestId' in message &&
      message.requestId === options.requestId,
    10_000,
  );

  sendJson(ws, {
    type: 'input',
    agentId: options.agentId,
    data: `echo ${options.requestId}\n`,
    requestId: options.requestId,
  });

  await expect(ackPromise).resolves.toMatchObject({
    accepted: true,
    agentId: options.agentId,
    command: 'input',
    requestId: options.requestId,
    type: 'agent-command-result',
  });
}

async function waitForRejectedInput(
  ws: WebSocket,
  options: {
    agentId: string;
    channelId: string;
    marker: string;
    requestId: string;
  },
): Promise<void> {
  const rejectionPromise = waitForMessage(
    ws,
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'agent-command-result' &&
      'agentId' in message &&
      message.agentId === options.agentId &&
      'command' in message &&
      message.command === 'input' &&
      'requestId' in message &&
      message.requestId === options.requestId,
    10_000,
  );

  sendJson(ws, {
    type: 'input',
    agentId: options.agentId,
    data: `echo ${options.marker}\n`,
    requestId: options.requestId,
  });

  await expect(rejectionPromise).resolves.toMatchObject({
    accepted: false,
    agentId: options.agentId,
    command: 'input',
    requestId: options.requestId,
    type: 'agent-command-result',
  });
  await expectNoMessage(
    ws,
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      channelMessageContains(message, options.channelId, options.marker),
    300,
  );
}

async function waitForAcceptedResize(
  ws: WebSocket,
  options: {
    agentId: string;
    cols: number;
    rows: number;
    requestId: string;
  },
): Promise<void> {
  const ackPromise = waitForMessage(
    ws,
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'agent-command-result' &&
      'agentId' in message &&
      message.agentId === options.agentId &&
      'command' in message &&
      message.command === 'resize' &&
      'requestId' in message &&
      message.requestId === options.requestId,
    10_000,
  );

  sendJson(ws, {
    type: 'resize',
    agentId: options.agentId,
    cols: options.cols,
    rows: options.rows,
    requestId: options.requestId,
  });

  await expect(ackPromise).resolves.toMatchObject({
    accepted: true,
    agentId: options.agentId,
    command: 'resize',
    requestId: options.requestId,
    type: 'agent-command-result',
  });
}

async function waitForRejectedResize(
  ws: WebSocket,
  options: {
    agentId: string;
    cols: number;
    rows: number;
    requestId: string;
  },
): Promise<void> {
  const rejectionPromise = waitForMessage(
    ws,
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'agent-command-result' &&
      'agentId' in message &&
      message.agentId === options.agentId &&
      'command' in message &&
      message.command === 'resize' &&
      'requestId' in message &&
      message.requestId === options.requestId,
    10_000,
  );

  sendJson(ws, {
    type: 'resize',
    agentId: options.agentId,
    cols: options.cols,
    rows: options.rows,
    requestId: options.requestId,
  });

  await expect(rejectionPromise).resolves.toMatchObject({
    accepted: false,
    agentId: options.agentId,
    command: 'resize',
    requestId: options.requestId,
    type: 'agent-command-result',
  });
}

function recordClientLastSeq(clientState: StressClientState, message: unknown): void {
  if (typeof message !== 'object' || message === null || !('seq' in message)) {
    return;
  }

  const seq = message.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq)) {
    return;
  }

  if (seq > clientState.lastSeq) {
    clientState.lastSeq = seq;
  }
}

function sendAgentInput(ws: WebSocket, agentId: string, data: string): void {
  for (const chunk of splitTerminalInputChunks(data, MAX_CLIENT_INPUT_DATA_LENGTH)) {
    sendJson(ws, { type: 'input', agentId, data: chunk.data });
  }
}

async function connectAuthenticatedClient(clientState: StressClientState): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${getServerUrl()}/ws?token=${TEST_TOKEN}`);
    trackSocketMessages(ws);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection timeout for ${clientState.label}`));
    }, 5_000);

    ws.on('open', () => {
      sendJson(ws, {
        type: 'auth',
        token: TEST_TOKEN,
        clientId: clientState.clientId,
        lastSeq: clientState.lastSeq,
      });
    });

    ws.on('message', (data: WsMessageData, isBinary: boolean) => {
      const message = parseServerMessage(data, isBinary);
      recordClientLastSeq(clientState, message);
      if (message?.type !== 'agents' || !Array.isArray(message.list)) {
        return;
      }

      clearTimeout(timeout);
      resolve(ws);
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function bindClientToChannels(ws: WebSocket, channelIds: string[]): Promise<Set<string>> {
  const pending = new Set(channelIds);
  const resetRequiredChannelIds = new Set<string>();
  const completion = new Promise<Set<string>>((resolve, reject) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out binding ${pending.size} channel(s): ${Array.from(pending).join(', ')}`,
        ),
      );
    }, 10_000);

    function cleanup(): void {
      clearTimeout(timeout);
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      ws.removeListener('message', handleMessage);
    }

    function settleIfReady(): void {
      if (pending.size !== 0 || settleTimer) {
        return;
      }

      settleTimer = setTimeout(() => {
        cleanup();
        resolve(resetRequiredChannelIds);
      }, 0);
    }

    function handleMessage(data: WsMessageData, isBinary: boolean): void {
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

    ws.on('message', handleMessage);
  });

  for (const channelId of channelIds) {
    sendJson(ws, { type: 'bind-channel', channelId });
  }

  return completion;
}

async function waitForChannelMarker(
  ws: WebSocket,
  channelId: string,
  marker: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitForMessage(
    ws,
    (message) =>
      message.type === 'channel' &&
      message.channelId === channelId &&
      (getChannelText(message, channelId)?.includes(marker) ?? false),
    timeoutMs,
  );
}

function waitForDoneMarkers(
  ws: WebSocket,
  expectedMarkers: Map<string, string>,
  timeoutMs: number,
): Promise<MarkerTimings> {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    const seen = new Map<string, number>();
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${expectedMarkers.size - seen.size} marker(s): ${Array.from(
            expectedMarkers.keys(),
          )
            .filter((marker) => !seen.has(marker))
            .join(', ')}`,
        ),
      );
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timeout);
      ws.removeListener('message', handleMessage);
    }

    function handleMessage(data: WsMessageData, isBinary: boolean): void {
      const message = parseServerMessage(data, isBinary);
      if (!message?.channelId) {
        return;
      }

      const text = getChannelText(message, message.channelId);
      if (!text) {
        return;
      }

      for (const [marker, channelId] of expectedMarkers.entries()) {
        if (seen.has(marker) || channelId !== message.channelId || !text.includes(marker)) {
          continue;
        }

        seen.set(marker, performance.now() - startTime);
        if (seen.size === expectedMarkers.size) {
          cleanup();
          resolve({
            byMarker: seen,
            durationMs: performance.now() - startTime,
          });
        }
      }
    }

    ws.on('message', handleMessage);
  });
}

function getMarkerSkews(timings: MarkerTimings[]): number[] {
  const allMarkers = Array.from(timings[0]?.byMarker.keys() ?? []);
  return allMarkers.map((marker) => {
    const samples = timings
      .map((timing) => timing.byMarker.get(marker))
      .filter((value): value is number => typeof value === 'number');
    return Math.max(...samples) - Math.min(...samples);
  });
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return sorted[index] ?? 0;
}

async function runBurst(
  clients: WebSocket[],
  agents: StressAgent[],
  burstId: string,
): Promise<{
  markerSkewsMs: number[];
  maxSkewMs: number;
  p95SkewMs: number;
  totalDurationMs: number;
}> {
  const expectedMarkers = new Map(
    agents.map((agent) => [createBurstDoneMarker(burstId, agent.agentId), agent.channelId]),
  );
  const watchers = clients.map((client) => waitForDoneMarkers(client, expectedMarkers, 20_000));
  const startTime = performance.now();

  await Promise.all(
    agents.map((agent) =>
      writeToAgentViaHttp(
        agent.agentId,
        createBurstCommand(burstId, agent.agentId, BURST_LINE_COUNT),
      ),
    ),
  );

  const timings = await Promise.all(watchers);
  const totalDurationMs = performance.now() - startTime;
  const markerSkewsMs = getMarkerSkews(timings);

  return {
    markerSkewsMs,
    maxSkewMs: Math.max(...markerSkewsMs),
    p95SkewMs: percentile(markerSkewsMs, 0.95),
    totalDurationMs,
  };
}

describe('Headless session stress', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    execSync('npx tsc -p server/tsconfig.json', {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
    });
    await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer();
  });

  it('fans out terminal bursts across many terminals and multiple users', async () => {
    const agents = createStressAgents(`stress-${Date.now()}`, TERMINAL_COUNT);
    const channelIds = agents.map((agent) => agent.channelId);
    const clientStates = Array.from({ length: USER_COUNT }, (_, index) =>
      createStressClientState(`fanout-${index}`),
    );
    const clients = await Promise.all(
      clientStates.map((clientState) => connectAuthenticatedClient(clientState)),
    );
    const primaryClient = clients[0];

    try {
      await bindClientToChannels(primaryClient, channelIds);

      for (const agent of agents) {
        await spawnAgentViaHttp({
          taskId: 'stress-task',
          agentId: agent.agentId,
          command: '/bin/sh',
          channelId: agent.channelId,
        });
        const readyMarker = createReadyMarker(agent.agentId);
        await writeToAgentViaHttp(agent.agentId, `echo "${readyMarker}"\n`);
        await waitForChannelMarker(primaryClient, agent.channelId, readyMarker, 15_000);
      }

      await Promise.all(clients.slice(1).map((client) => bindClientToChannels(client, channelIds)));

      const firstBurst = await runBurst(clients, agents, 'burst-1');
      console.warn(
        `[session-stress] first burst duration=${firstBurst.totalDurationMs.toFixed(
          1,
        )}ms p95Skew=${firstBurst.p95SkewMs.toFixed(1)}ms maxSkew=${firstBurst.maxSkewMs.toFixed(
          1,
        )}ms users=${USER_COUNT} terminals=${TERMINAL_COUNT}`,
      );

      expect(firstBurst.maxSkewMs).toBeLessThan(5_000);

      const reconnectingClient = clients.pop();
      const reconnectingState = clientStates.pop();
      reconnectingClient?.close();
      expect(reconnectingState).toBeDefined();
      const replacementClient = await connectAuthenticatedClient(
        reconnectingState as StressClientState,
      );
      clients.push(replacementClient);
      clientStates.push(reconnectingState as StressClientState);
      await bindClientToChannels(replacementClient, channelIds);
      await getScrollbackBatch(getAgentIds(agents));

      const secondBurst = await runBurst(clients, agents, 'burst-2');
      console.warn(
        `[session-stress] second burst duration=${secondBurst.totalDurationMs.toFixed(
          1,
        )}ms p95Skew=${secondBurst.p95SkewMs.toFixed(1)}ms maxSkew=${secondBurst.maxSkewMs.toFixed(
          1,
        )}ms users=${clients.length} terminals=${TERMINAL_COUNT}`,
      );

      expect(secondBurst.maxSkewMs).toBeLessThan(5_000);
    } finally {
      await Promise.allSettled(agents.map((agent) => killAgentViaHttp(agent.agentId)));
      for (const client of clients) {
        client.close();
      }
    }
  });

  it('handles oversized browser-style input without tripping the websocket parser limit', async () => {
    const [agent] = createStressAgents(`oversized-${Date.now()}`, 1);
    const clientState = createStressClientState('oversized');
    const client = await connectAuthenticatedClient(clientState);

    try {
      await bindClientToChannels(client, [agent.channelId]);
      await spawnAgentViaHttp({
        taskId: 'stress-task',
        agentId: agent.agentId,
        args: ['-e', SYNTHETIC_TUI_AGENT_SOURCE],
        channelId: agent.channelId,
        command: process.execPath,
        env: {
          STRESS_READY_MARKER: createReadyMarker(agent.agentId),
        },
        isShell: false,
      });
      await waitForChannelMarker(client, agent.channelId, createReadyMarker(agent.agentId));

      const tailMarker = `__SESSION_STRESS_OVERSIZED_TAIL_${Date.now()}__`;
      const oversizedInput = `${'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH + 512)}${tailMarker}\n`;
      sendAgentInput(client, agent.agentId, oversizedInput);

      await waitForChannelMarker(client, agent.channelId, tailMarker, 15_000);
    } finally {
      await Promise.allSettled([killAgentViaHttp(agent.agentId)]);
      client.close();
    }
  });

  it('handles heavy mixed TUI-style output and input across a shared session', async () => {
    const agentCount = 4;
    const outputLineCount = 12;
    const outputLineBytes = 1536;
    const inputChunkCount = 8;
    const inputChunkBytes = 1536;
    const agents = createStressAgents(`mixed-${Date.now()}`, agentCount);
    const channelIds = agents.map((agent) => agent.channelId);
    const clientStates = Array.from({ length: USER_COUNT }, (_, index) =>
      createStressClientState(`mixed-${index}`),
    );
    const clients = await Promise.all(
      clientStates.map((clientState) => connectAuthenticatedClient(clientState)),
    );
    const primaryClient = clients[0];

    try {
      await bindClientToChannels(primaryClient, channelIds);

      for (const agent of agents) {
        await spawnAgentViaHttp({
          taskId: 'stress-task',
          agentId: agent.agentId,
          args: ['-e', SYNTHETIC_TUI_AGENT_SOURCE],
          channelId: agent.channelId,
          command: process.execPath,
          env: {
            STRESS_READY_MARKER: createReadyMarker(agent.agentId),
          },
          isShell: false,
        });
        await waitForChannelMarker(
          primaryClient,
          agent.channelId,
          createReadyMarker(agent.agentId),
        );
      }

      await Promise.all(clients.slice(1).map((client) => bindClientToChannels(client, channelIds)));

      const expectedMarkers = new Map<string, string>();
      for (const agent of agents) {
        expectedMarkers.set(createOutputDoneMarker('mixed', agent.agentId), agent.channelId);
        expectedMarkers.set(createInputDoneMarker('mixed', agent.agentId), agent.channelId);
      }

      const watchers = clients.map((client) => waitForDoneMarkers(client, expectedMarkers, 30_000));
      await resetBackendDiagnostics();
      const startedAt = performance.now();

      for (const [agentIndex, agent] of agents.entries()) {
        const writer = clients[agentIndex % clients.length];
        sendAgentInput(
          writer,
          agent.agentId,
          createStartOutputLine('mixed', agent.agentId, outputLineCount, outputLineBytes),
        );

        for (let chunkIndex = 0; chunkIndex < inputChunkCount; chunkIndex += 1) {
          sendAgentInput(
            writer,
            agent.agentId,
            createInputChunk(
              'mixed',
              agent.agentId,
              agentIndex % clients.length,
              chunkIndex,
              inputChunkBytes,
            ),
          );
        }

        sendAgentInput(writer, agent.agentId, `${createInputDoneMarker('mixed', agent.agentId)}\n`);
      }

      const timings = await Promise.all(watchers);
      const durationMs = performance.now() - startedAt;
      const markerSkewsMs = getMarkerSkews(timings);
      const diagnostics = await getBackendDiagnostics();

      console.warn(
        `[session-stress] mixed duration=${durationMs.toFixed(1)}ms p95Skew=${percentile(
          markerSkewsMs,
          0.95,
        ).toFixed(
          1,
        )}ms maxSkew=${Math.max(...markerSkewsMs).toFixed(1)}ms maxQueuedChars=${diagnostics.ptyInput.maxQueuedChars}`,
      );

      expect(Math.max(...markerSkewsMs)).toBeLessThan(5_000);
      expect(diagnostics.ptyInput.enqueuedMessages).toBeGreaterThan(0);
      expect(diagnostics.ptyInput.flushes).toBeGreaterThan(0);
      expect(diagnostics.ptyInput.maxQueuedChars).toBeGreaterThan(0);
    } finally {
      await Promise.allSettled(agents.map((agent) => killAgentViaHttp(agent.agentId)));
      for (const client of clients) {
        client.close();
      }
    }
  });

  it('maintains correct terminal ownership across repeated handoff, disconnect, and reconnect churn', async () => {
    const taskId = `control-${Date.now()}`;
    const [agent] = createStressAgents(`control-${Date.now()}`, 1);
    const ownerState = createStressClientState('control-owner');
    const observerState = createStressClientState('control-observer');
    const ownerClient = await connectAuthenticatedClient(ownerState);
    let observerClient = await connectAuthenticatedClient(observerState);

    try {
      await bindClientToChannels(ownerClient, [agent.channelId]);
      await bindClientToChannels(observerClient, [agent.channelId]);

      await spawnAgentViaHttp({
        taskId,
        agentId: agent.agentId,
        args: ['-e', SYNTHETIC_TUI_AGENT_SOURCE],
        channelId: agent.channelId,
        command: process.execPath,
        env: {
          STRESS_READY_MARKER: createReadyMarker(agent.agentId),
        },
        isShell: false,
      });
      await waitForChannelMarker(ownerClient, agent.channelId, createReadyMarker(agent.agentId));

      await acquireTaskControl(taskId, ownerState.clientId);
      await waitForTaskControllerId(taskId, ownerState.clientId);

      await waitForAcceptedInput(ownerClient, {
        agentId: agent.agentId,
        requestId: `owner-1-${Date.now()}`,
      });
      await waitForRejectedInput(observerClient, {
        agentId: agent.agentId,
        channelId: agent.channelId,
        marker: `__CONTROL_BLOCKED_1_${Date.now()}__`,
        requestId: `blocked-1-${Date.now()}`,
      });

      await releaseTaskControl(taskId, ownerState.clientId);
      await waitForTaskControllerId(taskId, null);

      await acquireTaskControl(taskId, observerState.clientId);
      await waitForTaskControllerId(taskId, observerState.clientId);
      await waitForAcceptedInput(observerClient, {
        agentId: agent.agentId,
        requestId: `observer-2-${Date.now()}`,
      });

      observerClient.terminate();
      await waitForSocketClose(observerClient);

      await acquireTaskControl(taskId, ownerState.clientId, {
        takeover: true,
        timeoutMs: 10_000,
      });
      await waitForTaskControllerId(taskId, ownerState.clientId);
      await waitForAcceptedInput(ownerClient, {
        agentId: agent.agentId,
        requestId: `owner-3-${Date.now()}`,
      });

      observerClient = await connectAuthenticatedClient(observerState);
      await bindClientToChannels(observerClient, [agent.channelId]);
      await waitForRejectedInput(observerClient, {
        agentId: agent.agentId,
        channelId: agent.channelId,
        marker: `__CONTROL_BLOCKED_3_${Date.now()}__`,
        requestId: `blocked-3-${Date.now()}`,
      });

      expect(await getTaskControllerId(taskId)).toBe(ownerState.clientId);
    } finally {
      await Promise.allSettled([
        killAgentViaHttp(agent.agentId),
        releaseTaskControl(taskId, ownerState.clientId),
        releaseTaskControl(taskId, observerState.clientId),
      ]);

      if (
        ownerClient.readyState === WebSocket.OPEN ||
        ownerClient.readyState === WebSocket.CONNECTING
      ) {
        ownerClient.close();
        await waitForSocketClose(ownerClient).catch(() => {});
      }
      if (
        observerClient.readyState === WebSocket.OPEN ||
        observerClient.readyState === WebSocket.CONNECTING
      ) {
        observerClient.close();
        await waitForSocketClose(observerClient).catch(() => {});
      }
    }
  });

  it('keeps resize authority aligned with task ownership across repeated handoff churn', async () => {
    const taskId = `resize-${Date.now()}`;
    const [agent] = createStressAgents(`resize-${Date.now()}`, 1);
    const ownerState = createStressClientState('resize-owner');
    const observerState = createStressClientState('resize-observer');
    const ownerClient = await connectAuthenticatedClient(ownerState);
    let observerClient = await connectAuthenticatedClient(observerState);

    const resizeRounds = [
      {
        activeClient: ownerClient,
        activeState: ownerState,
        cols: 118,
        passiveClient: observerClient,
      },
      {
        activeClient: observerClient,
        activeState: observerState,
        cols: 92,
        passiveClient: ownerClient,
      },
      {
        activeClient: ownerClient,
        activeState: ownerState,
        cols: 132,
        passiveClient: observerClient,
      },
    ];

    try {
      await bindClientToChannels(ownerClient, [agent.channelId]);
      await bindClientToChannels(observerClient, [agent.channelId]);

      await spawnAgentViaHttp({
        taskId,
        agentId: agent.agentId,
        args: ['-e', SYNTHETIC_TUI_AGENT_SOURCE],
        channelId: agent.channelId,
        command: process.execPath,
        env: {
          STRESS_READY_MARKER: createReadyMarker(agent.agentId),
        },
        isShell: false,
      });
      await waitForChannelMarker(ownerClient, agent.channelId, createReadyMarker(agent.agentId));

      let currentControllerId: string | null = null;
      for (const [roundIndex, round] of resizeRounds.entries()) {
        if (currentControllerId !== null && currentControllerId !== round.activeState.clientId) {
          await releaseTaskControl(taskId, currentControllerId);
          await waitForTaskControllerId(taskId, null);
        }

        await acquireTaskControl(taskId, round.activeState.clientId);
        await waitForTaskControllerId(taskId, round.activeState.clientId);

        const acceptedRequestId = `resize-accepted-${roundIndex}-${Date.now()}`;
        await waitForAcceptedResize(round.activeClient, {
          agentId: agent.agentId,
          cols: round.cols,
          rows: 30,
          requestId: acceptedRequestId,
        });

        const rejectedRequestId = `resize-rejected-${roundIndex}-${Date.now()}`;
        await waitForRejectedResize(round.passiveClient, {
          agentId: agent.agentId,
          cols: round.cols + 7,
          rows: 24,
          requestId: rejectedRequestId,
        });

        const acceptedInputRequestId = `resize-input-${roundIndex}-${Date.now()}`;
        await waitForAcceptedInput(round.activeClient, {
          agentId: agent.agentId,
          requestId: acceptedInputRequestId,
        });

        const rejectedInputRequestId = `resize-blocked-${roundIndex}-${Date.now()}`;
        await waitForRejectedInput(round.passiveClient, {
          agentId: agent.agentId,
          channelId: agent.channelId,
          marker: `__RESIZE_BLOCKED_${roundIndex}_${Date.now()}__`,
          requestId: rejectedInputRequestId,
        });

        currentControllerId = round.activeState.clientId;
      }

      observerClient.close();
      await waitForSocketClose(observerClient);

      await waitForTaskControllerId(taskId, ownerState.clientId);

      observerClient = await connectAuthenticatedClient(observerState);
      await bindClientToChannels(observerClient, [agent.channelId]);
      await waitForRejectedResize(observerClient, {
        agentId: agent.agentId,
        cols: 77,
        rows: 20,
        requestId: `resize-reconnect-rejected-${Date.now()}`,
      });
    } finally {
      await Promise.allSettled([
        killAgentViaHttp(agent.agentId),
        releaseTaskControl(taskId, ownerState.clientId),
        releaseTaskControl(taskId, observerState.clientId),
      ]);

      if (
        ownerClient.readyState === WebSocket.OPEN ||
        ownerClient.readyState === WebSocket.CONNECTING
      ) {
        ownerClient.close();
        await waitForSocketClose(ownerClient).catch(() => {});
      }
      if (
        observerClient.readyState === WebSocket.OPEN ||
        observerClient.readyState === WebSocket.CONNECTING
      ) {
        observerClient.close();
        await waitForSocketClose(observerClient).catch(() => {});
      }
    }
  });

  it('replays warm scrollback for a late joiner without stalling live users', async () => {
    const agentCount = 4;
    const warmScrollbackLineCount = 40;
    const warmScrollbackLineBytes = 1024;
    const liveLineCount = 6;
    const liveLineBytes = 1024;
    const agents = createStressAgents(`late-join-${Date.now()}`, agentCount);
    const channelIds = agents.map((agent) => agent.channelId);
    const existingClientStates = Array.from({ length: 2 }, (_, index) =>
      createStressClientState(`late-join-existing-${index}`),
    );
    const existingClients = await Promise.all(
      existingClientStates.map((clientState) => connectAuthenticatedClient(clientState)),
    );
    const primaryClient = existingClients[0];
    let lateJoinClient: WebSocket | null = null;

    try {
      await bindClientToChannels(primaryClient, channelIds);

      for (const agent of agents) {
        await spawnAgentViaHttp({
          taskId: 'stress-task',
          agentId: agent.agentId,
          args: ['-e', SYNTHETIC_TUI_AGENT_SOURCE],
          channelId: agent.channelId,
          command: process.execPath,
          env: {
            STRESS_READY_MARKER: createReadyMarker(agent.agentId),
          },
          isShell: false,
        });
        await waitForChannelMarker(
          primaryClient,
          agent.channelId,
          createReadyMarker(agent.agentId),
        );
      }

      await Promise.all(
        existingClients.slice(1).map((client) => bindClientToChannels(client, channelIds)),
      );

      const warmMarkers = new Map(
        agents.map((agent) => [
          createOutputDoneMarker('warm-scrollback', agent.agentId),
          agent.channelId,
        ]),
      );
      const warmWatchers = existingClients.map((client) =>
        waitForDoneMarkers(client, warmMarkers, 30_000),
      );

      for (const [agentIndex, agent] of agents.entries()) {
        const writer = existingClients[agentIndex % existingClients.length];
        sendAgentInput(
          writer,
          agent.agentId,
          createStartOutputLine(
            'warm-scrollback',
            agent.agentId,
            warmScrollbackLineCount,
            warmScrollbackLineBytes,
          ),
        );
      }

      await Promise.all(warmWatchers);

      const lateJoinState = createStressClientState('late-join-new');
      lateJoinClient = await connectAuthenticatedClient(lateJoinState);
      const lateJoinResetChannelIds = await bindClientToChannels(lateJoinClient, channelIds);
      const scrollbackAgentIds = getReplayAgentIds(agents, lateJoinResetChannelIds);

      const liveMarkers = new Map(
        agents.map((agent) => [
          createOutputDoneMarker('late-join-live', agent.agentId),
          agent.channelId,
        ]),
      );
      const liveClients = [...existingClients, lateJoinClient];
      const watchers = liveClients.map((client) => waitForDoneMarkers(client, liveMarkers, 30_000));

      await resetBackendDiagnostics();
      const replayStartedAt = performance.now();
      const scrollbackReplayPromise = getScrollbackBatch(scrollbackAgentIds);

      for (const [agentIndex, agent] of agents.entries()) {
        const writer = existingClients[agentIndex % existingClients.length];
        sendAgentInput(
          writer,
          agent.agentId,
          createStartOutputLine('late-join-live', agent.agentId, liveLineCount, liveLineBytes),
        );
      }

      const [scrollbackEntries, timings] = await Promise.all([
        scrollbackReplayPromise,
        Promise.all(watchers),
      ]);
      const replayDurationMs = performance.now() - replayStartedAt;
      const markerSkewsMs = getMarkerSkews(timings);
      const diagnostics = await getBackendDiagnostics();

      console.warn(
        `[session-stress] late join replay=${replayDurationMs.toFixed(
          1,
        )}ms scrollbackBytes=${getTotalScrollbackBytes(scrollbackEntries)} maxSkew=${Math.max(
          ...markerSkewsMs,
        ).toFixed(1)}ms`,
      );

      expect(scrollbackEntries).toHaveLength(scrollbackAgentIds.length);
      expect(getTotalScrollbackBytes(scrollbackEntries)).toBeGreaterThan(0);
      expect(Math.max(...markerSkewsMs)).toBeLessThan(5_000);
      expect(diagnostics.scrollbackReplay).toMatchObject({
        batchRequests: 1,
        requestedAgents: scrollbackAgentIds.length,
      });
      expect(diagnostics.scrollbackReplay.returnedBytes).toBeGreaterThan(0);
      expect(diagnostics.scrollbackReplay.lastDurationMs).not.toBeNull();
    } finally {
      await Promise.allSettled(agents.map((agent) => killAgentViaHttp(agent.agentId)));
      if (lateJoinClient) {
        lateJoinClient.close();
      }
      for (const client of existingClients) {
        client.close();
      }
    }
  });
});
