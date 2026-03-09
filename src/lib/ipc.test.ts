import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const CHANNEL_DATA_FRAME_TYPE = 0x01;

function createBinaryFrame(channelId: string, data = 'hello'): ArrayBuffer {
  const channelBytes = new TextEncoder().encode(channelId);
  const payloadBytes = new TextEncoder().encode(data);
  const frame = new Uint8Array(1 + channelBytes.length + payloadBytes.length);
  frame[0] = CHANNEL_DATA_FRAME_TYPE;
  frame.set(channelBytes, 1);
  frame.set(payloadBytes, 1 + channelBytes.length);
  return frame.buffer;
}

describe('parseBrowserBinaryChannelFrame', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses valid UUID channel frames', async () => {
    const { parseBrowserBinaryChannelFrame } = await import('./ipc');
    const parsed = parseBrowserBinaryChannelFrame(
      createBinaryFrame('12345678-1234-1234-1234-123456789012', 'hello'),
    );

    expect(parsed?.channelId).toBe('12345678-1234-1234-1234-123456789012');
    expect(new TextDecoder().decode(parsed?.data)).toBe('hello');
  });

  it('ignores short frames', async () => {
    const { parseBrowserBinaryChannelFrame } = await import('./ipc');
    expect(parseBrowserBinaryChannelFrame(new Uint8Array([CHANNEL_DATA_FRAME_TYPE]).buffer)).toBe(
      null,
    );
  });

  it('warns and ignores malformed channel headers', async () => {
    const { parseBrowserBinaryChannelFrame } = await import('./ipc');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      parseBrowserBinaryChannelFrame(createBinaryFrame('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')),
    ).toBe(null);
    expect(warn).toHaveBeenCalledWith('[ipc] Ignoring malformed channel frame header');
  });
});

describe('Channel', () => {
  const storage = new Map<string, string>();
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalWebSocket = globalThis.WebSocket;

  class FailingWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    binaryType: BinaryType = 'blob';
    onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
    onmessage:
      | ((this: WebSocket, ev: MessageEvent<string | ArrayBuffer | Blob>) => unknown)
      | null = null;
    onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
    onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
    readyState = FailingWebSocket.CONNECTING;

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = FailingWebSocket.CLOSED;
        this.onerror?.call(this as unknown as WebSocket, {} as Event);
        this.onclose?.call(this as unknown as WebSocket, { code: 1006 } as CloseEvent);
      });
    }

    close(): void {
      this.readyState = FailingWebSocket.CLOSED;
    }

    send(): void {}
  }

  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    storage.set('parallel-code-token', 'test-token');

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: new URL('http://localhost/terminal'),
        history: { replaceState: vi.fn() },
        addEventListener: vi.fn(),
        setTimeout,
        clearTimeout,
        electron: undefined,
      },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        hidden: false,
      },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key);
        }),
      },
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: FailingWebSocket,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: originalWebSocket,
    });
  });

  it('keeps ready pending when the initial bind send fails', async () => {
    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();

    const readyState = await Promise.race([
      channel.ready.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ]);

    expect(readyState).toBe('pending');

    channel.cleanup?.();
    await expect(channel.ready).rejects.toThrow('Channel cleaned up');
  });

  it('rejects pending ready when there is no auth token', async () => {
    storage.delete('parallel-code-token');
    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();

    await expect(channel.ready).rejects.toThrow('Missing auth token');
    channel.cleanup?.();
  });

  it('rejects pending ready when the server closes with auth-expired', async () => {
    class AuthExpiredWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      binaryType: BinaryType = 'blob';
      onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
      onmessage:
        | ((this: WebSocket, ev: MessageEvent<string | ArrayBuffer | Blob>) => unknown)
        | null = null;
      onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
      onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
      readyState = AuthExpiredWebSocket.CONNECTING;

      constructor(_url: string) {
        queueMicrotask(() => {
          this.readyState = AuthExpiredWebSocket.OPEN;
          this.onopen?.call(this as unknown as WebSocket, {} as Event);
          queueMicrotask(() => {
            this.readyState = AuthExpiredWebSocket.CLOSED;
            this.onclose?.call(this as unknown as WebSocket, { code: 4001 } as CloseEvent);
          });
        });
      }

      close(): void {
        this.readyState = AuthExpiredWebSocket.CLOSED;
      }

      send(): void {}
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: AuthExpiredWebSocket,
    });

    const { Channel } = await import('./ipc');
    const channel = new Channel<unknown>();

    await expect(channel.ready).rejects.toThrow('Browser session expired');
    channel.cleanup?.();
  });

  it('rejects invalid pause reasons instead of silently downgrading them', async () => {
    const { invoke } = await import('./ipc');

    await expect(
      invoke(IPC.PauseAgent, { agentId: 'agent-1', reason: 'restore ' }),
    ).rejects.toThrow('Invalid pause reason');
    await expect(
      invoke(IPC.ResumeAgent, { agentId: 'agent-1', reason: 'restore ' }),
    ).rejects.toThrow('Invalid pause reason');
  });
});
