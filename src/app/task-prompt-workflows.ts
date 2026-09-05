import { IPC } from '../../electron/ipc/channels';
import { isExitedRemoteAgentStatus } from '../domain/server-state';
import type { OrdinaryTaskPromptInputResult } from '../domain/task-prompt-input-admission';
import { getHydraPromptPanelText, isHydraAgentDef } from '../lib/hydra';
import { invokeOnce } from '../lib/ipc';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from '../store/state';
import { clearAgentBusyState, markAgentBusy } from '../store/taskStatus';
import { prepareTaskPromptText } from './task-steps';
import { clearTaskPromptDispatch, markTaskPromptDispatch } from './task-prompt-dispatch';
import { isTaskCommandLeaseSkipped, runWithTaskCommandLease } from './task-command-lease';
import { returnFallbackWhenTaskControlled, writeToAgentWhenReady } from './task-command-dispatch';

const AGENT_PROMPT_READY_TIMEOUT_MS = 8_000;
const AGENT_PROMPT_READY_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearPromptDispatchFailureState(agentId: string): void {
  clearTaskPromptDispatch(agentId);
  clearAgentBusyState(agentId);
}

async function writePromptAndSubmitWhenReady(
  agentId: string,
  text: string,
  taskId: string,
  controllerId: string,
): Promise<boolean> {
  const deadline = Date.now() + AGENT_PROMPT_READY_TIMEOUT_MS;
  let response: OrdinaryTaskPromptInputResult;
  while (true) {
    try {
      response = await invokeOnce(IPC.SendTaskPromptInput, {
        agentId,
        controllerId,
        taskId,
        text,
      });
    } catch {
      throw new Error('Prompt outcome is uncertain; inspect the terminal before retrying.');
    }

    const currentAgent = store.agents[agentId];
    const canWaitForCurrentSession =
      response.admission.kind === 'rejected-before-bytes' &&
      response.admission.reason === 'agent-generation-changed' &&
      currentAgent !== undefined &&
      !isExitedRemoteAgentStatus(currentAgent.status) &&
      (response.admission.currentGeneration === undefined ||
        response.admission.currentGeneration === currentAgent.generation) &&
      Date.now() <= deadline;
    if (!canWaitForCurrentSession) {
      break;
    }

    await sleep(AGENT_PROMPT_READY_RETRY_MS);
  }
  const { admission } = response;

  if (admission.kind === 'accepted') {
    return true;
  }
  if (admission.kind === 'outcome-ambiguous') {
    throw new Error('Prompt outcome is uncertain; inspect the terminal before retrying.');
  }
  if (admission.reason === 'control-or-lease-lost') {
    return false;
  }
  if (admission.reason === 'question-active') {
    throw new Error('Agent is waiting for terminal input; the prompt was not sent.');
  }
  if (admission.reason === 'task-closing') {
    throw new Error('This task is closing; the prompt was not sent.');
  }
  if (admission.reason === 'agent-not-ready') {
    throw new Error('Agent is not ready for this prompt; review its terminal before retrying.');
  }

  throw new Error('Agent state changed; review its terminal before retrying.');
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
      const sent = await writePromptAndSubmitWhenReady(
        agentId,
        translatedText,
        taskId,
        controllerId,
      );
      if (!sent) {
        return false;
      }
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
