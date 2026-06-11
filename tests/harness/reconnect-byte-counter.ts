export interface SendCapableSocket {
  send(payload: string | Buffer): void;
}

export interface ReconnectHandshakeByteCounterOptions {
  isHandshakeComplete?: (message: unknown) => boolean;
}

export interface ReconnectHandshakeByteCounter {
  begin: () => void;
  detach: () => void;
  getBytesByMessageType: () => Record<string, number>;
  getMessageCount: () => number;
  getTotalBytes: () => number;
  isCounting: () => boolean;
  isHandshakeComplete: () => boolean;
}

function getPayloadByteLength(payload: string | Buffer): number {
  return typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.byteLength;
}

function getPayloadMessageType(payload: string | Buffer): string {
  if (typeof payload !== 'string') {
    return 'binary-frame';
  }

  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return (parsed as { type: string }).type;
    }
  } catch {
    return 'unparsed-text';
  }

  return 'untyped-json';
}

function parsePayloadMessage(payload: string | Buffer): unknown {
  if (typeof payload !== 'string') {
    return null;
  }

  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

function isStateBootstrapMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'state-bootstrap'
  );
}

export function attachReconnectHandshakeByteCounter(
  socket: SendCapableSocket,
  options?: ReconnectHandshakeByteCounterOptions,
): ReconnectHandshakeByteCounter {
  const isHandshakeCompleteMessage = options?.isHandshakeComplete ?? isStateBootstrapMessage;
  const originalSend = socket.send.bind(socket);
  let counting = false;
  let handshakeComplete = false;
  let totalBytes = 0;
  let messageCount = 0;
  let bytesByMessageType: Record<string, number> = {};

  socket.send = (payload: string | Buffer): void => {
    if (counting) {
      const byteLength = getPayloadByteLength(payload);
      const messageType = getPayloadMessageType(payload);
      totalBytes += byteLength;
      messageCount += 1;
      bytesByMessageType[messageType] = (bytesByMessageType[messageType] ?? 0) + byteLength;

      if (isHandshakeCompleteMessage(parsePayloadMessage(payload))) {
        counting = false;
        handshakeComplete = true;
      }
    }

    originalSend(payload);
  };

  return {
    begin: () => {
      counting = true;
      handshakeComplete = false;
      totalBytes = 0;
      messageCount = 0;
      bytesByMessageType = {};
    },
    detach: () => {
      counting = false;
      socket.send = originalSend;
    },
    getBytesByMessageType: () => ({ ...bytesByMessageType }),
    getMessageCount: () => messageCount,
    getTotalBytes: () => totalBytes,
    isCounting: () => counting,
    isHandshakeComplete: () => handshakeComplete,
  };
}
