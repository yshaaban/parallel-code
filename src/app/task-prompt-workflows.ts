import { getHydraPromptPanelText, isHydraAgentDef } from '../lib/hydra';
import { getRuntimeClientId } from '../lib/runtime-client-id';
import { setStore, store } from '../store/state';
import { isTaskCommandLeaseSkipped, runWithTaskCommandLease } from './task-command-lease';
import { returnFallbackWhenTaskControlled, writeToAgentWhenReady } from './task-command-dispatch';

export async function sendPrompt(
  taskId: string,
  agentId: string,
  text: string,
  options?: {
    confirmTakeover?: boolean;
  },
): Promise<boolean> {
  const result = await runWithTaskCommandLease(
    taskId,
    'send a prompt',
    async () => {
      const controllerId = getRuntimeClientId();
      const agentDef = store.agents[agentId]?.def;
      const translatedText =
        isHydraAgentDef(agentDef) && store.hydraForceDispatchFromPromptPanel
          ? getHydraPromptPanelText(text, true)
          : text;

      return returnFallbackWhenTaskControlled(async () => {
        await writeToAgentWhenReady(agentId, translatedText, taskId, controllerId);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await writeToAgentWhenReady(agentId, '\r', taskId, controllerId);
        setStore('tasks', taskId, 'lastPrompt', text);
        return true;
      }, false);
    },
    options,
  );

  if (isTaskCommandLeaseSkipped(result)) {
    return false;
  }

  return result;
}

export async function sendAgentEnter(
  taskId: string,
  agentId: string,
  options?: {
    confirmTakeover?: boolean;
  },
): Promise<boolean> {
  const result = await runWithTaskCommandLease(
    taskId,
    'send a prompt',
    () =>
      returnFallbackWhenTaskControlled(async () => {
        await writeToAgentWhenReady(agentId, '\r', taskId, getRuntimeClientId());
        return true;
      }, false),
    options,
  );

  if (isTaskCommandLeaseSkipped(result)) {
    return false;
  }

  return result;
}
