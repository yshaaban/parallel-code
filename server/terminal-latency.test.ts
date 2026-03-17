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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { IPC } from '../electron/ipc/channels.js';
import {
  channelMessageContains,
  collectMessages,
  connectWs,
  createChannelId,
  detachAgentOutputViaHttp,
  expectNoMessage,
  getChannelText,
  invokeIpcViaHttp,
  killAgentViaHttp,
  measureEchoRoundTrip,
  reserveTestPort,
  sendJson,
  spawnAgentViaHttp,
  startServer,
  stopServer,
  TEST_TOKEN,
  trackSocketMessages,
  waitForAgentLifecycleEvent,
  waitForChannelMarkerOccurrences,
  waitForMessage,
  waitForRawMessage,
  waitForScrollbackContains,
  waitForSocketClose,
  writeToAgentViaHttp,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, '..', 'scripts', 'fixtures');

function getFixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

function getFixtureCommand(name: string, args: Array<string | number> = []): string {
  return `${process.execPath} ${[getFixturePath(name), ...args].join(' ')}\n`;
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
  }, 30_000);

  afterAll(async () => {
    await stopServer();
  });

  describe('WebSocket Connection', () => {
    it('authenticates via the default auth helper and receives agents list', async () => {
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

    it('echoes input back within 25ms on localhost', async () => {
      const marker = `__TEST_${Date.now()}__`;
      const rtt = await measureEchoRoundTrip(ws, agentId, channelId, marker, 5_000);
      // On localhost, interactive echo should stay comfortably under one frame.
      expect(rtt).toBeLessThan(25);
      console.warn(`  Echo RTT: ${rtt.toFixed(1)}ms`);
    });

    it('handles rapid sequential input without loss', async () => {
      const markers: string[] = [];
      const count = 10;
      const outputMessagesPromise = collectMessages(
        ws,
        (m) => m.type === 'channel' && m.channelId === channelId,
        5_000,
      );

      for (let i = 0; i < count; i++) {
        const marker = `__SEQ_${i}_${Date.now()}__`;
        markers.push(marker);
        sendJson(ws, { type: 'input', agentId, data: `echo ${marker}\n` });
      }

      const received = new Set<string>();
      const outputMessages = await outputMessagesPromise;

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
      await killAgentViaHttp(agentId).catch(() => {});
      ws.close();
    });

    it('handles high-throughput output without data loss', async () => {
      // Generate substantial output. Use a variable for the end marker so
      // the marker string doesn't appear literally in the echoed command
      // line, which would cause a false-positive match before seq runs.
      const lineCount = 500;
      const markerVal = `__END_${Date.now()}__`;

      // Set up handler BEFORE sending input to avoid race condition
      const resultPromise = waitForChannelMarkerOccurrences(ws, channelId, markerVal, 2, 15_000);

      // Use a variable-based echo so the marker doesn't appear in the command
      sendJson(ws, {
        type: 'input',
        agentId,
        data: `M=${markerVal}; seq 1 ${lineCount}; echo $M\n`,
      });

      const result = await resultPromise;

      expect(result.markerSeen).toBeGreaterThanOrEqual(2);
      console.warn(`  High-throughput: ${result.totalBytes} bytes received`);
      // seq 1 500 produces ~2KB, plus overhead
      expect(result.totalBytes).toBeGreaterThan(1000);
    });

    it('pause and resume work via WebSocket', async () => {
      // Pause
      sendJson(ws, { type: 'pause', agentId });
      await waitForAgentLifecycleEvent(ws, agentId, 'pause');

      // Resume
      const resumeEvent = waitForAgentLifecycleEvent(ws, agentId, 'resume');
      sendJson(ws, { type: 'resume', agentId });
      await resumeEvent;

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

    it('emits agent-error when a WebSocket command targets an exited agent', async () => {
      await killAgentViaHttp(agentId);
      await waitForAgentLifecycleEvent(ws, agentId, 'exit');

      sendJson(ws, { type: 'input', agentId, data: 'echo after-exit\n' });

      const errorMessage = await waitForMessage(
        ws,
        (msg) => msg.type === 'agent-error' && msg.agentId === agentId,
        5_000,
      );

      expect(errorMessage.message).toMatch(
        new RegExp(`Agent (not found|not accepting input): ${agentId}`),
      );
    });
  });

  describe('Command acknowledgements', () => {
    it('acknowledges websocket input requests after the backend accepts them', async () => {
      const ws = await connectWs();
      const agentId = `ack-input-${Date.now()}`;
      const channelId = createChannelId();
      const marker = `__ACK_INPUT_${Date.now()}__`;
      const requestId = `request-${Date.now()}`;

      try {
        await waitForMessage(ws, (m) => m.type === 'agents');
        sendJson(ws, { type: 'bind-channel', channelId });
        await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);

        await spawnAgentViaHttp({
          taskId: 'ack-input-task',
          agentId,
          command: '/bin/sh',
          channelId,
        });
        await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

        const ack = waitForMessage(
          ws,
          (msg) =>
            msg.type === 'agent-command-result' &&
            msg.agentId === agentId &&
            msg.requestId === requestId,
          10_000,
        );
        const output = waitForMessage(
          ws,
          (msg) => channelMessageContains(msg, channelId, marker),
          10_000,
        );
        sendJson(ws, {
          type: 'input',
          agentId,
          data: `echo ${marker}\n`,
          requestId,
        });

        await expect(ack).resolves.toMatchObject({
          accepted: true,
          agentId,
          command: 'input',
          requestId,
          type: 'agent-command-result',
        });
        await output;
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        ws.close();
      }
    });

    it('does not reuse cached acknowledgements across input and resize for the same request id', async () => {
      const ws = await connectWs();
      const agentId = `ack-shared-${Date.now()}`;
      const channelId = createChannelId();
      const requestId = `request-${Date.now()}`;

      try {
        await waitForMessage(ws, (m) => m.type === 'agents');
        sendJson(ws, { type: 'bind-channel', channelId });
        await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);

        await spawnAgentViaHttp({
          taskId: 'ack-shared-task',
          agentId,
          command: '/bin/sh',
          channelId,
        });
        await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

        const inputAck = waitForMessage(
          ws,
          (msg) =>
            msg.type === 'agent-command-result' &&
            msg.agentId === agentId &&
            msg.command === 'input' &&
            msg.requestId === requestId,
          10_000,
        );
        sendJson(ws, {
          type: 'input',
          agentId,
          data: 'echo shared-request\n',
          requestId,
        });
        await expect(inputAck).resolves.toMatchObject({
          accepted: true,
          agentId,
          command: 'input',
          requestId,
          type: 'agent-command-result',
        });

        const resizeAck = waitForMessage(
          ws,
          (msg) =>
            msg.type === 'agent-command-result' &&
            msg.agentId === agentId &&
            msg.command === 'resize' &&
            msg.requestId === requestId,
          10_000,
        );
        sendJson(ws, {
          type: 'resize',
          agentId,
          cols: 90,
          rows: 30,
          requestId,
        });
        await expect(resizeAck).resolves.toMatchObject({
          accepted: true,
          agentId,
          command: 'resize',
          requestId,
          type: 'agent-command-result',
        });
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        ws.close();
      }
    });
  });

  describe('Multi-Client Flow Control', () => {
    it('keeps an agent paused until both clients resume flow-control', async () => {
      const agentId = `multi-pause-${Date.now()}`;
      const channelId = createChannelId();
      const marker = `__MULTI_PAUSE_${Date.now()}__`;
      const ws1 = await connectWs();
      const ws2 = await connectWs();

      try {
        await waitForMessage(ws1, (m) => m.type === 'agents');
        await waitForMessage(ws2, (m) => m.type === 'agents');

        sendJson(ws1, { type: 'bind-channel', channelId });
        sendJson(ws2, { type: 'bind-channel', channelId });
        await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);
        await waitForMessage(ws2, (m) => m.type === 'channel-bound' && m.channelId === channelId);

        await spawnAgentViaHttp({
          taskId: 'multi-pause-task',
          agentId,
          command: '/bin/sh',
          channelId,
          env: { MULTI_PAUSE_MARKER: marker },
        });
        await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);

        sendJson(ws1, { type: 'pause', agentId, reason: 'flow-control' });
        await waitForAgentLifecycleEvent(ws1, agentId, 'pause');

        sendJson(ws2, { type: 'pause', agentId, reason: 'flow-control' });
        sendJson(ws1, { type: 'resume', agentId, reason: 'flow-control' });

        const blockedOutput = expectNoMessage(
          ws1,
          (msg) => channelMessageContains(msg, channelId, marker),
          500,
        );
        sendJson(ws1, { type: 'input', agentId, data: 'echo "$MULTI_PAUSE_MARKER"\n' });
        await blockedOutput;

        const resumeEvent = waitForAgentLifecycleEvent(ws1, agentId, 'resume');
        const outputPromise = waitForMessage(
          ws1,
          (msg) => channelMessageContains(msg, channelId, marker),
          5_000,
        );
        sendJson(ws2, { type: 'resume', agentId, reason: 'flow-control' });

        await resumeEvent;
        const msg = await outputPromise;
        expect(msg).toBeDefined();
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        ws1.close();
        ws2.close();
      }
    });
  });

  describe('Multi-Client Control Leases', () => {
    it('rejects interactive commands from non-controller clients until the controller disconnects', async () => {
      const agentId = `lease-${Date.now()}`;
      const channelId = createChannelId();
      const firstMarker = `__LEASE_ONE_${Date.now()}__`;
      const secondMarker = `__LEASE_TWO_${Date.now()}__`;
      const ws1 = await connectWs();
      const ws2 = await connectWs();

      try {
        await waitForMessage(ws1, (m) => m.type === 'agents', 10_000);
        await waitForMessage(ws2, (m) => m.type === 'agents', 10_000);

        sendJson(ws1, { type: 'bind-channel', channelId });
        sendJson(ws2, { type: 'bind-channel', channelId });
        await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);
        await waitForMessage(ws2, (m) => m.type === 'channel-bound' && m.channelId === channelId);

        await spawnAgentViaHttp({
          taskId: 'lease-task',
          agentId,
          command: '/bin/sh',
          channelId,
        });
        await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

        const firstOutput = waitForMessage(
          ws1,
          (msg) => channelMessageContains(msg, channelId, firstMarker),
          10_000,
        );
        sendJson(ws1, { type: 'input', agentId, data: `echo ${firstMarker}\n` });
        await firstOutput;

        const blocked = waitForMessage(
          ws2,
          (msg) => msg.type === 'agent-error' && msg.agentId === agentId,
          5_000,
        );
        sendJson(ws2, { type: 'input', agentId, data: 'echo blocked-by-lease\n' });
        const blockedMessage = await blocked;

        expect(blockedMessage.message).toContain('controlled by another client');

        const releasedControl = waitForMessage(
          ws2,
          (msg) =>
            msg.type === 'agent-controller' && msg.agentId === agentId && msg.controllerId === null,
          10_000,
        );
        const ws1Closed = waitForSocketClose(ws1);
        ws1.close();
        await ws1Closed;
        await releasedControl;
        await vi.waitFor(async () => {
          const result = await invokeIpcViaHttp<{
            controllers: Array<{ controllerId: string | null; taskId: string }>;
          }>(IPC.GetTaskCommandControllers, {});
          expect(
            result.controllers.find((controller) => controller.taskId === 'lease-task'),
          ).toBeUndefined();
        });

        const claimedControl = waitForMessage(
          ws2,
          (msg) =>
            msg.type === 'agent-controller' &&
            msg.agentId === agentId &&
            typeof msg.controllerId === 'string',
          10_000,
        );
        const secondOutput = waitForMessage(
          ws2,
          (msg) => channelMessageContains(msg, channelId, secondMarker),
          10_000,
        );
        sendJson(ws2, { type: 'input', agentId, data: `echo ${secondMarker}\n` });
        await claimedControl;
        await secondOutput;
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        if (ws1.readyState === WebSocket.OPEN || ws1.readyState === WebSocket.CONNECTING) {
          ws1.close();
        }
        if (ws2.readyState === WebSocket.OPEN || ws2.readyState === WebSocket.CONNECTING) {
          ws2.close();
        }
      }
    });

    it('rejects correlated websocket input requests from non-controller clients without dropping lifecycle state', async () => {
      const agentId = `lease-ack-${Date.now()}`;
      const channelId = createChannelId();
      const blockedMarker = `__LEASE_BLOCKED_${Date.now()}__`;
      const requestId = `request-${Date.now()}`;
      const ws1 = await connectWs();
      const ws2 = await connectWs();

      try {
        await waitForMessage(ws1, (m) => m.type === 'agents', 10_000);
        await waitForMessage(ws2, (m) => m.type === 'agents', 10_000);

        sendJson(ws1, { type: 'bind-channel', channelId });
        sendJson(ws2, { type: 'bind-channel', channelId });
        await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);
        await waitForMessage(ws2, (m) => m.type === 'channel-bound' && m.channelId === channelId);

        await spawnAgentViaHttp({
          taskId: 'lease-ack-task',
          agentId,
          command: '/bin/sh',
          channelId,
        });
        await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

        sendJson(ws1, { type: 'input', agentId, data: 'echo owner-established\n' });
        await waitForMessage(ws1, (msg) =>
          channelMessageContains(msg, channelId, 'owner-established'),
        );

        const rejection = waitForMessage(
          ws2,
          (msg) =>
            msg.type === 'agent-command-result' &&
            msg.agentId === agentId &&
            msg.requestId === requestId,
          10_000,
        );
        sendJson(ws2, {
          type: 'input',
          agentId,
          data: `echo ${blockedMarker}\n`,
          requestId,
        });

        await expect(rejection).resolves.toMatchObject({
          accepted: false,
          agentId,
          command: 'input',
          message: expect.stringContaining('controlled by another client'),
          requestId,
          type: 'agent-command-result',
        });
        await expectNoMessage(
          ws2,
          (msg) => channelMessageContains(msg, channelId, blockedMarker),
          500,
        );
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        if (ws1.readyState === WebSocket.OPEN || ws1.readyState === WebSocket.CONNECTING) {
          ws1.close();
        }
        if (ws2.readyState === WebSocket.OPEN || ws2.readyState === WebSocket.CONNECTING) {
          ws2.close();
        }
      }
    });

    it('keeps an attached observer from resizing a controlled terminal', async () => {
      const agentId = `resize-lease-${Date.now()}`;
      const taskId = 'resize-lease-task';

      try {
        await invokeIpcViaHttp('acquire_task_command_lease', {
          action: 'type in the terminal',
          clientId: 'client-a',
          taskId,
        });

        await spawnAgentViaHttp({
          taskId,
          agentId,
          command: '/bin/sh',
          controllerId: 'client-a',
          cols: 120,
          rows: 40,
        });

        await spawnAgentViaHttp({
          taskId,
          agentId,
          command: '/bin/sh',
          controllerId: 'client-b',
          cols: 80,
          rows: 20,
        });

        const [scrollback] = await invokeIpcViaHttp<
          Array<{
            agentId: string;
            cols: number;
            scrollback: string | null;
          }>
        >('get_scrollback_batch', {
          agentIds: [agentId],
        });

        expect(scrollback?.cols).toBe(120);
        await expect(
          invokeIpcViaHttp('resize_agent', {
            agentId,
            cols: 80,
            controllerId: 'client-b',
            rows: 20,
            taskId,
          }),
        ).rejects.toThrow('controlled by another client');
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        await invokeIpcViaHttp('release_task_command_lease', {
          clientId: 'client-a',
          taskId,
        }).catch(() => {});
      }
    });
  });

  describe('Multi-Channel', () => {
    let ws: WebSocket;
    let agents: Array<{ agentId: string; channelId: string }>;

    beforeEach(async () => {
      agents = [
        { agentId: `multi-a-${Date.now()}-${crypto.randomUUID()}`, channelId: createChannelId() },
        { agentId: `multi-b-${Date.now()}-${crypto.randomUUID()}`, channelId: createChannelId() },
      ];
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
        await killAgentViaHttp(agent.agentId).catch(() => {});
      }
      ws?.close();
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
    let simServerProcess: ChildProcess | null = null;
    let simPort = 0;

    function getSimServerUrl(): string {
      return `ws://127.0.0.1:${simPort}`;
    }

    function connectSimWs(query?: string): Promise<WebSocket> {
      const wsQuery = query ?? '';
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${getSimServerUrl()}/ws${wsQuery}`);
        trackSocketMessages(ws);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket connection timeout'));
        }, 10_000);

        ws.on('open', () => {
          if (query === undefined) {
            ws.send(JSON.stringify({ type: 'auth', token: TEST_TOKEN }));
          } else if (query) {
            const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
            const token = params.get('token');
            if (token) {
              ws.send(JSON.stringify({ type: 'auth', token }));
            }
          }
          clearTimeout(timeout);
          resolve(ws);
        });
        ws.on('error', (err: Error) => {
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
      isShell?: boolean;
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
        isShell: opts.isShell ?? true,
        onOutput: { __CHANNEL_ID__: opts.channelId ?? `ch-${opts.agentId}` },
      };
      const res = await fetch(`http://127.0.0.1:${simPort}/api/ipc/spawn_agent`, {
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
      simPort = await reserveTestPort();
      const serverPath = path.resolve(__dirname, '..', 'dist-server', 'server', 'main.js');
      simServerProcess = spawn('node', [serverPath], {
        env: {
          ...process.env,
          PORT: String(simPort),
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
        const cleanup = () => {
          clearTimeout(timeout);
          stdout.off('data', handleStdout);
          stderr.off('data', handleStderr);
          simServerProcess?.off('error', handleError);
          simServerProcess?.off('exit', handleExit);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Sim server startup timeout'));
        }, 20_000);
        const handleStdout = (data: Buffer) => {
          if (data.toString().includes('listening on')) {
            cleanup();
            resolve();
          }
        };
        const handleStderr = () => {};
        const handleError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const handleExit = (code: number | null) => {
          cleanup();
          reject(
            new Error(
              `Sim server exited before startup completed${code === null ? '' : ` (code ${code})`}`,
            ),
          );
        };

        stdout.on('data', handleStdout);
        stderr.on('data', handleStderr);
        simServerProcess?.once('error', handleError);
        simServerProcess?.once('exit', handleExit);
      });
    }, 20_000);

    afterAll(async () => {
      const proc = simServerProcess;
      simServerProcess = null;
      if (!proc) return;
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const liveProc = proc;

      await new Promise<void>((resolve) => {
        let finished = false;

        function finish(): void {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(forceKillTimeout);
          clearTimeout(resolveTimeout);
          liveProc.off('exit', finish);
          resolve();
        }

        const forceKillTimeout = setTimeout(() => {
          if (liveProc.exitCode === null && liveProc.signalCode === null) {
            liveProc.kill('SIGKILL');
          }
        }, 1_000);
        const resolveTimeout = setTimeout(finish, 3_000);

        liveProc.once('exit', finish);
        liveProc.kill('SIGTERM');
      });
    });

    it('measures RTT with simulated 50ms+jitter latency', async () => {
      const agentId = `sim-echo-${Date.now()}`;
      const channelId = createChannelId();
      const echoAgentSource = String.raw`
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  process.stdout.write(chunk);
});
process.stdin.resume();
`;

      const ws = await connectSimWs();
      try {
        await waitForMessage(ws, (m) => m.type === 'agents');
        sendJson(ws, { type: 'bind-channel', channelId });
        await waitForMessage(ws, (m) => m.type === 'channel-bound' && m.channelId === channelId);
        await spawnSimAgentViaHttp({
          taskId: 'sim-task',
          agentId,
          command: process.execPath,
          args: ['-e', echoAgentSource],
          channelId,
          isShell: false,
        });
        await waitForAgentLifecycleEvent(ws, agentId, 'spawn', 10_000);
        await new Promise((resolve) => setTimeout(resolve, 100));

        async function measureSimulatedRoundTrip(marker: string, attempts = 2): Promise<number> {
          let lastError: unknown;
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
              const resultPromise = waitForChannelMarkerOccurrences(
                ws,
                channelId,
                marker,
                1,
                12_000,
              );
              const sendTime = performance.now();
              sendJson(ws, { type: 'input', agentId, data: `${marker}\n` });
              await resultPromise;
              return performance.now() - sendTime;
            } catch (error) {
              lastError = error;
              if (attempt >= attempts - 1) {
                break;
              }

              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }

          throw lastError ?? new Error('Simulated RTT measurement failed');
        }

        await measureSimulatedRoundTrip(`__SIM_READY_${Date.now()}__`, 4);

        // Measure a couple of RTT samples. This keeps the transport check
        // meaningful without turning the test into a long-running stress loop.
        const rtts: number[] = [];
        for (let i = 0; i < 2; i++) {
          const marker = `__SIM_${i}_${Date.now()}__`;
          rtts.push(await measureSimulatedRoundTrip(marker, 3));
        }

        const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
        const p95 = rtts.sort((a, b) => a - b)[Math.floor(rtts.length * 0.95)];
        console.warn(`  Simulated latency RTT: avg=${avg.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);

        // With 50ms + 20ms jitter simulated, RTT should be >50ms but <500ms
        expect(avg).toBeGreaterThan(50);
        expect(avg).toBeLessThan(500);
      } finally {
        await fetch(`http://127.0.0.1:${simPort}/api/ipc/kill_agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
          body: JSON.stringify({ agentId }),
        }).catch(() => {});
        ws.close();
      }
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
      const ws1Closed = waitForSocketClose(ws1);
      ws1.close();
      await ws1Closed;

      // Second connection: rebind and verify agent still works
      const ws2 = await connectWs();
      await waitForMessage(ws2, (m) => m.type === 'agents', 10_000);
      sendJson(ws2, { type: 'bind-channel', channelId });
      await waitForMessage(
        ws2,
        (m) => m.type === 'channel-bound' && m.channelId === channelId,
        10_000,
      );

      const marker = `__RECON_${Date.now()}__`;
      const outputPromise = waitForChannelMarkerOccurrences(ws2, channelId, marker, 1, 10_000);
      sendJson(ws2, { type: 'input', agentId, data: `echo ${marker}\n` });

      const result = await outputPromise;
      expect(result.markerSeen).toBeGreaterThanOrEqual(1);
      await killAgentViaHttp(agentId);
      const ws2Closed = waitForSocketClose(ws2);
      ws2.close();
      await ws2Closed;
    });

    it('does not replay control events older than the auth cursor', async () => {
      const agentId = `replay-cursor-${Date.now()}`;
      const channelId = createChannelId();

      const ws1 = await connectWs('');
      try {
        const initialAgents = waitForMessage(ws1, (m) => m.type === 'agents');
        sendJson(ws1, { type: 'auth', token: TEST_TOKEN, lastSeq: -1 });
        await initialAgents;

        sendJson(ws1, { type: 'bind-channel', channelId });
        await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);

        await spawnAgentViaHttp({ taskId: 'cursor-task', agentId, command: '/bin/sh', channelId });
        const spawnEvent = await waitForAgentLifecycleEvent(ws1, agentId, 'spawn');
        const lastSeq = (spawnEvent as { seq?: unknown }).seq;

        expect(typeof lastSeq).toBe('number');

        const ws1Closed = waitForSocketClose(ws1);
        ws1.close();
        await ws1Closed;

        const ws2 = await connectWs('');
        try {
          const nextAgents = waitForMessage(ws2, (m) => m.type === 'agents');
          sendJson(ws2, { type: 'auth', token: TEST_TOKEN, lastSeq });
          await nextAgents;

          await expectNoMessage(
            ws2,
            (msg) =>
              msg.type === 'agent-lifecycle' &&
              msg.agentId === agentId &&
              (msg as { event?: unknown }).event === 'spawn',
            500,
          );
        } finally {
          const ws2Closed = waitForSocketClose(ws2);
          ws2.close();
          await ws2Closed;
        }
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
      }
    });

    it('replays missed control events before broadcasting newer auth-side remote status', async () => {
      const agentId = `replay-order-${Date.now()}`;
      const channelId = createChannelId();
      const marker = `__REPLAY_ORDER_${Date.now()}__`;

      const ws1 = await connectWs('');
      try {
        const initialAgents = waitForMessage(ws1, (m) => m.type === 'agents');
        sendJson(ws1, { type: 'auth', token: TEST_TOKEN, lastSeq: -1 });
        await initialAgents;

        sendJson(ws1, { type: 'bind-channel', channelId });
        await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);

        await spawnAgentViaHttp({
          taskId: 'replay-order-task',
          agentId,
          command: '/bin/sh',
          channelId,
        });
        await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);

        sendJson(ws1, { type: 'input', agentId, data: `echo ${marker}\n` });
        const controllerMessage = await waitForMessage(
          ws1,
          (msg) =>
            msg.type === 'agent-controller' &&
            msg.agentId === agentId &&
            typeof msg.controllerId === 'string',
          10_000,
        );
        const controllerSeq = controllerMessage.seq;

        expect(typeof controllerSeq).toBe('number');

        const ws2 = await connectWs('');
        try {
          sendJson(ws2, { type: 'auth', token: TEST_TOKEN, lastSeq: Number(controllerSeq) - 1 });
          const firstMessage = await waitForMessage(
            ws2,
            (msg) => msg.type === 'agent-controller' && msg.agentId === agentId,
            10_000,
          );
          const remoteStatusMessage = await waitForMessage(
            ws2,
            (msg) =>
              msg.type === 'remote-status' &&
              typeof msg.seq === 'number' &&
              Number(msg.seq) > Number(controllerSeq),
            10_000,
          );

          expect(firstMessage?.type).toBe('agent-controller');
          expect(firstMessage?.agentId).toBe(agentId);
          expect(firstMessage?.seq).toBe(controllerSeq);
          expect(remoteStatusMessage?.type).toBe('remote-status');
          expect(Number(remoteStatusMessage?.seq)).toBeGreaterThan(Number(firstMessage?.seq));
        } finally {
          const ws2Closed = waitForSocketClose(ws2);
          ws2.close();
          await ws2Closed;
        }
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        const ws1Closed = waitForSocketClose(ws1);
        ws1.close();
        await ws1Closed;
      }
    });
  });

  describe('Pending Queue Flush', () => {
    it('flushes queued output generated while disconnected', async () => {
      const agentId = `pq-${Date.now()}`;
      const channelId = createChannelId();
      const marker = `__PQ_FLUSH_${Date.now()}__`;

      // First connection: spawn agent and bind channel
      const ws1 = await connectWs();
      await waitForMessage(ws1, (m) => m.type === 'agents');
      sendJson(ws1, { type: 'bind-channel', channelId });
      await waitForMessage(ws1, (m) => m.type === 'channel-bound' && m.channelId === channelId);
      await spawnAgentViaHttp({
        taskId: 'pq-task',
        agentId,
        command: '/bin/sh',
        channelId,
        env: { PENDING_MARKER: marker },
      });
      await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 5_000);

      // Disconnect — output generated now goes to the pending queue
      const ws1Closed = waitForSocketClose(ws1);
      ws1.close();
      await ws1Closed;

      // Generate output while disconnected via HTTP API
      await writeToAgentViaHttp(agentId, 'echo "$PENDING_MARKER"\n');
      await waitForScrollbackContains(agentId, marker, 10_000);

      // Reconnect and rebind — server should flush pending queue.
      // IMPORTANT: Register the data handler BEFORE sending bind-channel,
      // because the server flushes queued messages synchronously before
      // sending the channel-bound response.
      const ws2 = await connectWs();
      await waitForMessage(ws2, (m) => m.type === 'agents');

      const flushPromise = waitForChannelMarkerOccurrences(ws2, channelId, marker, 1, 10_000);

      sendJson(ws2, { type: 'bind-channel', channelId });
      const msg = await flushPromise;

      expect(msg.markerSeen).toBeGreaterThanOrEqual(1);
      await killAgentViaHttp(agentId);
      const ws2Closed = waitForSocketClose(ws2);
      ws2.close();
      await ws2Closed;
    });

    it('emits ResetRequired when disconnected backlog exceeds the byte limit', async () => {
      const agentId = `pq-evict-${Date.now()}`;
      const channelId = createChannelId();
      const oldMarker = `__PQ_OLD_${Date.now()}__`;
      const newMarker = `__PQ_NEW_${Date.now()}__`;
      const tailMarker = `__PQ_TAIL_${Date.now()}__`;
      const ws1 = await connectWs();

      try {
        await waitForMessage(ws1, (m) => m.type === 'agents', 10_000);
        sendJson(ws1, { type: 'bind-channel', channelId });
        await waitForMessage(
          ws1,
          (m) => m.type === 'channel-bound' && m.channelId === channelId,
          10_000,
        );
        await spawnAgentViaHttp({
          taskId: 'pq-evict-task',
          agentId,
          command: '/bin/sh',
          channelId,
          env: {
            PENDING_OLD_MARKER: oldMarker,
            PENDING_NEW_MARKER: newMarker,
            PENDING_TAIL_MARKER: tailMarker,
          },
        });
        await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

        const ws1Closed = waitForSocketClose(ws1);
        ws1.close();
        await ws1Closed;

        await writeToAgentViaHttp(
          agentId,
          'yes "$PENDING_OLD_MARKER" | head -n 5000; yes "$PENDING_NEW_MARKER" | head -n 130000; echo "$PENDING_TAIL_MARKER"\n',
        );
        await waitForScrollbackContains(agentId, tailMarker, 20_000);

        const ws2 = await connectWs();
        try {
          await waitForMessage(ws2, (m) => m.type === 'agents', 10_000);
          const resetPromise = waitForMessage(
            ws2,
            (msg) =>
              msg.type === 'channel' &&
              msg.channelId === channelId &&
              typeof msg.payload === 'object' &&
              msg.payload !== null &&
              (msg.payload as { type?: unknown }).type === 'ResetRequired',
            20_000,
          );

          sendJson(ws2, { type: 'bind-channel', channelId });
          const resetMessage = await resetPromise;
          const payload = resetMessage.payload as { type: string; reason?: string };

          expect(payload).toMatchObject({
            type: 'ResetRequired',
            reason: 'backpressure',
          });
        } finally {
          const ws2Closed = waitForSocketClose(ws2);
          ws2.close();
          await ws2Closed;
        }
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
      }
    });

    it('flushes queued UUID channel messages as binary frames', async () => {
      const agentId = `pq-binary-${Date.now()}`;
      const channelId = createChannelId();
      const marker = `__PQ_BINARY_${Date.now()}__`;
      const ws1 = await connectWs();

      try {
        await waitForMessage(ws1, (m) => m.type === 'agents', 10_000);
        sendJson(ws1, { type: 'bind-channel', channelId });
        await waitForMessage(
          ws1,
          (m) => m.type === 'channel-bound' && m.channelId === channelId,
          10_000,
        );
        await spawnAgentViaHttp({
          taskId: 'pq-binary-task',
          agentId,
          command: '/bin/sh',
          channelId,
          env: { PENDING_BINARY_MARKER: marker },
        });
        await waitForMessage(ws1, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

        const ws1Closed = waitForSocketClose(ws1);
        ws1.close();
        await ws1Closed;

        await writeToAgentViaHttp(agentId, 'echo "$PENDING_BINARY_MARKER"\n');
        await waitForScrollbackContains(agentId, marker, 20_000);

        const ws2 = await connectWs();
        try {
          await waitForMessage(ws2, (m) => m.type === 'agents', 10_000);
          const flushPromise = waitForRawMessage(
            ws2,
            (msg, isBinary) =>
              isBinary === true && !!msg && channelMessageContains(msg, channelId, marker),
            15_000,
          );

          sendJson(ws2, { type: 'bind-channel', channelId });
          const { msg, isBinary } = await flushPromise;

          expect(isBinary).toBe(true);
          expect(msg?.type).toBe('channel');
        } finally {
          const ws2Closed = waitForSocketClose(ws2);
          ws2.close();
          await ws2Closed;
        }
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
      }
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

      const scrollbackText = await waitForScrollbackContains(agentId, marker);
      expect(scrollbackText).toContain(marker);

      await killAgentViaHttp(agentId);
      ws.close();
    });

    it('captures deterministic wrap fixture output in scrollback text', async () => {
      const agentId = `wrap-fixture-${Date.now()}`;
      const channelId = createChannelId();
      const ws = await connectWs();

      try {
        await waitForMessage(ws, (m) => m.type === 'agents', 10_000);
        sendJson(ws, { type: 'bind-channel', channelId });
        await waitForMessage(
          ws,
          (m) => m.type === 'channel-bound' && m.channelId === channelId,
          10_000,
        );
        await spawnAgentViaHttp({
          taskId: 'wrap-fixture-task',
          agentId,
          command: '/bin/sh',
          channelId,
        });
        await waitForMessage(ws, (m) => m.type === 'channel' && m.channelId === channelId, 10_000);

        await writeToAgentViaHttp(agentId, getFixtureCommand('tui-wrap.mjs', [3, 160]));
        await waitForChannelMarkerOccurrences(ws, channelId, 'wrap fixture ready', 1, 15_000);
        const scrollbackText = await waitForScrollbackContains(
          agentId,
          'wrap fixture ready',
          5_000,
        );

        expect(scrollbackText).toContain('=== wrap fixture ===');
        expect(scrollbackText).toContain('1: wrap-check');
        expect(scrollbackText).toContain('wrap fixture ready');
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
        ws.close();
      }
    });

    it('replays deterministic scrollback fixture output after channel reattach', async () => {
      const agentId = `scrollback-fixture-${Date.now()}`;
      const firstChannelId = createChannelId();
      const secondChannelId = createChannelId();
      const ws1 = await connectWs();

      try {
        await waitForMessage(ws1, (m) => m.type === 'agents', 10_000);
        sendJson(ws1, { type: 'bind-channel', channelId: firstChannelId });
        await waitForMessage(
          ws1,
          (m) => m.type === 'channel-bound' && m.channelId === firstChannelId,
          10_000,
        );
        await spawnAgentViaHttp({
          taskId: 'scrollback-fixture-task',
          agentId,
          command: '/bin/sh',
          channelId: firstChannelId,
        });
        await waitForMessage(
          ws1,
          (m) => m.type === 'channel' && m.channelId === firstChannelId,
          10_000,
        );

        await writeToAgentViaHttp(agentId, getFixtureCommand('tui-scrollback.mjs', [60, 48]));
        await waitForScrollbackContains(agentId, 'scrollback fixture ready', 15_000);

        const ws1Closed = waitForSocketClose(ws1);
        ws1.close();
        await ws1Closed;

        const ws2 = await connectWs();
        try {
          await waitForMessage(ws2, (m) => m.type === 'agents', 10_000);
          sendJson(ws2, { type: 'bind-channel', channelId: secondChannelId });
          await waitForMessage(
            ws2,
            (m) => m.type === 'channel-bound' && m.channelId === secondChannelId,
            10_000,
          );

          const replayPromise = waitForChannelMarkerOccurrences(
            ws2,
            secondChannelId,
            'scrollback fixture ready',
            1,
            15_000,
          );
          await spawnAgentViaHttp({
            taskId: 'scrollback-fixture-task',
            agentId,
            command: '/bin/sh',
            channelId: secondChannelId,
          });

          const replay = await replayPromise;
          expect(replay.allText).toContain('00001 scrollback');
          expect(replay.allText).toContain('00060 scrollback');
          expect(replay.allText).toContain('scrollback fixture ready');
        } finally {
          const ws2Closed = waitForSocketClose(ws2);
          ws2.close();
          await ws2Closed;
        }
      } finally {
        await killAgentViaHttp(agentId).catch(() => {});
      }
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
      await detachAgentOutputViaHttp(agentId, channelId1);

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
      const resultPromise = waitForChannelMarkerOccurrences(ws, channelId, marker, 2, 30_000);

      sendJson(ws, {
        type: 'input',
        agentId,
        data: `M=${marker}; seq 1 10000; echo $M\n`,
      });

      const result = await resultPromise;
      expect(result.markerSeen).toBeGreaterThanOrEqual(2);
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
      const resultPromise = waitForChannelMarkerOccurrences(ws, channelId, marker, 2, 30_000);

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

      const resultPromise = waitForChannelMarkerOccurrences(ws, channelId, endMarker, 1, 30_000);

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
        rtts.push(await measureEchoRoundTrip(ws, agentId, channelId, marker, 5_000));
      }

      rtts.sort((a, b) => a - b);
      const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
      const p50 = rtts[Math.floor(rtts.length * 0.5)];
      const min = rtts[0];
      const max = rtts[rtts.length - 1];
      const slowSampleCount = rtts.filter((value) => value >= 15).length;

      console.warn(`  RTT Benchmark (${sampleCount} samples):`);
      console.warn(
        `    min=${min.toFixed(1)}ms avg=${avg.toFixed(1)}ms p50=${p50.toFixed(1)}ms slow>=15ms=${slowSampleCount} max=${max.toFixed(1)}ms`,
      );

      // On localhost, the interactive path should stay well below the old
      // 15-30ms browser-typing envelope that prompted this work.
      expect(p50).toBeLessThan(5);
      expect(avg).toBeLessThan(8);
      expect(slowSampleCount).toBeLessThanOrEqual(1);
      expect(max).toBeLessThan(25);
    });
  });
});
