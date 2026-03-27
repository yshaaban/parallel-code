import { getHydraPromptPanelText, isHydraAgentDef } from '../lib/hydra';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from '../store/state';
import { clearAgentBusyState, markAgentBusy } from '../store/taskStatus';
import { clearTaskPromptDispatch, markTaskPromptDispatch } from './task-prompt-dispatch';
import { isTaskCommandLeaseSkipped, runWithTaskCommandLease } from './task-command-lease';
import { returnFallbackWhenTaskControlled, writeToAgentWhenReady } from './task-command-dispatch';

function clearPromptDispatchFailureState(agentId: string): void {
  clearTaskPromptDispatch(agentId);
  clearAgentBusyState(agentId);
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
  const translatedText =
    isHydraAgentDef(agentDef) && store.hydraForceDispatchFromPromptPanel
      ? getHydraPromptPanelText(text, true)
      : text;

  return runPromptDispatch(taskId, agentId, options, async (controllerId) =>
    returnFallbackWhenTaskControlled(async () => {
      await writeToAgentWhenReady(agentId, translatedText + '\r', taskId, controllerId);
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
