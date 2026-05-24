import { getHydraPromptPanelText, isHydraAgentDef } from '../lib/hydra';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from '../store/state';
import { clearAgentBusyState, markAgentBusy } from '../store/taskStatus';
import { prepareTaskPromptText } from './task-steps';
import { clearTaskPromptDispatch, markTaskPromptDispatch } from './task-prompt-dispatch';
import { isTaskCommandLeaseSkipped, runWithTaskCommandLease } from './task-command-lease';
import { returnFallbackWhenTaskControlled, writeToAgentWhenReady } from './task-command-dispatch';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const PROMPT_SUBMIT_DELAY_BASE_MS = 25;
const PROMPT_SUBMIT_DELAY_PER_EXTRA_LINE_MS = 8;
const PROMPT_SUBMIT_DELAY_MAX_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearPromptDispatchFailureState(agentId: string): void {
  clearTaskPromptDispatch(agentId);
  clearAgentBusyState(agentId);
}

function getPromptLineCount(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  return text.split('\n').length;
}

function getPromptSubmitDelayMs(text: string): number {
  const extraLines = Math.max(0, getPromptLineCount(text) - 1);
  return Math.min(
    PROMPT_SUBMIT_DELAY_MAX_MS,
    PROMPT_SUBMIT_DELAY_BASE_MS + extraLines * PROMPT_SUBMIT_DELAY_PER_EXTRA_LINE_MS,
  );
}

function toBracketedPastePayload(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

function shouldUseBracketedPaste(text: string): boolean {
  return text.includes('\n');
}

async function writePromptAndSubmitWhenReady(
  agentId: string,
  text: string,
  taskId: string,
  controllerId: string,
): Promise<void> {
  if (shouldUseBracketedPaste(text)) {
    await writeToAgentWhenReady(agentId, toBracketedPastePayload(text), taskId, controllerId);
    await sleep(getPromptSubmitDelayMs(text));
    await writeToAgentWhenReady(agentId, '\r', taskId, controllerId);
    return;
  }

  await writeToAgentWhenReady(agentId, `${text}\r`, taskId, controllerId);
}

async function runPromptDispatch(
  taskId: string,
  agentId: string,
  options: { confirmTakeover?: boolean } | undefined,
  dispatch: (controllerId: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    const result = await runWithTaskCommandLease(
      taskId,
      'send a prompt',
      async () => {
        const controllerId = getRuntimeClientId();
        markAgentBusy(agentId);
        markTaskPromptDispatch(agentId, store.agents[agentId]?.generation ?? null);
        return dispatch(controllerId);
      },
      options,
    );

    if (isTaskCommandLeaseSkipped(result) || !result) {
      clearPromptDispatchFailureState(agentId);
      return false;
    }

    return true;
  } catch (error) {
    clearPromptDispatchFailureState(agentId);
    throw error;
  }
}

export async function sendPrompt(
  taskId: string,
  agentId: string,
  text: string,
  options?: {
    confirmTakeover?: boolean;
  },
): Promise<boolean> {
  const agentDef = store.agents[agentId]?.def;
  const promptText = prepareTaskPromptText(taskId, text);
  const translatedText =
    isHydraAgentDef(agentDef) && store.hydraForceDispatchFromPromptPanel
      ? getHydraPromptPanelText(promptText, true)
      : promptText;

  return runPromptDispatch(taskId, agentId, options, async (controllerId) =>
    returnFallbackWhenTaskControlled(async () => {
      await writePromptAndSubmitWhenReady(agentId, translatedText, taskId, controllerId);
      setStore('tasks', taskId, 'lastPrompt', text);
      return true;
    }, false),
  );
}

export async function sendAgentEnter(
  taskId: string,
  agentId: string,
  options?: {
    confirmTakeover?: boolean;
  },
): Promise<boolean> {
  return runPromptDispatch(taskId, agentId, options, async (controllerId) =>
    returnFallbackWhenTaskControlled(async () => {
      await writeToAgentWhenReady(agentId, '\r', taskId, controllerId);
      return true;
    }, false),
  );
}
