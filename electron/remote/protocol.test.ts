import { describe, expect, it } from 'vitest';
import { MAX_CLIENT_INPUT_DATA_LENGTH, parseClientMessage } from './protocol.js';

describe('parseClientMessage', () => {
  it('accepts websocket input messages up to the configured maximum size', () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH),
        requestId: 'request-1',
      }),
    );

    expect(message).toEqual({
      type: 'input',
      agentId: 'agent-1',
      data: 'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH),
      requestId: 'request-1',
    });
  });

  it('rejects websocket input messages above the configured maximum size', () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'input',
        agentId: 'agent-1',
        data: 'x'.repeat(MAX_CLIENT_INPUT_DATA_LENGTH + 1),
      }),
    );

    expect(message).toBeNull();
  });

  it('normalizes update-presence messages to the canonical payload shape', () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: 'update-presence',
        displayName: 'Ivan',
        visibility: 'visible',
      }),
    );

    expect(message).toEqual({
      type: 'update-presence',
      activeTaskId: null,
      controllingAgentIds: [],
      controllingTaskIds: [],
      displayName: 'Ivan',
      focusedSurface: null,
      visibility: 'visible',
    });
  });
});
