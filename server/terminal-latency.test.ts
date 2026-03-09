/**
 * Integration tests for terminal I/O latency and correctness.
 *
 * These tests spawn a real server process, connect via WebSocket, spawn PTY
 * agents, and measure end-to-end latency through the actual data path:
 *
 *   input → WebSocket → server → PTY → batch → WebSocket → client
 *
 * Run with: npx vitest run server/terminal-latency.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

const TEST_PORT = 19876;
const TEST_TOKEN = 'test-integration-token-' + Date.now();
const SERVER_URL = `ws://127.0.0.1:${TEST_PORT}`;

let serverProcess: ChildProcess | null = null;

interface ServerMessage {
  type: string;
  channelId?: string;
  payload?: unknown;
  agentId?: string;
  data?: string;
  list?: Array<{ agentId: string }>;
  [key: string]: unknown;
}

type WsMessageData = Buffer | string | ArrayBuffer | Buffer[];

const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;

function createChannelId(): string {
  return randomUUID();
}

function toBuffer(data: WsMessageData): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return null;
}

function parseServerMessage(data: WsMessageData, isBinary: boolean): ServerMessage | null {
  if (isBinary) {
    const frame = toBuffer(data);
    if (!frame || frame.length < CHANNEL_BINARY_HEADER_BYTES) return null;
    if (frame[0] !== CHANNEL_DATA_FRAME_TYPE) return null;
    return {
      type: 'channel',
      channelId: frame.toString('ascii', 1, CHANNEL_BINARY_HEADER_BYTES),
      payload: {
        type: 'Data',
        data: frame.subarray(CHANNEL_BINARY_HEADER_BYTES),
      },
    };
  }

  const text = typeof data === 'string' ? data : toBuffer(data)?.toString();
  if (!text) return null;
  try {
    return JSON.parse(text) as ServerMessage;
  } catch {
    return null;
  }
}

function getChannelPayloadBytes(payload: unknown): Buffer | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as { type?: unknown; data?: unknown };
  if (candidate.type !== 'Data') return null;

  const data = candidate.data;
  if (typeof data === 'string') return Buffer.from(data, 'base64');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

function getChannelText(msg: ServerMessage, channelId: string): string | null {
  if (msg.type !== 'channel' || msg.channelId !== channelId) return null;
  const bytes = getChannelPayloadBytes(msg.payload);
  return bytes ? bytes.toString('utf8') : null;
}

function channelMessageContains(msg: ServerMessage, channelId: string, text: string): boolean {
  return getChannelText(msg, channelId)?.includes(text) ?? false;
}

async function startServer(env: Record<string, string> = {}): Promise<void> {
  const serverPath = path.resolve(__dirname, '..', 'dist-server', 'server', 'main.js');

  serverProcess = spawn('node', [serverPath], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      AUTH_TOKEN: TEST_TOKEN,
      PARALLEL_CODE_USER_DATA_DIR: path.resolve(__dirname, '..', '.test-server-data'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const proc = serverProcess;
  const stdout = proc?.stdout;
  const stderr = proc?.stderr;
  if (!proc || !stdout || !stderr) {
    throw new Error('Server process or stdio streams unavailable');
  }

  // Wait for server to start listening
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10_000);

    stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      if (text.includes('listening on')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      // Ignore common warnings
      if (text.includes('ExperimentalWarning') || text.includes('DeprecationWarning')) return;
      console.warn('[server stderr]', text);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket client helpers
// ---------------------------------------------------------------------------

/**
 * Connect via WebSocket. Buffers messages received before any handler is
 * registered so that early server messages (e.g. agents list sent on auth
 * via query param) are not lost.
 */
function connectWs(query = `?token=${TEST_TOKEN}`): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${SERVER_URL}/ws${query}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 5_000);

    // Buffer messages that arrive before the test registers its handler.
    // Without this, the 'agents' message sent synchronously on auth-via-
    // query-param fires before the test calls waitForMessage().
    const earlyMessages: Array<{ data: WsMessageData; isBinary: boolean }> = [];
    let draining = false;

    const earlyHandler = (data: WsMessageData, isBinary: boolean) => {
      earlyMessages.push({ data, isBinary });
    };
    ws.on('message', earlyHandler);

    // Patch ws.on('message', ...) so that the first real handler replays
    // any buffered messages.
    const origOn = ws.on.bind(ws);
    ws.on = ((event: string, fn: (...args: unknown[]) => void) => {
      if (event === 'message' && !draining && fn !== earlyHandler) {
        draining = true;
        ws.removeListener('message', earlyHandler);
        origOn('message', fn);
        for (const msg of earlyMessages) {
          fn(msg.data, msg.isBinary);
        }
        earlyMessages.length = 0;
        return ws;
      }
      return origOn(event, fn);
    }) as typeof ws.on;

    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timed out waiting for message'));
    }, timeoutMs);

    function handler(data: WsMessageData, isBinary: boolean) {
      const msg = parseServerMessage(data, isBinary);
      if (msg && predicate(msg)) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    }

    ws.on('message', handler);
  });
}

function waitForRawMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage | null, isBinary: boolean) => boolean,
  timeoutMs = 5_000,
): Promise<{ msg: ServerMessage | null; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timed out waiting for raw message'));
    }, timeoutMs);

    function handler(data: WsMessageData, isBinary: boolean) {
      const msg = parseServerMessage(data, isBinary);
      if (predicate(msg, isBinary)) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve({ msg, isBinary });
      }
    }

    ws.on('message', handler);
  });
}

function collectMessages(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  durationMs: number,
): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const messages: ServerMessage[] = [];

    function handler(data: WsMessageData, isBinary: boolean) {
      const msg = parseServerMessage(data, isBinary);
      if (msg && predicate(msg)) messages.push(msg);
    }

    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

async function spawnAgentViaHttp(opts: {
  taskId: string;
  agentId: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  channelId?: string;
}): Promise<void> {
  const body = {
    taskId: opts.taskId,
    agentId: opts.agentId,
    command: opts.command,
    args: opts.args ?? [],
    cwd: '/tmp',
    env: {},
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    isShell: true,
    onOutput: { __CHANNEL_ID__: opts.channelId ?? `ch-${opts.agentId}` },
  };

  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/ipc/spawn_agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spawn failed (${res.status}): ${text}`);
  }
}

async function killAgentViaHttp(agentId: string): Promise<void> {
  await fetch(`http://127.0.0.1:${TEST_PORT}/api/ipc/kill_agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify({ agentId }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Terminal I/O Integration', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // Build the server first
    const { execSync } = await import('child_process');
    execSync('npx tsc -p server/tsconfig.json', {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
    });
    await startServer();
  });

  afterAll(() => {
    stopServer();
  });

  describe('WebSocket Connection', () => {
    it('authenticates via query param and receives agents list', async () => {
      const ws = await connectWs();
      try {
        const msg = await waitForMessage(ws, (m) => m.type === 'agents');
        expect(msg.type).toBe('agents');
        expect(msg.list).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('authenticates via auth message', async () => {
      const ws = await connectWs(''); // no query param
      try {
        sendJson(ws, { type: 'auth', token: TEST_TOKEN });
        const msg = await waitForMessage(ws, (m) => m.type === 'agents');
        expect(msg.type).toBe('agents');
      } finally {
        ws.close();
      }
    });

    it('rejects invalid token', async () => {
      const ws = await connectWs('?token=wrong');
      sendJson(ws, { type: 'auth', token: 'also-wrong' });

      // Server closes the connection with 4001 on invalid auth message
      const closeCode = await new Promise<number>((resolve) => {
        const timeout = setTimeout(() => resolve(-1), 3_000);
        ws.on('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });

      expect(closeCode).toBe(4001);
    });
  });

  describe('PTY Echo Latency', () => {
    let ws: WebSocket;
    const agentId = 'echo-agent-' + Date.now();
    const channelId = createChannelId();

    beforeEach(async () => {
      ws = await connectWs();
      // Wait for auth
      await waitForMessage(ws, (m) => m.type === 'agents');

      // Bind channel for output
      sendJson(ws, { type: 'bind-channel', channelId });

      // Wait for channel-bound acknowledgment
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);

      // Spawn a shell
      await spawnAgentViaHttp({
        taskId: 'test-task',
        agentId,
        command: '/bin/sh',
        channelId,
      });

      // Wait for shell prompt (some initial output)
      await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);
    });

    afterEach(async () => {
      await killAgentViaHttp(agentId);
      ws.close();
    });

    it('echoes input back within 100ms on localhost', async () => {
      const marker = `__TEST_${Date.now()}__`;
      const sendTime = performance.now();

      // Send echo command via WebSocket
      sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });

      // Wait for marker in output
      const outputMsg = await waitForMessage(
        ws,
        (m) => channelMessageContains(m, channelId, marker),
        5_000,
      );

      const rtt = performance.now() - sendTime;
      expect(outputMsg).toBeDefined();
      // On localhost, RTT should be well under 100ms
      expect(rtt).toBeLessThan(100);
      console.warn(`  Echo RTT: ${rtt.toFixed(1)}ms`);
    });

    it('handles rapid sequential input without loss', async () => {
      const markers: string[] = [];
      const count = 10;

      for (let i = 0; i < count; i++) {
        const marker = `__SEQ_${i}_${Date.now()}__`;
        markers.push(marker);
        sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });
      }

      // Collect output for up to 5 seconds
      const received = new Set<string>();
      const outputMessages = await collectMessages(
        ws,
        (m) => m.type === 'channel' && m.channelId === channelId,
        5_000,
      );

      for (const msg of outputMessages) {
        const text = getChannelText(msg, channelId);
        if (text) {
          for (const marker of markers) {
            if (text.includes(marker)) received.add(marker);
          }
        }
      }

      console.warn(`  Received ${received.size}/${count} markers`);
      expect(received.size).toBe(count);
    });
  });

  describe('Channel Transport Format', () => {
    async function expectChannelTransportFormat(
      channelId: string,
      expectBinary: boolean,
    ): Promise<void> {
      const ws = await connectWs();
      const agentId = `format-${Date.now()}-${expectBinary ? 'bin' : 'json'}`;

      try {
        await waitForMessage(ws, (m) => m.type === 'agents');
        sendJson(ws, { type: 'bind-channel', channelId });
        await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);
        await spawnAgentViaHttp({
          taskId: 'format-task',
          agentId,
          command: '/bin/sh',
          channelId,
        });
        await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);

        const marker = `__FORMAT_${Date.now()}__`;
        const rawMessage = waitForRawMessage(
          ws,
          (msg, isBinary) =>
            isBinary === expectBinary && !!msg && channelMessageContains(msg, channelId, marker),
          5_000,
        );

        sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });

        const { msg, isBinary } = await rawMessage;
        expect(isBinary).toBe(expectBinary);
        expect(msg?.type).toBe('channel');

        if (expectBinary) {
          const payload = msg?.payload as { type?: unknown; data?: unknown } | undefined;
          expect(payload?.data).toBeInstanceOf(Uint8Array);
        } else {
          const payload = msg?.payload as { type?: unknown; data?: unknown } | undefined;
          expect(typeof payload?.data).toBe('string');
        }
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        ws.close();
      }
    }

    it('streams UUID channels as binary frames', async () => {
      await expectChannelTransportFormat(createChannelId(), true);
    });

    it('falls back to JSON frames for non-UUID channels', async () => {
      await expectChannelTransportFormat(`legacy-${Date.now()}`, false);
    });
  });

  describe('Flow Control', () => {
    let ws: WebSocket;
    const agentId = 'flow-agent-' + Date.now();
    const channelId = createChannelId();

    beforeEach(async () => {
      ws = await connectWs();
      await waitForMessage(ws, (m) => m.type === 'agents');
      sendJson(ws, { type: 'bind-channel', channelId });
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnAgentViaHttp({
        taskId: 'flow-task',
        agentId,
        command: '/bin/sh',
        channelId,
      });
      // Wait for initial prompt
      await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);
    });

    afterEach(async () => {
      await killAgentViaHttp(agentId);
      ws.close();
    });

    it('handles high-throughput output without data loss', async () => {
      // Generate substantial output. Use a variable for the end marker so
      // the marker string doesn't appear literally in the echoed command
      // line, which would cause a false-positive match before seq runs.
      const lineCount = 500;
      const markerVal = `__END_${Date.now()}__`;

      // Set up handler BEFORE sending input to avoid race condition
      let totalBytes = 0;
      let foundMarker = false;
      // Track how many times the marker appears — first is command echo,
      // second is the actual echo output
      let markerSeen = 0;

      const resultPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.removeListener('message', handler);
          reject(
            new Error(
              `Timeout waiting for end marker. Got ${totalBytes} bytes, marker seen ${markerSeen}x`,
            ),
          );
        }, 15_000);

        function handler(data: WsMessageData, isBinary: boolean) {
          const msg = parseServerMessage(data, isBinary);
          const decoded = msg?.channelId === channelId ? getChannelPayloadBytes(msg.payload) : null;
          if (!decoded) return;
          totalBytes += decoded.length;
          const text = decoded.toString('utf8');
          // Count marker occurrences in this chunk
          let idx = 0;
          while ((idx = text.indexOf(markerVal, idx)) !== -1) {
            markerSeen++;
            idx += markerVal.length;
          }
          // Need 2 occurrences: command echo + actual echo output
          if (markerSeen >= 2) {
            foundMarker = true;
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            resolve();
          }
        }

        ws.on('message', handler);
      });

      // Use a variable-based echo so the marker doesn't appear in the command
      sendJson(ws, {
        type: 'input',
        agentId,
        data: `M=${markerVal}; seq 1 ${lineCount}; echo $M\n`,
      });

      await resultPromise;

      expect(foundMarker).toBe(true);
      console.warn(`  High-throughput: ${totalBytes} bytes received`);
      // seq 1 500 produces ~2KB, plus overhead
      expect(totalBytes).toBeGreaterThan(1000);
    });

    it('pause and resume work via WebSocket', async () => {
      // Pause
      sendJson(ws, { type: 'pause', agentId });

      // Small delay to let pause take effect
      await new Promise((r) => setTimeout(r, 50));

      // Resume
      sendJson(ws, { type: 'resume', agentId });

      // Verify agent still responds after resume
      const marker = `__RESUME_${Date.now()}__`;
      sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });

      const msg = await waitForMessage(
        ws,
        (m) => channelMessageContains(m, channelId, marker),
        5_000,
      );

      expect(msg).toBeDefined();
    });
  });

  describe('Multi-Channel', () => {
    let ws: WebSocket;
    const agents = [
      { agentId: `multi-a-${Date.now()}`, channelId: createChannelId() },
      { agentId: `multi-b-${Date.now()}`, channelId: createChannelId() },
    ];

    beforeEach(async () => {
      ws = await connectWs();
      await waitForMessage(ws, (m) => m.type === 'agents');

      for (const agent of agents) {
        sendJson(ws, { type: 'bind-channel', channelId: agent.channelId });
        await waitForMessage(
          ws,
          (m) => m.type === 'channel-bound' && m.channelId === agent.channelId,
        );
        await spawnAgentViaHttp({
          taskId: 'multi-task',
          agentId: agent.agentId,
          command: '/bin/sh',
          channelId: agent.channelId,
        });
        // Wait for initial output
        await waitForMessage(
          ws,
          (m) => m.type === 'channel' && m.channelId === agent.channelId,
          5_000,
        );
      }
    });

    afterEach(async () => {
      for (const agent of agents) {
        await killAgentViaHttp(agent.agentId);
      }
      ws.close();
    });

    it('output from multiple agents is correctly routed to their channels', async () => {
      const markerA = `__AGENT_A_${Date.now()}__`;
      const markerB = `__AGENT_B_${Date.now()}__`;

      sendJson(ws, { type: 'input', agentId: agents[0].agentId, data: `echo ${markerA}\n` });
      sendJson(ws, { type: 'input', agentId: agents[1].agentId, data: `echo ${markerB}\n` });

      // Collect all output
      const channelOutput: Record<string, string> = {};

      const messages = await collectMessages(
        ws,
        (m) =>
          m.type === 'channel' &&
          (m.channelId === agents[0].channelId || m.channelId === agents[1].channelId),
        3_000,
      );

      for (const msg of messages) {
        const text = msg.channelId ? getChannelText(msg, msg.channelId) : null;
        if (!text || !msg.channelId) continue;
        channelOutput[msg.channelId] = (channelOutput[msg.channelId] ?? '') + text;
      }

      // Marker A should only appear on channel A
      expect(channelOutput[agents[0].channelId] ?? '').toContain(markerA);
      expect(channelOutput[agents[0].channelId] ?? '').not.toContain(markerB);

      // Marker B should only appear on channel B
      expect(channelOutput[agents[1].channelId] ?? '').toContain(markerB);
      expect(channelOutput[agents[1].channelId] ?? '').not.toContain(markerA);
    });
  });

  describe('Latency Under Simulated Network Conditions', { timeout: 60_000 }, () => {
    const SIM_PORT = TEST_PORT + 1;
    const SIM_SERVER_URL = `ws://127.0.0.1:${SIM_PORT}`;
    let simServerProcess: ChildProcess | null = null;

    function connectSimWs(query = `?token=${TEST_TOKEN}`): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${SIM_SERVER_URL}/ws${query}`);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket connection timeout'));
        }, 10_000);

        const earlyMessages: Array<{ data: WsMessageData; isBinary: boolean }> = [];
        let draining = false;
        const earlyHandler = (data: WsMessageData, isBinary: boolean) => {
          earlyMessages.push({ data, isBinary });
        };
        ws.on('message', earlyHandler);
        const origOn = ws.on.bind(ws);
        ws.on = ((event: string, fn: (...args: unknown[]) => void) => {
          if (event === 'message' && !draining && fn !== earlyHandler) {
            draining = true;
            ws.removeListener('message', earlyHandler);
            origOn('message', fn);
            for (const msg of earlyMessages) {
              fn(msg.data, msg.isBinary);
            }
            earlyMessages.length = 0;
            return ws;
          }
          return origOn(event, fn);
        }) as typeof ws.on;

        ws.on('open', () => {
          clearTimeout(timeout);
          resolve(ws);
        });
        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    }

    async function spawnSimAgentViaHttp(opts: {
      taskId: string;
      agentId: string;
      command: string;
      args?: string[];
      channelId?: string;
    }): Promise<void> {
      const body = {
        taskId: opts.taskId,
        agentId: opts.agentId,
        command: opts.command,
        args: opts.args ?? [],
        cwd: '/tmp',
        env: {},
        cols: 80,
        rows: 24,
        isShell: true,
        onOutput: { __CHANNEL_ID__: opts.channelId ?? `ch-${opts.agentId}` },
      };
      const res = await fetch(`http://127.0.0.1:${SIM_PORT}/api/ipc/spawn_agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Spawn failed (${res.status}): ${await res.text()}`);
      }
    }

    beforeAll(async () => {
      const serverPath = path.resolve(__dirname, '..', 'dist-server', 'server', 'main.js');
      simServerProcess = spawn('node', [serverPath], {
        env: {
          ...process.env,
          PORT: String(SIM_PORT),
          AUTH_TOKEN: TEST_TOKEN,
          PARALLEL_CODE_USER_DATA_DIR: path.resolve(__dirname, '..', '.test-server-data-sim'),
          SIMULATE_LATENCY_MS: '50',
          SIMULATE_JITTER_MS: '20',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdout = simServerProcess.stdout;
      const stderr = simServerProcess.stderr;
      if (!stdout || !stderr) throw new Error('Sim server stdio unavailable');

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Sim server startup timeout')), 10_000);
        stdout.on('data', (data: Buffer) => {
          if (data.toString().includes('listening on')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        stderr.on('data', () => {});
        simServerProcess?.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });

    afterAll(() => {
      if (simServerProcess) {
        simServerProcess.kill('SIGTERM');
        simServerProcess = null;
      }
    });

    it('measures RTT with simulated 50ms+jitter latency', async () => {
      const agentId = `sim-echo-${Date.now()}`;
      const channelId = createChannelId();

      const ws = await connectSimWs();
      await waitForMessage(ws, (m) => m.type === 'agents');
      sendJson(ws, { type: 'bind-channel', channelId });
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnSimAgentViaHttp({ taskId: 'sim-task', agentId, command: '/bin/sh', channelId });
      await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

      // Measure 5 RTT samples
      const rtts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const marker = `__SIM_${i}_${Date.now()}__`;
        const sendTime = performance.now();
        sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });

        await waitForMessage(ws, (m) => channelMessageContains(m, channelId, marker), 10_000);
        rtts.push(performance.now() - sendTime);
      }

      const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      const p95 = rtts.sort((a, b) => a - b)[Math.floor(rtts.length * 0.95)];
      console.warn(`  Simulated latency RTT: avg=${avg.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);

      // With 50ms + 20ms jitter simulated, RTT should be >50ms but <500ms
      expect(avg).toBeGreaterThan(50);
      expect(avg).toBeLessThan(500);

      await fetch(`http://127.0.0.1:${SIM_PORT}/api/ipc/kill_agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ agentId }),
      });
      ws.close();
    });
  });

  describe('Reconnection', () => {
    it('receives output after channel rebind', async () => {
      const agentId = `reconnect-${Date.now()}`;
      const channelId = createChannelId();

      // First connection: spawn agent
      const ws1 = await connectWs();
      await waitForMessage(ws1, (m) => m.type === 'agents');
      sendJson(ws1, { type: 'bind-channel', channelId });
      await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnAgentViaHttp({ taskId: 'recon-task', agentId, command: '/bin/sh', channelId });
      await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);
      ws1.close();

      // Small gap (simulating brief disconnect)
      await new Promise((r) => setTimeout(r, 200));

      // Second connection: rebind and verify agent still works
      const ws2 = await connectWs();
      await waitForMessage(ws2, (m) => m.type === 'agents');
      sendJson(ws2, { type: 'bind-channel', channelId });
      await waitForMessage(ws2, (m) => m.type === 'channel-bound' && m.channelId === channelId);

      const marker = `__RECON_${Date.now()}__`;
      sendJson(ws2, { type: 'input', agentId, data: `echo ${marker}\n` });

      const msg = await waitForMessage(
        ws2,
        (m) => channelMessageContains(m, channelId, marker),
        5_000,
      );

      expect(msg).toBeDefined();
      await killAgentViaHttp(agentId);
      ws2.close();
    });
  });

  describe('Pending Queue Flush', () => {
    it('flushes queued output generated while disconnected', async () => {
      const agentId = `pq-${Date.now()}`;
      const channelId = createChannelId();

      // First connection: spawn agent and bind channel
      const ws1 = await connectWs();
      await waitForMessage(ws1, (m) => m.type === 'agents');
      sendJson(ws1, { type: 'bind-channel', channelId });
      await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnAgentViaHttp({ taskId: 'pq-task', agentId, command: '/bin/sh', channelId });
      await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);

      // Disconnect — output generated now goes to the pending queue
      ws1.close();
      // Wait for server to detect close and remove from authenticatedClients
      await new Promise((r) => setTimeout(r, 500));

      // Generate output while disconnected via HTTP API
      const marker = `__PQ_FLUSH_${Date.now()}__`;
      await fetch(`http://127.0.0.1:${TEST_PORT}/api/ipc/write_to_agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ agentId, data: `echo ${marker}\n` }),
      });

      // Wait for PTY to echo and server to queue the output
      await new Promise((r) => setTimeout(r, 500));

      // Reconnect and rebind — server should flush pending queue.
      // IMPORTANT: Register the data handler BEFORE sending bind-channel,
      // because the server flushes queued messages synchronously before
      // sending the channel-bound response.
      const ws2 = await connectWs();
      await waitForMessage(ws2, (m) => m.type === 'agents');

      const flushPromise = waitForMessage(
        ws2,
        (m) => channelMessageContains(m, channelId, marker),
        10_000,
      );

      sendJson(ws2, { type: 'bind-channel', channelId });
      const msg = await flushPromise;

      expect(msg).toBeDefined();
      await killAgentViaHttp(agentId);
      ws2.close();
    });
  });

  describe('Scrollback Replay', () => {
    it('returns scrollback buffer via HTTP API', async () => {
      const agentId = `scroll-${Date.now()}`;
      const channelId = createChannelId();

      const ws = await connectWs();
      await waitForMessage(ws, (m) => m.type === 'agents');
      sendJson(ws, { type: 'bind-channel', channelId });
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnAgentViaHttp({ taskId: 'scroll-task', agentId, command: '/bin/sh', channelId });
      await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);

      // Generate some output to fill the scrollback buffer
      const marker = `__SCROLLBACK_${Date.now()}__`;
      sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });

      // Wait for echo to come back
      await waitForMessage(ws, (m) => channelMessageContains(m, channelId, marker), 5_000);

      // Fetch scrollback via HTTP API — response is { result: "<base64>" }
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/ipc/get_agent_scrollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ agentId }),
      });

      expect(res.ok).toBe(true);
      const body = (await res.json()) as { result?: string | null };
      expect(body.result).toBeDefined();
      expect(typeof body.result).toBe('string');

      // Scrollback should contain our marker
      const scrollbackText = Buffer.from(body.result ?? '', 'base64').toString('utf8');
      expect(scrollbackText).toContain(marker);

      await killAgentViaHttp(agentId);
      ws.close();
    });
  });

  describe('Detach and Reattach', () => {
    it('detach does not lose output after reattach', async () => {
      const agentId = `detach-${Date.now()}`;
      const channelId1 = createChannelId();
      const channelId2 = createChannelId();

      const ws = await connectWs();
      await waitForMessage(ws, (m) => m.type === 'agents');

      // Bind first channel and spawn
      sendJson(ws, { type: 'bind-channel', channelId: channelId1 });
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId1);
      await spawnAgentViaHttp({
        taskId: 'detach-task',
        agentId,
        command: '/bin/sh',
        channelId: channelId1,
      });
      await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId1, 5_000);

      // Detach first channel
      await fetch(`http://127.0.0.1:${TEST_PORT}/api/ipc/detach_agent_output`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ agentId, channelId: channelId1 }),
      });

      // Reattach with a new channel (re-spawn binds new channel)
      sendJson(ws, { type: 'bind-channel', channelId: channelId2 });
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId2);
      await spawnAgentViaHttp({
        taskId: 'detach-task',
        agentId,
        command: '/bin/sh',
        channelId: channelId2,
      });

      // Verify output arrives on new channel
      const marker = `__DETACH_${Date.now()}__`;
      sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });

      const msg = await waitForMessage(
        ws,
        (m) => channelMessageContains(m, channelId2, marker),
        5_000,
      );

      expect(msg).toBeDefined();
      await killAgentViaHttp(agentId);
      ws.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Stress Tests — validate throughput, concurrency, and parameter tuning
  // ---------------------------------------------------------------------------

  describe('Stress Tests', { timeout: 60_000 }, () => {
    let ws: WebSocket;
    const agentId = `stress-${Date.now()}`;
    const channelId = createChannelId();

    beforeAll(async () => {
      ws = await connectWs();
      await waitForMessage(ws, (m) => m.type === 'agents');
      sendJson(ws, { type: 'bind-channel', channelId });
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnAgentViaHttp({
        taskId: 'stress-task',
        agentId,
        command: '/bin/sh',
        channelId,
      });
      await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);
    });

    afterAll(async () => {
      await killAgentViaHttp(agentId);
      ws.close();
    });

    it('handles large burst output (10K lines) without loss', async () => {
      const marker = `__BURST_END_${Date.now()}__`;

      const resultPromise = new Promise<{ totalBytes: number; found: boolean }>(
        (resolve, reject) => {
          let totalBytes = 0;
          let markerSeen = 0;
          const timeout = setTimeout(() => {
            ws.removeListener('message', handler);
            reject(new Error(`Timeout: ${totalBytes} bytes, marker seen ${markerSeen}x`));
          }, 30_000);

          function handler(data: WsMessageData, isBinary: boolean) {
            const msg = parseServerMessage(data, isBinary);
            const decoded =
              msg?.channelId === channelId ? getChannelPayloadBytes(msg.payload) : null;
            if (!decoded) return;
            totalBytes += decoded.length;
            const text = decoded.toString('utf8');
            let idx = 0;
            while ((idx = text.indexOf(marker, idx)) !== -1) {
              markerSeen++;
              idx += marker.length;
            }
            if (markerSeen >= 2) {
              clearTimeout(timeout);
              ws.removeListener('message', handler);
              resolve({ totalBytes, found: true });
            }
          }

          ws.on('message', handler);
        },
      );

      sendJson(ws, {
        type: 'input',
        agentId,
        data: `M=${marker}; seq 1 10000; echo $M\n`,
      });

      const result = await resultPromise;
      expect(result.found).toBe(true);
      // seq 1 10000 produces ~49KB
      expect(result.totalBytes).toBeGreaterThan(40_000);
      console.warn(`  Burst output: ${result.totalBytes} bytes`);
    });

    it('sustained rapid input does not drop characters', async () => {
      // Send 50 rapid echo commands and verify all arrive
      const count = 50;
      const markers: string[] = [];
      const ts = Date.now();

      const collectPromise = collectMessages(
        ws,
        (m) => m.type === 'channel' && m.channelId === channelId,
        10_000,
      );

      for (let i = 0; i < count; i++) {
        const marker = `__RAPID_${i}_${ts}__`;
        markers.push(marker);
        sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });
      }

      const messages = await collectPromise;
      const allText = messages.map((m) => getChannelText(m, channelId) ?? '').join('');

      const received = markers.filter((m) => allText.includes(m));
      console.warn(`  Rapid input: ${received.length}/${count} markers received`);
      expect(received.length).toBe(count);
    });

    it('flow control engages under sustained output load', async () => {
      // Generate continuous output and check that pause/resume cycles happen
      // by observing the PTY doesn't hang (proves resume works after pause)
      const marker = `__FLOW_STRESS_${Date.now()}__`;

      const resultPromise = new Promise<{ totalBytes: number }>((resolve, reject) => {
        let totalBytes = 0;
        let markerSeen = 0;
        const timeout = setTimeout(() => {
          ws.removeListener('message', handler);
          reject(new Error(`Timeout: ${totalBytes} bytes, marker ${markerSeen}x`));
        }, 30_000);

        function handler(data: WsMessageData, isBinary: boolean) {
          const msg = parseServerMessage(data, isBinary);
          const decoded = msg?.channelId === channelId ? getChannelPayloadBytes(msg.payload) : null;
          if (!decoded) return;
          totalBytes += decoded.length;
          let idx = 0;
          const text = decoded.toString('utf8');
          while ((idx = text.indexOf(marker, idx)) !== -1) {
            markerSeen++;
            idx += marker.length;
          }
          if (markerSeen >= 2) {
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            resolve({ totalBytes });
          }
        }

        ws.on('message', handler);
      });

      // yes produces infinite output; head -n 50000 gives ~300KB
      sendJson(ws, {
        type: 'input',
        agentId,
        data: `M=${marker}; yes | head -n 50000; echo $M\n`,
      });

      const result = await resultPromise;
      // 50000 lines of "y\n" = 100KB minimum
      expect(result.totalBytes).toBeGreaterThan(50_000);
      console.warn(`  Flow control stress: ${result.totalBytes} bytes`);
    });

    it('concurrent input and output do not deadlock', async () => {
      // Wait for shell to settle after previous high-output stress tests
      const drainMarker = `__DRAIN_${Date.now()}__`;
      sendJson(ws, { type: 'input', agentId, data: `echo ${drainMarker}\n` });
      await waitForMessage(ws, (m) => channelMessageContains(m, channelId, drainMarker), 10_000);

      // While high output is streaming, interleave input commands
      const endMarker = `__CONCURRENT_END_${Date.now()}__`;
      const inputMarkers: string[] = [];

      const resultPromise = new Promise<{ totalBytes: number; allText: string }>(
        (resolve, reject) => {
          let totalBytes = 0;
          let allText = '';
          let endSeen = 0;
          const timeout = setTimeout(() => {
            ws.removeListener('message', handler);
            reject(new Error(`Timeout: ${totalBytes} bytes`));
          }, 30_000);

          function handler(data: WsMessageData, isBinary: boolean) {
            const msg = parseServerMessage(data, isBinary);
            const decoded =
              msg?.channelId === channelId ? getChannelPayloadBytes(msg.payload) : null;
            if (!decoded) return;
            totalBytes += decoded.length;
            const text = decoded.toString('utf8');
            allText += text;
            let idx = 0;
            while ((idx = text.indexOf(endMarker, idx)) !== -1) {
              endSeen++;
              idx += endMarker.length;
            }
            if (endSeen >= 2) {
              clearTimeout(timeout);
              ws.removeListener('message', handler);
              resolve({ totalBytes, allText });
            }
          }

          ws.on('message', handler);
        },
      );

      // Start background output
      sendJson(ws, {
        type: 'input',
        agentId,
        data: `seq 1 5000 >/dev/null\n`,
      });

      // Interleave input while output is flowing
      for (let i = 0; i < 10; i++) {
        const m = `__INTERLEAVE_${i}_${Date.now()}__`;
        inputMarkers.push(m);
        sendJson(ws, { type: 'input', agentId, data: `echo ${m}\n` });
      }

      // End marker
      sendJson(ws, {
        type: 'input',
        agentId,
        data: `M=${endMarker}; echo $M\n`,
      });

      const result = await resultPromise;

      const received = inputMarkers.filter((m) => result.allText.includes(m));
      console.warn(
        `  Concurrent I/O: ${received.length}/10 interleaved markers, ${result.totalBytes} bytes`,
      );
      expect(received.length).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // RTT Benchmarking — measure latency percentiles for parameter tuning
  // ---------------------------------------------------------------------------

  describe('RTT Benchmark', { timeout: 30_000 }, () => {
    let ws: WebSocket;
    const agentId = `bench-${Date.now()}`;
    const channelId = createChannelId();

    beforeAll(async () => {
      ws = await connectWs();
      await waitForMessage(ws, (m) => m.type === 'agents');
      sendJson(ws, { type: 'bind-channel', channelId });
      await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnAgentViaHttp({
        taskId: 'bench-task',
        agentId,
        command: '/bin/sh',
        channelId,
      });
      await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);
    });

    afterAll(async () => {
      await killAgentViaHttp(agentId);
      ws.close();
    });

    it('collects 20 RTT samples and reports percentiles', async () => {
      const rtts: number[] = [];
      const sampleCount = 20;

      for (let i = 0; i < sampleCount; i++) {
        const marker = `__BENCH_${i}_${Date.now()}__`;
        const t0 = performance.now();
        sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });

        await waitForMessage(ws, (m) => channelMessageContains(m, channelId, marker), 5_000);
        rtts.push(performance.now() - t0);
      }

      rtts.sort((a, b) => a - b);
      const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      const p50 = rtts[Math.floor(rtts.length * 0.5)];
      const p95 = rtts[Math.floor(rtts.length * 0.95)];
      const min = rtts[0];
      const max = rtts[rtts.length - 1];

      console.warn(`  RTT Benchmark (${sampleCount} samples):`);
      console.warn(
        `    min=${min.toFixed(1)}ms avg=${avg.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`,
      );

      // On localhost, all RTTs should be under 50ms
      expect(p95).toBeLessThan(50);
      expect(avg).toBeLessThan(25);
    });
  });
});
