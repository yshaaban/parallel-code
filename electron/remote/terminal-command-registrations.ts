import { getAgentMeta, pauseAgent, resizeAgent, resumeAgent, writeToAgent } from '../ipc/pty.js';
import { isTaskCommandLeaseHeld } from '../ipc/task-command-leases.js';
import { stopTaskAgentWorkflow } from '../ipc/task-workflows.js';
import type { RemoteCommandRegistrationTable } from '../ipc/remote-command-gateway.js';
import {
  parseClientMessage,
  type ClientMessage,
  type InputCommand,
  type PauseCommand,
  type ResizeCommand,
  type ResumeCommand,
} from './protocol.js';

type TerminalCommand = Extract<
  ClientMessage,
  { type: 'input' | 'kill' | 'pause' | 'resize' | 'resume' }
>;

const ACCEPTED = Object.freeze({ kind: 'accepted' as const });

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameJsonValue(entry, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in rightRecord && sameJsonValue(leftRecord[key], rightRecord[key]))
  );
}

function parseTerminalCommand<TType extends TerminalCommand['type']>(
  value: unknown,
  type: TType,
): Extract<TerminalCommand, { type: TType }> | null {
  let parsed: ClientMessage | null = null;
  try {
    parsed = parseClientMessage(JSON.stringify(value));
  } catch {
    return null;
  }
  return parsed?.type === type && sameJsonValue(parsed, value)
    ? (parsed as Extract<TerminalCommand, { type: TType }>)
    : null;
}

function isAccepted(value: unknown): value is typeof ACCEPTED {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (value as { kind?: unknown }).kind === 'accepted'
  );
}

export function assertRemoteTaskCommandMutation(message: InputCommand | ResizeCommand): void {
  const taskId = getAgentMeta(message.agentId)?.taskId ?? null;
  if (!taskId) {
    if (message.taskId !== undefined || message.controllerId !== undefined) {
      throw new Error('task-control-context-invalid');
    }
    return;
  }
  if (
    message.taskId !== taskId ||
    message.controllerId === undefined ||
    !isTaskCommandLeaseHeld(taskId, message.controllerId)
  ) {
    throw new Error('task-control-required');
  }
}

function inputOrderToken(message: InputCommand): Parameters<typeof writeToAgent>[3] {
  return message.inputEpoch === undefined || message.inputSeq === undefined
    ? undefined
    : { inputEpoch: message.inputEpoch, inputSeq: message.inputSeq };
}

function resizeOrderToken(message: ResizeCommand): Parameters<typeof resizeAgent>[3] {
  return message.resizeEpoch === undefined || message.resizeSeq === undefined
    ? undefined
    : { resizeEpoch: message.resizeEpoch, resizeSeq: message.resizeSeq };
}

function executeInput(message: InputCommand, sourceId: string | null): typeof ACCEPTED {
  assertRemoteTaskCommandMutation(message);
  writeToAgent(
    message.agentId,
    message.data,
    message.trace && message.requestId
      ? {
          clientId: sourceId,
          requestId: message.requestId,
          taskId: message.taskId ?? null,
          trace: message.trace,
        }
      : undefined,
    inputOrderToken(message),
  );
  return ACCEPTED;
}

function executeResize(message: ResizeCommand): typeof ACCEPTED {
  assertRemoteTaskCommandMutation(message);
  resizeAgent(message.agentId, message.cols, message.rows, resizeOrderToken(message));
  return ACCEPTED;
}

function executePause(message: PauseCommand): typeof ACCEPTED {
  pauseAgent(message.agentId, message.reason, message.channelId, message.restoreLeaseId);
  return ACCEPTED;
}

function executeResume(message: ResumeCommand): typeof ACCEPTED {
  resumeAgent(message.agentId, message.reason, message.channelId, message.restoreLeaseId);
  return ACCEPTED;
}

function requireCommand<TType extends TerminalCommand['type']>(
  value: unknown,
  type: TType,
): Extract<TerminalCommand, { type: TType }> {
  const command = parseTerminalCommand(value, type);
  if (!command) throw new TypeError('Invalid terminal command');
  return command;
}

export function createRemoteTerminalCommandRegistrations(): RemoteCommandRegistrationTable {
  return {
    'terminal.input': {
      execute: (context, request) =>
        executeInput(requireCommand(request, 'input'), context.sourceId),
      isRequest: (value): value is InputCommand => parseTerminalCommand(value, 'input') !== null,
      isResult: isAccepted,
    },
    'terminal.kill': {
      execute: async (_context, request) => {
        await stopTaskAgentWorkflow(requireCommand(request, 'kill').agentId);
        return ACCEPTED;
      },
      isRequest: (value): value is Extract<TerminalCommand, { type: 'kill' }> =>
        parseTerminalCommand(value, 'kill') !== null,
      isResult: isAccepted,
    },
    'terminal.pause': {
      execute: (_context, request) => executePause(requireCommand(request, 'pause')),
      isRequest: (value): value is PauseCommand => parseTerminalCommand(value, 'pause') !== null,
      isResult: isAccepted,
    },
    'terminal.resize': {
      execute: (_context, request) => executeResize(requireCommand(request, 'resize')),
      isRequest: (value): value is ResizeCommand => parseTerminalCommand(value, 'resize') !== null,
      isResult: isAccepted,
    },
    'terminal.resume': {
      execute: (_context, request) => executeResume(requireCommand(request, 'resume')),
      isRequest: (value): value is ResumeCommand => parseTerminalCommand(value, 'resume') !== null,
      isResult: isAccepted,
    },
  };
}
