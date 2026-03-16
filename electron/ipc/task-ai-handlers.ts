import {
  askAboutCode,
  cancelAskAboutCode,
  MAX_ASK_ABOUT_CODE_PROMPT_LENGTH,
} from './ask-about-code.js';
import type { AskAboutCodeMessage } from '../../src/domain/ask-about-code.js';
import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import { validatePath } from './path-utils.js';
import { getRequiredChannelId } from './channel-id.js';
import { defineIpcHandler } from './typed-handler.js';
import { assertString } from './validate.js';

const MAX_ASK_ABOUT_CODE_CHANNEL_ID_LENGTH = 200;
const MAX_ASK_ABOUT_CODE_CWD_LENGTH = 4_096;
const MAX_ASK_ABOUT_CODE_REQUEST_ID_LENGTH = 200;

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new BadRequestError(`${label} must not be empty`);
  }
}

function assertStringMaxLength(value: string, label: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new BadRequestError(`${label} must not exceed ${maxLength} characters`);
  }
}

function getValidatedOutputChannelId(value: unknown): string {
  const channelId = getRequiredChannelId(value);
  assertNonEmptyString(channelId, 'onOutput.__CHANNEL_ID__');
  assertStringMaxLength(channelId, 'onOutput.__CHANNEL_ID__', MAX_ASK_ABOUT_CODE_CHANNEL_ID_LENGTH);

  return channelId;
}

function createOutputHandler(
  context: HandlerContext,
  channelId: string,
): (message: AskAboutCodeMessage) => void {
  return function handleOutput(message: AskAboutCodeMessage): void {
    context.sendToChannel(channelId, message);
  };
}

export function createTaskAiIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.AskAboutCode]: defineIpcHandler<IPC.AskAboutCode>(IPC.AskAboutCode, (args) => {
      const request = args;
      assertString(request.requestId, 'requestId');
      assertString(request.prompt, 'prompt');
      assertString(request.cwd, 'cwd');
      assertNonEmptyString(request.requestId, 'requestId');
      assertNonEmptyString(request.prompt, 'prompt');
      assertStringMaxLength(request.requestId, 'requestId', MAX_ASK_ABOUT_CODE_REQUEST_ID_LENGTH);
      assertStringMaxLength(request.prompt, 'prompt', MAX_ASK_ABOUT_CODE_PROMPT_LENGTH);
      assertStringMaxLength(request.cwd, 'cwd', MAX_ASK_ABOUT_CODE_CWD_LENGTH);
      validatePath(request.cwd, 'cwd');
      const channelId = getValidatedOutputChannelId(request.onOutput);

      askAboutCode(
        {
          requestId: request.requestId,
          prompt: request.prompt,
          cwd: request.cwd,
        },
        createOutputHandler(context, channelId),
      );

      return null;
    }),

    [IPC.CancelAskAboutCode]: defineIpcHandler<IPC.CancelAskAboutCode>(
      IPC.CancelAskAboutCode,
      (args) => {
        const request = args;
        assertString(request.requestId, 'requestId');
        assertNonEmptyString(request.requestId, 'requestId');
        assertStringMaxLength(request.requestId, 'requestId', MAX_ASK_ABOUT_CODE_REQUEST_ID_LENGTH);
        cancelAskAboutCode(request.requestId);

        return null;
      },
    ),
  };
}
