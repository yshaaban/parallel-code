import { IPC } from './channels.js';
import { listAgentSupervisionSnapshots } from './agent-supervision.js';
import { listAgents } from './agents.js';
import type { HandlerContext, IpcHandler } from './handler-context.js';
import { assertOptionalPauseReason } from './handler-context.js';
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
import { assertInt, assertOptionalString, assertString, assertStringArray } from './validate.js';
import { BadRequestError } from './errors.js';

export function createAgentIpcHandlers(context: HandlerContext): Partial<Record<IPC, IpcHandler>> {
  return {
    [IPC.SpawnAgent]: (args) => {
      const request = args ?? {};
      assertString(request.taskId, 'taskId');
      assertString(request.agentId, 'agentId');
      assertStringArray(request.args, 'args');
      if (request.adapter !== undefined && request.adapter !== 'hydra') {
        throw new BadRequestError('adapter must be hydra when provided');
      }
      if (request.cwd !== undefined) {
        assertString(request.cwd, 'cwd');
      }
      const onOutput = request.onOutput as { __CHANNEL_ID__?: unknown } | undefined;
      if (typeof onOutput?.__CHANNEL_ID__ !== 'string') {
        throw new BadRequestError('onOutput.__CHANNEL_ID__ must be a string');
      }

      return spawnTaskAgentWorkflow(context, {
        taskId: request.taskId,
        agentId: request.agentId,
        command: typeof request.command === 'string' ? request.command : '',
        args: request.args,
        cwd: typeof request.cwd === 'string' ? request.cwd : '',
        env: request.env,
        cols: typeof request.cols === 'number' ? request.cols : 80,
        rows: typeof request.rows === 'number' ? request.rows : 24,
        isShell: request.isShell === true,
        onOutput: { __CHANNEL_ID__: onOutput.__CHANNEL_ID__ },
        ...(request.adapter !== undefined ? { adapter: request.adapter } : {}),
      });
    },

    [IPC.WriteToAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertString(request.data, 'data');
      return writeToAgent(request.agentId, request.data);
    },

    [IPC.DetachAgentOutput]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertString(request.channelId, 'channelId');
      return detachAgentOutput(request.agentId, request.channelId);
    },

    [IPC.GetAgentScrollback]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      return getAgentScrollback(request.agentId);
    },

    [IPC.GetScrollbackBatch]: (args) => {
      const request = args ?? {};
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

    [IPC.ResizeAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertInt(request.cols, 'cols');
      assertInt(request.rows, 'rows');
      return resizeAgent(request.agentId, request.cols, request.rows);
    },

    [IPC.PauseAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      return pauseAgent(request.agentId, request.reason, request.channelId);
    },

    [IPC.ResumeAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      assertOptionalPauseReason(request.reason);
      assertOptionalString(request.channelId, 'channelId');
      return resumeAgent(request.agentId, request.reason, request.channelId);
    },

    [IPC.KillAgent]: (args) => {
      const request = args ?? {};
      assertString(request.agentId, 'agentId');
      return killAgent(request.agentId);
    },

    [IPC.CountRunningAgents]: () => countRunningAgents(),
    [IPC.KillAllAgents]: () => killAllAgents(),
    [IPC.ListAgents]: (args) => {
      const request = args ?? {};
      assertOptionalString(request.hydraCommand, 'hydraCommand');
      return listAgents(request.hydraCommand);
    },
    [IPC.GetAgentSupervision]: () => listAgentSupervisionSnapshots(),
    [IPC.ListRunningAgentIds]: () => getActiveAgentIds(),
  };
}
