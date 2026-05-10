import type { ClientMessage } from '../../electron/remote/protocol';
import { createRandomId } from './random-id';

const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;
const CHANNEL_ID_DECODER = new TextDecoder();
const UUID_CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PendingReadyResolver {
  reject: (reason?: unknown) => void;
  resolve: () => void;
}

export interface BrowserBinaryChannelFrame {
  channelId: string;
  data: Uint8Array;
}

export interface BrowserChannelMessageTiming {
  receivedAtMs: number;
}

export interface BrowserChannelState<T> {
  cleanup: () => void;
  id: string;
  ready: Promise<void>;
  setOnMessage: (listener: ((message: T) => void) | null) => void;
}

export interface BrowserChannelClient {
  createChannel: <T>() => BrowserChannelState<T>;
  handleBinaryMessage: (buffer: ArrayBuffer) => void;
  handleChannelBound: (channelId: string) => void;
  handleChannelPayload: (channelId: string, payload: unknown) => void;
  hasBoundChannels: () => boolean;
  rejectPendingReady: (error: unknown) => void;
  rebindChannels: () => void;
  resetForTests: () => void;
}

export interface CreateBrowserChannelClientOptions {
  sendCommand: (message: ClientMessage) => Promise<void>;
}

const browserChannelMessageTimings = new WeakMap<object, BrowserChannelMessageTiming>();

function ignoreErrorAsync<T>(promise: Promise<T>): void {
  void promise.catch(() => {});
}

function bindChannel(
  channelId: string,
  sendCommand: (message: ClientMessage) => Promise<void>,
): void {
  ignoreErrorAsync(
    sendCommand({
      type: 'bind-channel',
      channelId,
    }),
  );
}

export function parseBrowserBinaryChannelFrame(
  buffer: ArrayBuffer,
): BrowserBinaryChannelFrame | null {
  const frame = new Uint8Array(buffer);
  if (frame.length < CHANNEL_BINARY_HEADER_BYTES || frame[0] !== CHANNEL_DATA_FRAME_TYPE) {
    return null;
  }

  const channelId = CHANNEL_ID_DECODER.decode(frame.subarray(1, CHANNEL_BINARY_HEADER_BYTES));
  if (!UUID_CHANNEL_ID_RE.test(channelId)) {
    console.warn('[ipc] Ignoring malformed channel frame header');
    return null;
  }

  return {
    channelId,
    data: frame.subarray(CHANNEL_BINARY_HEADER_BYTES),
  };
}

export function createBrowserChannelClient(
  options: CreateBrowserChannelClientOptions,
): BrowserChannelClient {
  const channelListeners = new Map<string, (message: unknown) => void>();
  const channelReadyResolvers = new Map<string, PendingReadyResolver>();
  const boundChannelIds = new Set<string>();

  function handleChannelPayload(channelId: string, payload: unknown): void {
    channelListeners.get(channelId)?.(payload);
  }

  function handleChannelBound(channelId: string): void {
    channelReadyResolvers.get(channelId)?.resolve();
    channelReadyResolvers.delete(channelId);
  }

  function handleBinaryMessage(buffer: ArrayBuffer): void {
    const receivedAtMs = performance.now();
    const message = parseBrowserBinaryChannelFrame(buffer);
    if (!message) {
      return;
    }

    const payload = {
      type: 'Data',
      data: message.data,
    };
    browserChannelMessageTimings.set(payload, { receivedAtMs });
    handleChannelPayload(message.channelId, payload);
  }

  function hasBoundChannels(): boolean {
    return boundChannelIds.size > 0;
  }

  function rejectPendingReady(error: unknown): void {
    channelReadyResolvers.forEach(({ reject }) => reject(error));
    channelReadyResolvers.clear();
  }

  function rebindChannels(): void {
    for (const channelId of boundChannelIds) {
      bindChannel(channelId, options.sendCommand);
    }
  }

  function createChannel<T>(): BrowserChannelState<T> {
    const channelId = createRandomId();
    let onMessage: ((message: T) => void) | null = null;

    channelListeners.set(channelId, (message: unknown) => {
      onMessage?.(message as T);
    });
    boundChannelIds.add(channelId);

    const ready = new Promise<void>((resolve, reject) => {
      channelReadyResolvers.set(channelId, { resolve, reject });
    });

    bindChannel(channelId, options.sendCommand);

    return {
      cleanup: () => {
        channelListeners.delete(channelId);
        channelReadyResolvers.get(channelId)?.reject(new Error('Channel cleaned up'));
        channelReadyResolvers.delete(channelId);
        boundChannelIds.delete(channelId);
        ignoreErrorAsync(
          options.sendCommand({
            type: 'unbind-channel',
            channelId,
          }),
        );
      },
      id: channelId,
      ready,
      setOnMessage: (listener) => {
        onMessage = listener;
      },
    };
  }

  function resetForTests(): void {
    rejectPendingReady(new Error('Browser channel client reset for tests'));
    channelListeners.clear();
    boundChannelIds.clear();
  }

  return {
    createChannel,
    handleBinaryMessage,
    handleChannelBound,
    handleChannelPayload,
    hasBoundChannels,
    rejectPendingReady,
    rebindChannels,
    resetForTests,
  };
}

export function getBrowserChannelMessageTiming(
  message: unknown,
): BrowserChannelMessageTiming | null {
  if (typeof message !== 'object' || message === null) {
    return null;
  }

  return browserChannelMessageTimings.get(message) ?? null;
}
