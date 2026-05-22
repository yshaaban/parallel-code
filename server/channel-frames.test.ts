import { describe, expect, it } from 'vitest';

import { buildBinaryChannelFrame, createQueuedChannelMessage } from './channel-frames.js';

const CHANNEL_ID = '12345678-1234-1234-1234-123456789012';

describe('channel frames', () => {
  it('does not turn malformed base64 data into binary terminal bytes', () => {
    expect(buildBinaryChannelFrame(CHANNEL_ID, 'not-valid-base64!')).toBeNull();
    expect(buildBinaryChannelFrame(CHANNEL_ID, 'abc')).toBeNull();
  });

  it('keeps malformed data payloads on the JSON path instead of binary framing', () => {
    const message = createQueuedChannelMessage(CHANNEL_ID, {
      data: 'AB==',
      type: 'Data',
    });

    expect(Buffer.isBuffer(message.data)).toBe(false);
    expect(JSON.parse(String(message.data))).toMatchObject({
      channelId: CHANNEL_ID,
      payload: {
        data: 'AB==',
        type: 'Data',
      },
      type: 'channel',
    });
  });
});
