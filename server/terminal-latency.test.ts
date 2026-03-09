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
  if (!proc || !proc.stdout || !proc.stderr) {
    throw new Error('Server process or stdio streams unavailable');
  }

  // Wait for server to start listening
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10_000);

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      if (text.includes('listening on')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
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
    const earlyMessages: (Buffer | string)[] = [];
    let draining = false;

    const earlyHandler = (data: Buffer | string) => {
      earlyMessages.push(data);
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
          fn(msg, false);
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

    function handler(data: Buffer | string) {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch {
        // ignore non-JSON
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

    function handler(data: Buffer | string) {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (predicate(msg)) messages.push(msg);
      } catch {
        // ignore
      }
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
    const channelId = `ch-${agentId}`;

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
        (m) => {
          if (m.type !== 'channel' || m.channelId !== channelId) return false;
          const payload = m.payload as { type?: string; data?: string };
          if (payload?.type !== 'Data' || !payload.data) return false;
          const decoded = Buffer.from(payload.data, 'base64').toString('utf8');
          return decoded.includes(marker);
        },
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
        const payload = msg.payload as { type?: string; data?: string };
        if (payload?.type === 'Data' && payload.data) {
          const text = Buffer.from(payload.data, 'base64').toString('utf8');
          for (const marker of markers) {
            if (text.includes(marker)) received.add(marker);
          }
        }
      }

      console.warn(`  Received ${received.size}/${count} markers`);
      expect(received.size).toBe(count);
    });
  });

  describe('Flow Control', () => {
    let ws: WebSocket;
    const agentId = 'flow-agent-' + Date.now();
    const channelId = `ch-${agentId}`;

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

        function handler(data: Buffer | string) {
          try {
            const msg = JSON.parse(data.toString()) as ServerMessage;
            if (msg.type !== 'channel' || msg.channelId !== channelId) return;
            const payload = msg.payload as { type?: string; data?: string };
            if (payload?.type !== 'Data' || !payload.data) return;
            const decoded = Buffer.from(payload.data, 'base64');
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
          } catch {
            // ignore
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
        (m) => {
          if (m.type !== 'channel' || m.channelId !== channelId) return false;
          const payload = m.payload as { type?: string; data?: string };
          if (payload?.type !== 'Data' || !payload.data) return false;
          return Buffer.from(payload.data, 'base64').toString('utf8').includes(marker);
        },
        5_000,
      );

      expect(msg).toBeDefined();
    });
  });

  describe('Multi-Channel', () => {
    let ws: WebSocket;
    const agents = [
      { agentId: `multi-a-${Date.now()}`, channelId: `ch-multi-a-${Date.now()}` },
      { agentId: `multi-b-${Date.now()}`, channelId: `ch-multi-b-${Date.now()}` },
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
        const payload = msg.payload as { type?: string; data?: string };
        if (payload?.type === 'Data' && payload.data) {
          const text = Buffer.from(payload.data, 'base64').toString('utf8');
          const chId = msg.channelId as string;
          channelOutput[chId] = (channelOutput[chId] ?? '') + text;
        }
      }

      // Marker A should only appear on channel A
      expect(channelOutput[agents[0].channelId] ?? '').toContain(markerA);
      expect(channelOutput[agents[0].channelId] ?? '').not.toContain(markerB);

      // Marker B should only appear on channel B
      expect(channelOutput[agents[1].channelId] ?? '').toContain(markerB);
      expect(channelOutput[agents[1].channelId] ?? '').not.toContain(markerA);
    });
  });

  describe('Latency Under Simulated Network Conditions', () => {
    // This test requires a separate server with latency simulation
    // It's tagged so it can be run separately
    it.skip('measures RTT with simulated 100ms latency', async () => {
      // Would need to start a second server with SIMULATE_LATENCY_MS=100
      // and run the echo latency test against it
      // Left as a manual test for now
    });
  });

  describe('Reconnection', () => {
    it('receives output after channel rebind', async () => {
      const agentId = `reconnect-${Date.now()}`;
      const channelId = `ch-${agentId}`;

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
        (m) => {
          if (m.type !== 'channel' || m.channelId !== channelId) return false;
          const payload = m.payload as { type?: string; data?: string };
          if (payload?.type !== 'Data' || !payload.data) return false;
          return Buffer.from(payload.data, 'base64').toString('utf8').includes(marker);
        },
        5_000,
      );

      expect(msg).toBeDefined();
      await killAgentViaHttp(agentId);
      ws2.close();
    });
  });

  describe('Detach and Reattach', () => {
    it('detach does not lose output after reattach', async () => {
      const agentId = `detach-${Date.now()}`;
      const channelId1 = `ch1-${agentId}`;
      const channelId2 = `ch2-${agentId}`;

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
        (m) => {
          if (m.type !== 'channel' || m.channelId !== channelId2) return false;
          const payload = m.payload as { type?: string; data?: string };
          if (payload?.type !== 'Data' || !payload.data) return false;
          return Buffer.from(payload.data, 'base64').toString('utf8').includes(marker);
        },
        5_000,
      );

      expect(msg).toBeDefined();
      await killAgentViaHttp(agentId);
      ws.close();
    });
  });
});
