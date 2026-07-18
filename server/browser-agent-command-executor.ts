import {
  getAgentTerminalRecovery,
  getAgentTerminalStartupRecovery,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
} from '../electron/ipc/pty.js';
import { stopTaskAgentWorkflow } from '../electron/ipc/task-workflows.js';
import {
  decodeTerminalRenderedTail,
  runWithTerminalRestorePause,
  serializeTerminalRecoveryEntry,
} from '../electron/ipc/terminal-recovery.js';
import type {
  PauseReason,
  PermissionResponseCommand,
  ResizeCommand,
} from '../electron/remote/protocol.js';
import type { TerminalRecoveryBatchEntry } from '../src/ipc/types.js';

type BrowserAgentInputTraceRequest = Parameters<typeof writeToAgent>[2];
type BrowserAgentInputOrder = Parameters<typeof writeToAgent>[3];
type BrowserAgentInputOrderCallbacks = Parameters<typeof writeToAgent>[4];
type BrowserAgentResizeOrder = Parameters<typeof resizeAgent>[3];
type BrowserAgentResizeOrderCallbacks = Parameters<typeof resizeAgent>[4];

export function writeBrowserAgentInput(
  agentId: string,
  data: string,
  traceRequest?: BrowserAgentInputTraceRequest,
  order?: BrowserAgentInputOrder,
  callbacks?: BrowserAgentInputOrderCallbacks,
): void {
  if (!callbacks) {
    writeToAgent(agentId, data, traceRequest, order);
    return;
  }

  writeToAgent(agentId, data, traceRequest, order, callbacks);
}

export function resizeBrowserAgent(
  agentId: string,
  cols: ResizeCommand['cols'],
  rows: ResizeCommand['rows'],
  order?: BrowserAgentResizeOrder,
  callbacks?: BrowserAgentResizeOrderCallbacks,
): void {
  if (!callbacks) {
    resizeAgent(agentId, cols, rows, order);
    return;
  }

  resizeAgent(agentId, cols, rows, order, callbacks);
}

export function killBrowserAgent(agentId: string): Promise<void> {
  return stopTaskAgentWorkflow(agentId);
}

export function pauseBrowserAgent(
  agentId: string,
  reason?: PauseReason,
  channelId?: string,
  restoreLeaseId?: string,
): void {
  pauseAgent(agentId, reason, channelId, restoreLeaseId);
}

export function resumeBrowserAgent(
  agentId: string,
  reason?: PauseReason,
  channelId?: string,
  restoreLeaseId?: string,
): void {
  resumeAgent(agentId, reason, channelId, restoreLeaseId);
}

export function writeBrowserAgentPermissionResponse(
  agentId: string,
  action: PermissionResponseCommand['action'],
): void {
  writeBrowserAgentInput(agentId, action === 'approve' ? 'y\n' : 'n\n');
}

export async function getBrowserAgentTerminalRecoveryEntry(args: {
  agentId: string;
  outputCursor: number | null;
  renderedTail: string | null;
  requestId: string;
  snapshotByteLimit: number | null;
}): Promise<TerminalRecoveryBatchEntry> {
  return runWithTerminalRestorePause(args.agentId, () =>
    serializeTerminalRecoveryEntry(
      args.agentId,
      args.requestId,
      getAgentTerminalRecovery(
        args.agentId,
        decodeTerminalRenderedTail(args.renderedTail),
        args.outputCursor,
        args.snapshotByteLimit,
      ),
    ),
  );
}

export async function getBrowserAgentTerminalStartupRecoveryEntry(args: {
  agentId: string;
  requestId: string;
  role: Parameters<typeof getAgentTerminalStartupRecovery>[3];
  visibleTerminalCount: number;
}): Promise<TerminalRecoveryBatchEntry> {
  return runWithTerminalRestorePause(args.agentId, async () =>
    serializeTerminalRecoveryEntry(
      args.agentId,
      args.requestId,
      await getAgentTerminalStartupRecovery(
        args.agentId,
        null,
        null,
        args.role,
        args.visibleTerminalCount,
      ),
    ),
  );
}
