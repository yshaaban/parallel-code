import {
  getClaimAgentControlErrorMessage,
  type ClaimAgentControlFailure,
  type ClaimAgentControlResult,
} from '../electron/remote/ws-transport.js';
import {
  browserAgentControllerStillOwnsTask,
  type BrowserAgentTaskMessage,
} from './browser-websocket-task-control.js';
import {
  createAgentCommandResult,
  getAgentCommandRequest,
  type AgentCommandRequest,
  type AgentCommandResult,
  type BrowserAgentCommandResultCache,
} from './browser-agent-command-results.js';
import type { ServerMessage } from '../electron/remote/protocol.js';

const TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE = 'Task is controlled by another client';

export interface AgentCommandExecutionOptions {
  deferSuccessResult?: boolean;
  onFailure?: (reason: string) => void;
  request?: AgentCommandRequest;
  taskId?: string;
}

export interface CreateBrowserAgentCommandRunnerOptions<Client> {
  agentCommandResults: BrowserAgentCommandResultCache<Client>;
  agentControllerStillOwnsTask?: (
    message: BrowserAgentTaskMessage,
    controllerId: string,
  ) => boolean;
  claimAgentControl: (client: Client, agentId: string) => ClaimAgentControlResult;
  releaseAgentControl: (agentId: string, controllerId?: string) => void;
  onAgentCommandResultSent?: (result: AgentCommandResult) => void;
  sendAgentError: (
    client: Client,
    agentId: string,
    fallbackMessage: string,
    error: unknown,
  ) => void;
  sendMessage: (client: Client, message: ServerMessage) => boolean;
}

export interface BrowserAgentCommandRunner<Client> {
  claimControlOrSendError: (
    client: Client,
    agentId: string,
    action: string,
    taskId?: string,
  ) => boolean;
  createExecutionOptions: (
    request: AgentCommandRequest | undefined,
    taskId: string | undefined,
  ) => AgentCommandExecutionOptions | undefined;
  run: (
    client: Client,
    agentId: string,
    action: string,
    execute: () => void,
    requireControl?: boolean,
    commandOptions?: AgentCommandExecutionOptions,
  ) => void;
  sendCommandResult: (
    client: Client,
    request: AgentCommandRequest | undefined,
    accepted: boolean,
    reason?: string,
  ) => boolean;
  sendTaskControlFailure: (
    client: Client,
    message: {
      agentId: string;
      requestId?: string;
      type?: 'input' | 'resize';
    },
    action: 'resize' | 'write',
  ) => void;
}

function createTaskControlError(): Error {
  return new Error(TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE);
}

export function createBrowserAgentCommandRunner<Client>(
  options: CreateBrowserAgentCommandRunnerOptions<Client>,
): BrowserAgentCommandRunner<Client> {
  const agentControllerStillOwnsTask =
    options.agentControllerStillOwnsTask ?? browserAgentControllerStillOwnsTask;

  function createExecutionOptions(
    request: AgentCommandRequest | undefined,
    taskId: string | undefined,
  ): AgentCommandExecutionOptions | undefined {
    if (!request && typeof taskId !== 'string') {
      return undefined;
    }

    return {
      ...(request ? { request } : {}),
      ...(typeof taskId === 'string' ? { taskId } : {}),
    };
  }

  function sendAgentCommandResult(client: Client, result: AgentCommandResult): void {
    options.agentCommandResults.cache(client, result);
    if (options.sendMessage(client, result)) {
      options.onAgentCommandResultSent?.(result);
    }
  }

  function sendRequestedAgentCommandResult(
    client: Client,
    request: AgentCommandRequest | undefined,
    accepted: boolean,
    reason?: string,
  ): boolean {
    if (!request) {
      return false;
    }

    sendAgentCommandResult(client, createAgentCommandResult(request, accepted, reason));
    return true;
  }

  function claimAgentControlWithStaleControllerRecovery(
    client: Client,
    agentId: string,
    taskId?: string,
  ): ClaimAgentControlResult {
    let claimResult = options.claimAgentControl(client, agentId);
    if (!claimResult.ok && claimResult.reason === 'controlled-by-peer') {
      const taskMessage: BrowserAgentTaskMessage =
        typeof taskId === 'string'
          ? { agentId, controllerId: claimResult.controllerId, taskId }
          : { agentId };
      const staleControllerStillOwnsTask = agentControllerStillOwnsTask(
        taskMessage,
        claimResult.controllerId,
      );

      if (!staleControllerStillOwnsTask) {
        options.releaseAgentControl(agentId, claimResult.controllerId);
        claimResult = options.claimAgentControl(client, agentId);
      }
    }

    return claimResult;
  }

  function sendClaimAgentControlFailure(
    client: Client,
    agentId: string,
    action: string,
    claimResult: ClaimAgentControlFailure,
    request?: AgentCommandRequest,
  ): void {
    const errorMessage = getClaimAgentControlErrorMessage(claimResult);
    if (sendRequestedAgentCommandResult(client, request, false, errorMessage)) {
      return;
    }

    options.sendAgentError(client, agentId, `${action} failed`, new Error(errorMessage));
  }

  function claimControlOrSendError(
    client: Client,
    agentId: string,
    action: string,
    taskId?: string,
  ): boolean {
    const claimResult = claimAgentControlWithStaleControllerRecovery(client, agentId, taskId);
    if (claimResult.ok) {
      return true;
    }

    sendClaimAgentControlFailure(client, agentId, action, claimResult);
    return false;
  }

  function sendTaskControlFailure(
    client: Client,
    message: {
      agentId: string;
      requestId?: string;
      type?: 'input' | 'resize';
    },
    action: 'resize' | 'write',
  ): void {
    const request = getAgentCommandRequest(message);
    if (
      sendRequestedAgentCommandResult(
        client,
        request,
        false,
        TASK_CONTROLLED_BY_ANOTHER_CLIENT_MESSAGE,
      )
    ) {
      return;
    }

    options.sendAgentError(client, message.agentId, `${action} failed`, createTaskControlError());
  }

  function run(
    client: Client,
    agentId: string,
    action: string,
    execute: () => void,
    requireControl = true,
    commandOptions?: AgentCommandExecutionOptions,
  ): void {
    const request = commandOptions?.request;
    if (request) {
      const cachedResult = options.agentCommandResults.get(client, request);
      if (cachedResult) {
        sendAgentCommandResult(client, cachedResult);
        return;
      }
    }

    try {
      if (requireControl) {
        const claimResult = claimAgentControlWithStaleControllerRecovery(
          client,
          agentId,
          commandOptions?.taskId,
        );
        if (!claimResult.ok) {
          commandOptions?.onFailure?.(getClaimAgentControlErrorMessage(claimResult));
          sendClaimAgentControlFailure(client, agentId, action, claimResult, request);
          return;
        }
      }

      execute();
      if (commandOptions?.deferSuccessResult !== true) {
        sendRequestedAgentCommandResult(client, request, true);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${action} failed`;
      commandOptions?.onFailure?.(errorMessage);
      if (sendRequestedAgentCommandResult(client, request, false, errorMessage)) {
        return;
      }

      options.sendAgentError(client, agentId, `${action} failed`, error);
    }
  }

  return {
    claimControlOrSendError,
    createExecutionOptions,
    run,
    sendCommandResult: sendRequestedAgentCommandResult,
    sendTaskControlFailure,
  };
}
