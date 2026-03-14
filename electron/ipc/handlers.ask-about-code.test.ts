import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from './channels.js';

const { askAboutCodeMock, cancelAskAboutCodeMock } = vi.hoisted(() => ({
  askAboutCodeMock: vi.fn(),
  cancelAskAboutCodeMock: vi.fn(),
}));

vi.mock('./ask-about-code.js', async () => {
  const actual = await vi.importActual<typeof import('./ask-about-code.js')>('./ask-about-code.js');
  return {
    ...actual,
    askAboutCode: askAboutCodeMock,
    cancelAskAboutCode: cancelAskAboutCodeMock,
  };
});

import { BadRequestError, createIpcHandlers, type HandlerContext } from './handlers.js';

function buildContext(): HandlerContext {
  return {
    userDataPath: '/tmp/parallel-code-tests',
    isPackaged: false,
    sendToChannel: vi.fn(),
  };
}

describe('ask-about-code IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes ask-about-code requests through the backend service', () => {
    const context = buildContext();
    const handlers = createIpcHandlers(context);

    handlers[IPC.AskAboutCode]?.({
      requestId: 'request-1',
      prompt: 'What does this do?',
      cwd: '/tmp/project',
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    expect(askAboutCodeMock).toHaveBeenCalledWith(
      {
        requestId: 'request-1',
        prompt: 'What does this do?',
        cwd: '/tmp/project',
      },
      expect.any(Function),
    );

    const onOutput = askAboutCodeMock.mock.calls[0]?.[1] as
      | ((message: unknown) => void)
      | undefined;
    onOutput?.({ type: 'chunk', text: 'hello' });
    expect(context.sendToChannel).toHaveBeenCalledWith('channel-1', {
      type: 'chunk',
      text: 'hello',
    });
  });

  it('routes ask-about-code cancellations through the backend service', () => {
    const handlers = createIpcHandlers(buildContext());

    handlers[IPC.CancelAskAboutCode]?.({
      requestId: 'request-1',
    });

    expect(cancelAskAboutCodeMock).toHaveBeenCalledWith('request-1');
  });

  it('rejects blank request ids and oversized channel ids', () => {
    const handlers = createIpcHandlers(buildContext());

    expect(() =>
      handlers[IPC.AskAboutCode]?.({
        requestId: '   ',
        prompt: 'Question',
        cwd: '/tmp/project',
        onOutput: { __CHANNEL_ID__: 'channel-1' },
      }),
    ).toThrow(BadRequestError);

    expect(() =>
      handlers[IPC.AskAboutCode]?.({
        requestId: 'request-1',
        prompt: 'Question',
        cwd: '/tmp/project',
        onOutput: { __CHANNEL_ID__: 'x'.repeat(201) },
      }),
    ).toThrow(/must not exceed 200 characters/i);
  });

  it('rejects overlong cwd paths before invoking the service', () => {
    const handlers = createIpcHandlers(buildContext());
    const cwd = '/' + 'a'.repeat(4_097);

    expect(() =>
      handlers[IPC.AskAboutCode]?.({
        requestId: 'request-1',
        prompt: 'Question',
        cwd,
        onOutput: { __CHANNEL_ID__: 'channel-1' },
      }),
    ).toThrow(/cwd must not exceed 4096 characters/i);
    expect(askAboutCodeMock).not.toHaveBeenCalled();
  });
});
