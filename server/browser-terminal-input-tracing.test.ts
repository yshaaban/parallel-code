import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserTerminalInputTraceClockSyncMessage,
  createBrowserTerminalInputTraceRequest,
  getBrowserTerminalInputTracePreview,
  recordBrowserTerminalInputCommandResultSent,
  recordBrowserTerminalInputFailure,
  recordBrowserTerminalInputServerReceived,
} from './browser-terminal-input-tracing.js';

const TRACE = {
  bufferedAtMs: 2,
  inputChars: 3,
  inputKind: 'interactive',
  sendStartedAtMs: 4,
  startedAtMs: 1,
} as const;

describe('browser terminal input tracing', () => {
  it('formats browser terminal input previews like the websocket input path', () => {
    expect(getBrowserTerminalInputTracePreview('one\ntwo\tthree')).toBe('one two three');
    expect(getBrowserTerminalInputTracePreview(`${'a'.repeat(81)}\nnext`)).toBe(
      `${'a'.repeat(80)}…`,
    );
  });

  it('creates write trace requests only when both request id and trace are present', () => {
    expect(
      createBrowserTerminalInputTraceRequest(
        {
          requestId: 'request-1',
          trace: TRACE,
        },
        'client-1',
        'task-1',
      ),
    ).toEqual({
      clientId: 'client-1',
      requestId: 'request-1',
      taskId: 'task-1',
      trace: TRACE,
    });
    expect(createBrowserTerminalInputTraceRequest({ requestId: 'request-1' }, null, null)).toBe(
      undefined,
    );
  });

  it('records server-received traces with the formatted input preview', () => {
    const record = vi.fn();

    recordBrowserTerminalInputServerReceived(
      {
        agentId: 'agent-1',
        data: 'pwd\n',
        requestId: 'request-1',
        trace: TRACE,
      },
      'client-1',
      'task-1',
      record,
    );

    expect(record).toHaveBeenCalledWith({
      agentId: 'agent-1',
      clientId: 'client-1',
      inputPreview: 'pwd ',
      requestId: 'request-1',
      taskId: 'task-1',
      trace: TRACE,
    });
  });

  it('records failures only for request-tracked input', () => {
    const record = vi.fn();

    recordBrowserTerminalInputFailure('agent-1', undefined, 'denied', record);
    recordBrowserTerminalInputFailure('agent-1', 'request-1', 'denied', record);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('agent-1', 'request-1', 'denied');
  });

  it('records command-result sends only for request-tracked input commands', () => {
    const record = vi.fn();

    recordBrowserTerminalInputCommandResultSent(
      {
        accepted: true,
        agentId: 'agent-1',
        command: 'resize',
        requestId: 'resize-1',
        type: 'agent-command-result',
      },
      record,
    );
    recordBrowserTerminalInputCommandResultSent(
      {
        accepted: true,
        agentId: 'agent-1',
        command: 'input',
        requestId: 'input-1',
        type: 'agent-command-result',
      },
      record,
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('agent-1', 'input-1');
  });

  it('builds clock sync responses with receive and send timestamps', () => {
    const times = [100, 110];

    expect(
      createBrowserTerminalInputTraceClockSyncMessage(
        {
          clientSentAtMs: 90,
          requestId: 'clock-1',
          type: 'terminal-input-trace-clock-sync',
        },
        () => times.shift() ?? 0,
      ),
    ).toEqual({
      type: 'terminal-input-trace-clock-sync',
      clientSentAtMs: 90,
      requestId: 'clock-1',
      serverReceivedAtMs: 100,
      serverSentAtMs: 110,
    });
  });
});
