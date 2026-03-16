import { IPC } from './channels.js';
import { listAgentSupervisionSnapshots } from './agent-supervision.js';
import { listAgents } from './agents.js';
import {
  assertOptionalPauseReason,
  type HandlerContext,
  type IpcHandler,
} from './handler-context.js';
import {
  countRunningAgents,
  detachAgentOutput,
  getActiveAgentIds,
  getAgentCols,
  getAgentScrollback,
  killAgent,
  killAllAgents,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
} from './pty.js';
import { spawnTaskAgentWorkflow } from './task-workflows.js';
import { BadRequestError } from './errors.js';
import { defineIpcHandler } from './typed-handler.js';
import { assertInt, assertOptionalString, assertString, assertStringArray } from './validate.js';
import { getRequiredChannelId } from './channel-id.js';

export function createAgentIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.SpawnAgent]: defineIpcHandler<IPC.SpawnAgent>(IPC.SpawnAgent, async (args) => {
      const request = args;
      assertString(request.taskId, 'taskId');
      assertString(request.agentId, 'agentId');
      assertStringArray(request.args, 'args');
      if (request.adapter !== undefined && request.adapter !== 'hydra') {
        throw new BadRequestError('adapter must be hydra when provided');
      }
      if (request.cwd !== undefined) {
        assertString(request.cwd, 'cwd');
      }
      const channelId = getRequiredChannelId(request.onOutput);

      await spawnTaskAgentWorkflow(context, {
        taskId: request.taskId,
        agentId: request.agentId,
        command: typeof request.command === 'string' ? request.command : '',
        args: request.args,
        cwd: typeof request.cwd === 'string' ? request.cwd : '',
        env: request.env,
        cols: typeof request.cols === 'number' ? request.cols : 80,
        rows: typeof request.rows === 'number' ? request.rows : 24,
        isShell: request.isShell === true,
        onOutput: { __CHANNEL_ID__: channelId },
        ...(request.adapter !== undefined ? { adapter: request.adapter } : {}),
      });

      return undefined;
    }),

    [IPC.WriteToAgent]: defineIpcHandler<IPC.WriteToAgent>(IPC.WriteToAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertString(request.data, 'data');
      writeToAgent(request.agentId, request.data);
      return undefined;
    }),

    [IPC.DetachAgentOutput]: defineIpcHandler<IPC.DetachAgentOutput>(
      IPC.DetachAgentOutput,
      (args) => {
        const request = args;
        assertString(request.agentId, 'agentId');
        assertString(request.channelId, 'channelId');
        detachAgentOutput(request.agentId, request.channelId);
        return undefined;
      },
    ),

    [IPC.GetAgentScrollback]: defineIpcHandler<IPC.GetAgentScrollback>(
      IPC.GetAgentScrollback,
      (args) => {
        const request = args;
        assertString(request.agentId, 'agentId');
        return getAgentScrollback(request.agentId);
      },
    ),

    [IPC.GetScrollbackBatch]: defineIpcHandler<IPC.GetScrollbackBatch>(
      IPC.GetScrollbackBatch,
      (args) => {
        const request = args;
        assertStringArray(request.agentIds, 'agentIds');
        const agentIds = Array.from(new Set(request.agentIds));
        const pausedIds: string[] = [];

        try {
          for (const agentId of agentIds) {
            pauseAgent(agentId, 'restore');
            pausedIds.push(agentId);
          }

          return agentIds.map((agentId) => ({
            agentId,
            scrollback: getAgentScrollback(agentId),
            cols: getAgentCols(agentId),
          }));
        } finally {
          for (const agentId of pausedIds.reverse()) {
            try {
              resumeAgent(agentId, 'restore');
            } catch {
              // best-effort cleanup
            }
          }
        }
      },
    ),

    [IPC.ResizeAgent]: defineIpcHandler<IPC.ResizeAgent>(IPC.ResizeAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertInt(request.cols, 'cols');
      assertInt(request.rows, 'rows');
      resizeAgent(request.agentId, request.cols, request.rows);
      return undefined;
    }),

    [IPC.PauseAgent]: defineIpcHandler<IPC.PauseAgent>(IPC.PauseAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      pauseAgent(request.agentId, request.reason, request.channelId);
      return undefined;
    }),

    [IPC.ResumeAgent]: defineIpcHandler<IPC.ResumeAgent>(IPC.ResumeAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      resumeAgent(request.agentId, request.reason, request.channelId);
      return undefined;
    }),

    [IPC.KillAgent]: defineIpcHandler<IPC.KillAgent>(IPC.KillAgent, (args) => {
      const request = args;
      assertString(request.agentId, 'agentId');
      killAgent(request.agentId);
      return undefined;
    }),

    [IPC.CountRunningAgents]: () => countRunningAgents(),
    [IPC.KillAllAgents]: () => killAllAgents(),
    [IPC.ListAgents]: defineIpcHandler<IPC.ListAgents>(IPC.ListAgents, (args) => {
      const request = args;
      assertOptionalString(request.hydraCommand, 'hydraCommand');
      return listAgents(request.hydraCommand);
    }),
    [IPC.GetAgentSupervision]: () => listAgentSupervisionSnapshots(),
    [IPC.ListRunningAgentIds]: () => getActiveAgentIds(),
  };
}
