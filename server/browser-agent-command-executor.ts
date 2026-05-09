import {
  killAgent,
  pauseAgent,
  resizeAgent,
  resumeAgent,
  writeToAgent,
} from '../electron/ipc/pty.js';
import type {
  PauseReason,
  PermissionResponseCommand,
  ResizeCommand,
} from '../electron/remote/protocol.js';

type BrowserAgentInputTraceRequest = Parameters<typeof writeToAgent>[2];

export function writeBrowserAgentInput(
  agentId: string,
  data: string,
  traceRequest?: BrowserAgentInputTraceRequest,
): void {
  writeToAgent(agentId, data, traceRequest);
}

export function resizeBrowserAgent(
  agentId: string,
  cols: ResizeCommand['cols'],
  rows: ResizeCommand['rows'],
): void {
  resizeAgent(agentId, cols, rows);
}

export function killBrowserAgent(agentId: string): void {
  killAgent(agentId);
}

export function pauseBrowserAgent(agentId: string, reason?: PauseReason, channelId?: string): void {
  pauseAgent(agentId, reason, channelId);
}

export function resumeBrowserAgent(
  agentId: string,
  reason?: PauseReason,
  channelId?: string,
): void {
  resumeAgent(agentId, reason, channelId);
}

export function writeBrowserAgentPermissionResponse(
  agentId: string,
  action: PermissionResponseCommand['action'],
): void {
  writeBrowserAgentInput(agentId, action === 'approve' ? 'y\n' : 'n\n');
}
