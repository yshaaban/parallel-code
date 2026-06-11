import {
  getAgentPauseState,
  hasAgentSession,
  pauseAgent,
  resumeAgent,
  type AgentTerminalRecovery,
} from './pty.js';
import { assertNever } from '../../src/lib/assert-never.js';
import type { TerminalRecoveryBatchEntry } from '../../src/ipc/types.js';

export function decodeTerminalRenderedTail(renderedTail: string | null | undefined): Buffer | null {
  if (typeof renderedTail !== 'string' || renderedTail.length === 0) {
    return null;
  }

  return Buffer.from(renderedTail, 'base64');
}

export function serializeTerminalRecoveryEntry(
  agentId: string,
  requestId: string,
  recovery: AgentTerminalRecovery,
): TerminalRecoveryBatchEntry {
  const baseEntry = {
    agentId,
    cols: recovery.cols,
    outputCursor: recovery.outputCursor,
    requestId,
    rows: recovery.rows,
  };

  switch (recovery.kind) {
    case 'delta':
      return {
        ...baseEntry,
        recovery: {
          data: recovery.data.toString('base64'),
          kind: 'delta',
          overlapBytes: recovery.overlapBytes,
          source: recovery.source,
        },
      };
    case 'noop':
      return {
        ...baseEntry,
        recovery: {
          kind: 'noop',
        },
      };
    case 'snapshot':
      return {
        ...baseEntry,
        recovery: {
          data: recovery.data?.toString('base64') ?? null,
          kind: 'snapshot',
        },
      };
    case 'tail-needed':
      return {
        ...baseEntry,
        recovery: {
          kind: 'tail-needed',
        },
      };
    case 'terminal-state':
      return {
        ...baseEntry,
        recovery: {
          data: recovery.data.toString('base64'),
          kind: 'terminal-state',
        },
      };
  }

  return assertNever(recovery, 'Unhandled terminal recovery entry');
}

export async function runWithTerminalRestorePause<T>(
  agentId: string,
  recover: () => Promise<T> | T,
): Promise<T> {
  let paused = false;
  try {
    if (hasAgentSession(agentId) && getAgentPauseState(agentId) === null) {
      pauseAgent(agentId, 'restore');
      paused = true;
    }

    return await recover();
  } finally {
    if (paused) {
      try {
        resumeAgent(agentId, 'restore');
      } catch {
        // best-effort cleanup
      }
    }
  }
}
