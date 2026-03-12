import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import {
  collectMessages,
  expectNoMessage,
  type ServerMessage,
  trackSocketMessages,
  waitForMessage,
} from './test-utils.js';

class FakeWebSocket extends EventEmitter {
  readyState = 1;
}

function emitServerMessage(ws: FakeWebSocket, message: ServerMessage, isBinary = false): void {
  ws.emit('message', JSON.stringify(message), isBinary);
}

describe('test-utils buffered message helpers', () => {
  it('waitForMessage resolves from a message buffered before the waiter is attached', async () => {
    const ws = new FakeWebSocket() as unknown as import('ws').WebSocket;
    trackSocketMessages(ws);

    emitServerMessage(ws as unknown as FakeWebSocket, {
      type: 'agent-lifecycle',
      agentId: 'agent-1',
      event: 'pause',
    });

    await expect(
      waitForMessage(
        ws,
        (message) =>
          message.type === 'agent-lifecycle' &&
          message.agentId === 'agent-1' &&
          message.event === 'pause',
        100,
      ),
    ).resolves.toMatchObject({
      type: 'agent-lifecycle',
      agentId: 'agent-1',
      event: 'pause',
    });
  });

  it('collectMessages includes matching buffered messages that arrived before collection started', async () => {
    const ws = new FakeWebSocket() as unknown as import('ws').WebSocket;
    trackSocketMessages(ws);

    emitServerMessage(ws as unknown as FakeWebSocket, {
      type: 'channel',
      channelId: 'ch-1',
      payload: {
        type: 'Data',
        data: Buffer.from('first', 'utf8').toString('base64'),
      },
    });

    const collected = await collectMessages(
      ws,
      (message) => message.type === 'channel' && message.channelId === 'ch-1',
      10,
    );

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: 'channel',
      channelId: 'ch-1',
    });
  });

  it('expectNoMessage fails on an already buffered matching message', async () => {
    const ws = new FakeWebSocket() as unknown as import('ws').WebSocket;
    trackSocketMessages(ws);

    emitServerMessage(ws as unknown as FakeWebSocket, {
      type: 'remote-status',
      connectedClients: 2,
      peerClients: 1,
    });

    await expect(
      expectNoMessage(ws, (message) => message.type === 'remote-status', 10),
    ).rejects.toThrow('Received an unexpected buffered message');
  });
});
