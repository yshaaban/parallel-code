import type { ServerMessage } from '../electron/remote/protocol.js';

export interface QueuedMessage {
  data: string | Buffer;
  sizeBytes: number;
}

const CHANNEL_DATA_FRAME_TYPE = 0x01;
const CHANNEL_ID_BYTES = 36;
const CHANNEL_BINARY_HEADER_BYTES = 1 + CHANNEL_ID_BYTES;
const UUID_CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildChannelJsonMessage(channelId: string, payload: unknown): string {
  return JSON.stringify({ type: 'channel', channelId, payload } satisfies ServerMessage);
}

export function isChannelDataPayload(payload: unknown): payload is { type: 'Data'; data: string } {
  const candidate = payload as { type?: unknown; data?: unknown } | null;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    candidate?.type === 'Data' &&
    typeof candidate.data === 'string'
  );
}

export function buildBinaryChannelFrame(channelId: string, base64Data: string): Buffer | null {
  if (!UUID_CHANNEL_ID_RE.test(channelId)) return null;

  const rawDataLength = Buffer.byteLength(base64Data, 'base64');
  const frame = Buffer.allocUnsafe(CHANNEL_BINARY_HEADER_BYTES + rawDataLength);
  frame[0] = CHANNEL_DATA_FRAME_TYPE;
  frame.write(channelId, 1, CHANNEL_ID_BYTES, 'ascii');
  const bytesWritten = frame.write(
    base64Data,
    CHANNEL_BINARY_HEADER_BYTES,
    rawDataLength,
    'base64',
  );
  return bytesWritten === rawDataLength ? frame : null;
}

export function createQueuedChannelMessage(channelId: string, payload: unknown): QueuedMessage {
  if (isChannelDataPayload(payload)) {
    const binaryFrame = buildBinaryChannelFrame(channelId, payload.data);
    if (binaryFrame) {
      return {
        data: binaryFrame,
        sizeBytes: binaryFrame.length,
      };
    }
  }

  const json = buildChannelJsonMessage(channelId, payload);
  return {
    data: json,
    sizeBytes: Buffer.byteLength(json),
  };
}
