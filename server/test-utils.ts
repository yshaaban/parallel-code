import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TEST_TOKEN = 'test-integration-token-' + Date.now();

let serverProcess: ChildProcess | null = null;
let testPort = 19876;

export interface ServerMessage {
  type: string;
  channelId?: string;
  payload?: unknown;
  agentId?: string;
  message?: string;
  data?: string;
  list?: Array<{ agentId: string }>;
  [key: string]: unknown;
}

export type WsMessageData = Buffer | string | ArrayBuffer | Buffer[];

const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;

export function createChannelId(): string {
  return randomUUID();
}

export function getTestPort(): number {
  return testPort;
}

export function getServerUrl(): string {
  return `ws://127.0.0.1:${testPort}`;
}

export function reserveTestPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a test port')));
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

function toBuffer(data: WsMessageData): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return null;
}

export function parseServerMessage(data: WsMessageData, isBinary: boolean): ServerMessage | null {
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

export function getChannelPayloadBytes(payload: unknown): Buffer | null {
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

export function getChannelText(msg: ServerMessage, channelId: string): string | null {
  if (msg.type !== 'channel' || msg.channelId !== channelId) return null;
  const bytes = getChannelPayloadBytes(msg.payload);
  return bytes ? bytes.toString('utf8') : null;
}

export function channelMessageContains(
  msg: ServerMessage,
  channelId: string,
  text: string,
): boolean {
  return getChannelText(msg, channelId)?.includes(text) ?? false;
}

export async function startServer(env: Record<string, string> = {}): Promise<void> {
  const serverPath = path.resolve(__dirname, '..', 'dist-server', 'server', 'main.js');
  testPort = await reserveTestPort();

  serverProcess = spawn('node', [serverPath], {
    env: {
      ...process.env,
      PORT: String(testPort),
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

export async function stopServer(): Promise<void> {
  const proc = serverProcess;
  serverProcess = null;
  if (!proc) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

export function connectWs(query = `?token=${TEST_TOKEN}`): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${getServerUrl()}/ws${query}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 5_000);

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
        for (const message of earlyMessages) {
          fn(message.data, message.isBinary);
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

export function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

export function waitForMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timed out waiting for message'));
    }, timeoutMs);

    function handler(data: WsMessageData, isBinary: boolean): void {
      const msg = parseServerMessage(data, isBinary);
      if (!msg || !predicate(msg)) return;
      clearTimeout(timeout);
      ws.removeListener('message', handler);
      resolve(msg);
    }

    ws.on('message', handler);
  });
}

export function waitForRawMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage | null, isBinary: boolean) => boolean,
  timeoutMs = 5_000,
): Promise<{ msg: ServerMessage | null; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timed out waiting for raw message'));
    }, timeoutMs);

    function handler(data: WsMessageData, isBinary: boolean): void {
      const msg = parseServerMessage(data, isBinary);
      if (!predicate(msg, isBinary)) return;
      clearTimeout(timeout);
      ws.removeListener('message', handler);
      resolve({ msg, isBinary });
    }

    ws.on('message', handler);
  });
}

export function collectMessages(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  durationMs: number,
): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const messages: ServerMessage[] = [];

    function handler(data: WsMessageData, isBinary: boolean): void {
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

export function collectSequencedMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5_000,
): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: ServerMessage[] = [];
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timed out waiting for sequenced messages'));
    }, timeoutMs);

    function handler(data: WsMessageData, isBinary: boolean): void {
      const msg = parseServerMessage(data, isBinary);
      if (!msg || typeof msg.seq !== 'number') return;
      messages.push(msg);
      if (messages.length >= count) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(messages);
      }
    }

    ws.on('message', handler);
  });
}

export async function waitForCondition<T>(
  action: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    description?: string;
  } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 50;
  const description = opts.description ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const value = await action();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError instanceof Error) {
    throw new Error(`Timed out waiting for ${description}: ${lastError.message}`);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export function waitForSocketClose(ws: WebSocket, timeoutMs = 5_000): Promise<number> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(1000);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('close', onClose);
      reject(new Error('Timed out waiting for socket close'));
    }, timeoutMs);

    function onClose(code: number): void {
      clearTimeout(timeout);
      ws.removeListener('close', onClose);
      resolve(code);
    }

    ws.on('close', onClose);
  });
}

export function expectNoMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  durationMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve();
    }, durationMs);

    function handler(data: WsMessageData, isBinary: boolean): void {
      const msg = parseServerMessage(data, isBinary);
      if (!msg || !predicate(msg)) return;
      clearTimeout(timeout);
      ws.removeListener('message', handler);
      reject(new Error('Received an unexpected message'));
    }

    ws.on('message', handler);
  });
}

export function waitForAgentLifecycleEvent(
  ws: WebSocket,
  agentId: string,
  event: 'spawn' | 'exit' | 'pause' | 'resume',
  timeoutMs = 5_000,
): Promise<ServerMessage> {
  return waitForMessage(
    ws,
    (msg) =>
      msg.type === 'agent-lifecycle' &&
      msg.agentId === agentId &&
      (msg as { event?: unknown }).event === event,
    timeoutMs,
  );
}

function createChunkSafeMarkerCounter(marker: string): {
  push: (chunk: string) => number;
  getCount: () => number;
} {
  let carry = '';
  let count = 0;
  const carryLength = Math.max(marker.length - 1, 0);

  return {
    push(chunk: string): number {
      const combined = carry + chunk;
      let idx = 0;
      while ((idx = combined.indexOf(marker, idx)) !== -1) {
        count += 1;
        idx += marker.length;
      }
      carry = carryLength > 0 ? combined.slice(-carryLength) : '';
      return count;
    },
    getCount(): number {
      return count;
    },
  };
}

export function waitForChannelMarkerOccurrences(
  ws: WebSocket,
  channelId: string,
  marker: string,
  occurrences: number,
  timeoutMs = 5_000,
): Promise<{ totalBytes: number; allText: string; markerSeen: number }> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    let allText = '';
    const counter = createChunkSafeMarkerCounter(marker);
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(
        new Error(
          `Timeout waiting for marker ${JSON.stringify(marker)}. Got ${totalBytes} bytes, marker seen ${counter.getCount()}x`,
        ),
      );
    }, timeoutMs);

    function handler(data: WsMessageData, isBinary: boolean): void {
      const msg = parseServerMessage(data, isBinary);
      const decoded = msg?.channelId === channelId ? getChannelPayloadBytes(msg.payload) : null;
      if (!decoded) return;
      totalBytes += decoded.length;
      const text = decoded.toString('utf8');
      allText += text;
      const markerSeen = counter.push(text);
      if (markerSeen >= occurrences) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve({ totalBytes, allText, markerSeen });
      }
    }

    ws.on('message', handler);
  });
}

export async function invokeIpcViaHttp<T>(channel: string, body: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${getTestPort()}/api/ipc/${channel}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const payload = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok) {
    throw new Error(`${channel} failed (${res.status}): ${payload.error ?? 'unknown error'}`);
  }
  return payload.result as T;
}

export async function spawnAgentViaHttp(opts: {
  taskId: string;
  agentId: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  channelId?: string;
  env?: Record<string, string>;
}): Promise<void> {
  const body = {
    taskId: opts.taskId,
    agentId: opts.agentId,
    command: opts.command,
    args: opts.args ?? [],
    cwd: '/tmp',
    env: opts.env ?? {},
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    isShell: true,
    onOutput: { __CHANNEL_ID__: opts.channelId ?? `ch-${opts.agentId}` },
  };
  await invokeIpcViaHttp('spawn_agent', body);
}

export async function killAgentViaHttp(agentId: string): Promise<void> {
  await invokeIpcViaHttp('kill_agent', { agentId });
}

export async function writeToAgentViaHttp(agentId: string, data: string): Promise<void> {
  await invokeIpcViaHttp('write_to_agent', { agentId, data });
}

export async function detachAgentOutputViaHttp(agentId: string, channelId: string): Promise<void> {
  await invokeIpcViaHttp('detach_agent_output', { agentId, channelId });
}

export async function getAgentScrollbackTextViaHttp(agentId: string): Promise<string> {
  const scrollback = await invokeIpcViaHttp<string | null>('get_agent_scrollback', { agentId });
  return Buffer.from(scrollback ?? '', 'base64').toString('utf8');
}

export function waitForScrollbackContains(
  agentId: string,
  text: string,
  timeoutMs = 5_000,
): Promise<string> {
  return waitForCondition(
    () => getAgentScrollbackTextViaHttp(agentId),
    (scrollback) => scrollback.includes(text),
    {
      timeoutMs,
      intervalMs: 50,
      description: `scrollback for ${agentId} to contain ${JSON.stringify(text)}`,
    },
  );
}

export async function measureEchoRoundTrip(
  ws: WebSocket,
  agentId: string,
  channelId: string,
  marker: string,
  timeoutMs = 5_000,
): Promise<number> {
  const resultPromise = waitForChannelMarkerOccurrences(ws, channelId, marker, 2, timeoutMs);
  const sendTime = performance.now();
  sendJson(ws, { type: 'input', agentId, data: `M=${marker}; echo $M\n` });
  await resultPromise;
  return performance.now() - sendTime;
}
