import { IPC } from '../../electron/ipc/channels';
import type {
  CoordinatorActivityHintRequest,
  CoordinatorDiagnosticsSnapshot,
  CoordinatorToolCallEnvelope,
  CoordinatorToolCallResult,
  CoordinatorUiToolCallRequest,
} from '../domain/coordinator';
import { invoke } from '../lib/ipc';

let lastCoordinatorActivityHintSeq = 0;

export function nextCoordinatorActivityHintSeq(): number {
  lastCoordinatorActivityHintSeq = Math.max(lastCoordinatorActivityHintSeq + 1, Date.now() * 1_000);
  return lastCoordinatorActivityHintSeq;
}

export async function sendCoordinatorActivityHint(
  request: CoordinatorActivityHintRequest,
): Promise<void> {
  await invoke(IPC.CoordinatorActivityHint, request);
}

export async function fetchCoordinatorDiagnostics(): Promise<CoordinatorDiagnosticsSnapshot> {
  return invoke(IPC.CoordinatorGetDiagnostics);
}

export async function callCoordinatorTool(
  envelope: CoordinatorToolCallEnvelope,
): Promise<CoordinatorToolCallResult> {
  return invoke(IPC.CoordinatorToolCall, envelope);
}

export async function callCoordinatorUiTool(
  request: CoordinatorUiToolCallRequest,
): Promise<CoordinatorToolCallResult> {
  return invoke(IPC.CoordinatorUiToolCall, request);
}
