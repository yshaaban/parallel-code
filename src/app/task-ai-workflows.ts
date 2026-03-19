import { IPC } from '../../electron/ipc/channels';
import type { AskAboutCodeMessage } from '../domain/ask-about-code';
import { invoke } from '../lib/ipc';
import type { ReviewAnnotation } from './review-session';
import { sendPrompt } from './task-workflows';
import { createTaskOutputChannelBinding } from './task-output-channels';

export interface AskAboutCodeSession {
  cancel: () => Promise<void>;
  cleanup: () => void;
}

export async function startAskAboutCodeSession(
  requestId: string,
  prompt: string,
  cwd: string,
  onMessage: (message: AskAboutCodeMessage) => void,
): Promise<AskAboutCodeSession> {
  const { channel, cleanup } = createTaskOutputChannelBinding(onMessage);

  try {
    await invoke(IPC.AskAboutCode, {
      requestId,
      prompt,
      cwd,
      onOutput: channel,
    });
  } catch (error) {
    cleanup();
    throw error;
  }

  async function cancel(): Promise<void> {
    try {
      await invoke(IPC.CancelAskAboutCode, { requestId });
    } finally {
      cleanup();
    }
  }

  return {
    cancel,
    cleanup,
  };
}

export async function submitReviewAnnotations(
  taskId: string,
  agentId: string,
  annotations: ReadonlyArray<ReviewAnnotation>,
  compilePrompt: (annotations: ReadonlyArray<ReviewAnnotation>) => string,
): Promise<void> {
  const prompt = compilePrompt(annotations);
  if (!prompt.trim()) {
    return;
  }

  await sendPrompt(taskId, agentId, prompt);
}
