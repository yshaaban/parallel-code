import { describe, expect, it } from 'vitest';
import {
  MAX_CLIENT_INPUT_DATA_LENGTH,
  isServerMessage,
  parseClientMessage,
  type ServerMessage,
} from './protocol.js';

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

  it('parses agent-scoped lifecycle commands through the shared finite command guards', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'subscribe', agentId: 'agent-1' }))).toEqual({
      type: 'subscribe',
      agentId: 'agent-1',
    });
    expect(parseClientMessage(JSON.stringify({ type: 'unsubscribe', agentId: 'agent-1' }))).toEqual(
      {
        type: 'unsubscribe',
        agentId: 'agent-1',
      },
    );
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'pause',
          agentId: 'agent-1',
          channelId: 'channel-1',
          reason: 'manual',
        }),
      ),
    ).toEqual({
      type: 'pause',
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'manual',
    });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'resume',
          agentId: 'agent-1',
          channelId: 'channel-1',
          reason: 'manual',
        }),
      ),
    ).toEqual({
      type: 'resume',
      agentId: 'agent-1',
      channelId: 'channel-1',
      reason: 'manual',
    });
  });

  it('accepts terminal input trace updates with optional browser transport receive timing', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'terminal-input-trace',
          agentId: 'agent-1',
          outputReceivedAtMs: 120,
          outputRenderedAtMs: 135,
          outputTransportReceivedAtMs: 115,
          requestId: 'request-1',
        }),
      ),
    ).toEqual({
      type: 'terminal-input-trace',
      agentId: 'agent-1',
      outputReceivedAtMs: 120,
      outputRenderedAtMs: 135,
      outputTransportReceivedAtMs: 115,
      requestId: 'request-1',
    });

    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'terminal-input-trace',
          agentId: 'agent-1',
          outputReceivedAtMs: 120,
          outputRenderedAtMs: 135,
          outputTransportReceivedAtMs: -1,
          requestId: 'request-1',
        }),
      ),
    ).toBeNull();
  });

  it('rejects primitive JSON, unknown types, and malformed finite states', () => {
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage('[]')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'future-client-event' }))).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'permission-response',
          action: 'maybe',
          agentId: 'agent-1',
          requestId: 'request-1',
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'update-presence',
          displayName: 'Ivan',
          visibility: 'foreground',
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'pause',
          agentId: 'agent-1',
          channelId: 123,
          reason: 'manual',
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'resume',
          agentId: 'agent-1',
          reason: 'unexpected',
        }),
      ),
    ).toBeNull();
  });

  it('requires paired task-control context and typed terminal trace payloads', () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'input',
          agentId: 'agent-1',
          controllerId: 'client-1',
          data: 'hello',
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'resize',
          agentId: 'agent-1',
          cols: 80,
          rows: 24,
          taskId: 'task-1',
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'input',
          agentId: 'agent-1',
          data: 'hello',
          taskId: 'task-1',
          controllerId: 'client-1',
          trace: {
            bufferedAtMs: 2,
            inputChars: 5,
            inputKind: 'surprise',
            sendStartedAtMs: 3,
            startedAtMs: 1,
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'input',
          agentId: 'agent-1',
          data: 'hello',
          taskId: 'task-1',
          controllerId: 'client-1',
          trace: {
            bufferedAtMs: 2,
            echoText: 'x'.repeat(513),
            inputChars: 5,
            inputKind: 'interactive',
            sendStartedAtMs: 3,
            startedAtMs: 1,
          },
        }),
      ),
    ).toBeNull();

    expect(
      parseClientMessage(
        JSON.stringify({
          type: 'input',
          agentId: 'agent-1',
          data: 'hello',
          taskId: 'task-1',
          controllerId: 'client-1',
          trace: {
            bufferedAtMs: 2,
            echoText: 'hello',
            inputChars: 5,
            inputKind: 'interactive',
            sendStartedAtMs: 3,
            startedAtMs: 1,
          },
        }),
      ),
    ).toEqual({
      type: 'input',
      agentId: 'agent-1',
      controllerId: 'client-1',
      data: 'hello',
      taskId: 'task-1',
      trace: {
        bufferedAtMs: 2,
        echoText: 'hello',
        inputChars: 5,
        inputKind: 'interactive',
        sendStartedAtMs: 3,
        startedAtMs: 1,
      },
    });
  });
});

describe('isServerMessage', () => {
  const validServerMessages = [
    {
      type: 'agents',
      list: [
        {
          agentId: 'agent-1',
          exitCode: null,
          lastLine: '',
          status: 'running',
          taskId: 'task-1',
          taskName: 'Task 1',
        },
      ],
    },
    {
      type: 'agent-command-result',
      accepted: true,
      agentId: 'agent-1',
      command: 'input',
      requestId: 'request-1',
    },
    {
      type: 'agent-controller',
      agentId: 'agent-1',
      controllerId: 'client-1',
      seq: 0,
    },
    {
      type: 'agent-error',
      agentId: 'agent-1',
      message: 'write failed',
    },
    {
      type: 'agent-lifecycle',
      agentId: 'agent-1',
      event: 'spawn',
      isShell: false,
      status: 'running',
      taskId: 'task-1',
      seq: 1,
    },
    {
      type: 'channel',
      channelId: 'channel-1',
      payload: { ready: true },
    },
    {
      type: 'channel-bound',
      channelId: 'channel-1',
    },
    {
      type: 'git-status-changed',
      status: {
        has_committed_changes: false,
        has_uncommitted_changes: true,
      },
      worktreePath: '/tmp/task-1',
      seq: 2,
    },
    {
      type: 'ipc-event',
      channel: 'task-review-changed',
      payload: { taskId: 'task-1' },
      seq: 3,
    },
    {
      type: 'output',
      agentId: 'agent-1',
      data: Buffer.from('ready', 'utf8').toString('base64'),
    },
    {
      type: 'peer-presences',
      list: [
        {
          activeTaskId: 'task-1',
          clientId: 'client-1',
          controllingAgentIds: [],
          controllingTaskIds: ['task-1'],
          displayName: 'Ivan',
          focusedSurface: 'terminal',
          lastSeenAt: 1_000,
          visibility: 'visible',
        },
      ],
      seq: 4,
    },
    {
      type: 'permission-request',
      agentId: 'agent-1',
      arguments: '{}',
      description: 'Run command',
      requestId: 'request-1',
      tool: 'bash',
    },
    {
      type: 'pong',
    },
    {
      type: 'remote-status',
      connectedClients: 2,
      peerClients: 1,
      seq: 5,
    },
    {
      type: 'scrollback',
      agentId: 'agent-1',
      cols: 80,
      data: Buffer.from('snapshot', 'utf8').toString('base64'),
    },
    {
      type: 'state-bootstrap',
      snapshots: [],
    },
    {
      type: 'status',
      agentId: 'agent-1',
      exitCode: null,
      status: 'running',
      seq: 6,
    },
    {
      type: 'task-command-takeover-request',
      action: 'type in terminal',
      expiresAt: 1_000,
      requestId: 'request-1',
      requesterClientId: 'client-2',
      requesterDisplayName: 'Sam',
      taskId: 'task-1',
    },
    {
      type: 'task-command-takeover-result',
      decision: 'approved',
      requestId: 'request-1',
      taskId: 'task-1',
    },
    {
      type: 'task-event',
      event: 'created',
      name: 'Task 1',
      taskId: 'task-1',
      seq: 7,
    },
    {
      type: 'task-ports-changed',
      exposed: [],
      kind: 'snapshot',
      observed: [],
      taskId: 'task-1',
      updatedAt: 1_000,
      seq: 8,
    },
    {
      type: 'terminal-input-trace-clock-sync',
      clientSentAtMs: 1,
      requestId: 'request-1',
      serverReceivedAtMs: 2,
      serverSentAtMs: 3,
    },
  ] satisfies ServerMessage[];

  it('accepts each known server message shape', () => {
    for (const message of validServerMessages) {
      expect(isServerMessage(message), message.type).toBe(true);
    }
  });

  it('leaves state-bootstrap snapshot validation to server-state domain owners', () => {
    expect(
      isServerMessage({
        type: 'state-bootstrap',
        snapshots: [
          {
            category: 'task-review',
            mode: 'replace',
            payload: [],
            version: 1,
          },
          {
            category: 'task-review',
            mode: 'replace',
            payload: [{ source: 'cache' }],
            version: 2,
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects unknown or malformed known server messages', () => {
    expect(isServerMessage({ type: 'future-server-event', payload: { ready: true } })).toBe(false);
    expect(isServerMessage({ type: 'agent-error', agentId: 'agent-1' })).toBe(false);
    expect(isServerMessage({ type: 'agents', list: [{ agentId: 'agent-1' }] })).toBe(false);
    expect(isServerMessage({ type: 'output', agentId: 'agent-1', data: 'not-valid-base64!' })).toBe(
      false,
    );
    expect(isServerMessage({ type: 'scrollback', agentId: 'agent-1', cols: 0, data: '' })).toBe(
      false,
    );
    expect(
      isServerMessage({
        type: 'scrollback',
        agentId: 'agent-1',
        cols: 80,
        data: 'AB==',
      }),
    ).toBe(false);
    expect(
      isServerMessage({
        type: 'task-ports-changed',
        exposed: [{ port: '3000' }],
        kind: 'snapshot',
        observed: [],
        taskId: 'task-1',
        updatedAt: 1_000,
      }),
    ).toBe(false);
    expect(
      isServerMessage({
        type: 'task-command-takeover-request',
        action: 'type in terminal',
        expiresAt: 1.5,
        requestId: 'request-1',
        requesterClientId: 'client-2',
        requesterDisplayName: 'Sam',
        taskId: 'task-1',
      }),
    ).toBe(false);
  });
});
