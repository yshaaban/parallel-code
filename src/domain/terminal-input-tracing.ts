export type TerminalInputTraceKind = 'burst' | 'control' | 'interactive' | 'paste';

export interface TerminalInputTraceMessage {
  bufferedAtMs: number;
  echoText?: string;
  inputChars: number;
  inputKind: TerminalInputTraceKind;
  sendStartedAtMs: number;
  startedAtMs: number;
}

export interface TerminalInputTraceClientUpdate {
  agentId: string;
  outputReceivedAtMs: number;
  outputRenderedAtMs: number;
  outputTransportReceivedAtMs?: number;
  requestId: string;
}

export interface TerminalInputTraceClockSyncRequest {
  clientSentAtMs: number;
  requestId: string;
}

export interface TerminalInputTraceClockSyncResponse extends TerminalInputTraceClockSyncRequest {
  serverReceivedAtMs: number;
  serverSentAtMs: number;
}

export interface TerminalInputTraceStageTimes {
  backendOutputFlushedAtMs: number | null;
  bufferedAtMs: number | null;
  commandResultSentAtMs: number | null;
  outputReceivedAtMs: number | null;
  outputRenderedAtMs: number | null;
  outputTransportReceivedAtMs: number | null;
  ptyEnqueuedAtMs: number | null;
  ptyFlushedAtMs: number | null;
  ptyOutputReceivedAtMs: number | null;
  ptyWrittenAtMs: number | null;
  sendStartedAtMs: number | null;
  serverReceivedAtMs: number | null;
  startedAtMs: number | null;
}

export interface TerminalInputTraceSample {
  agentId: string;
  clientId: string | null;
  completed: boolean;
  echoText: string | null;
  failureReason: string | null;
  inputChars: number;
  inputKind: TerminalInputTraceKind;
  inputPreview: string;
  requestId: string;
  stages: TerminalInputTraceStageTimes;
  taskId: string | null;
}

export interface NumericTraceSummary {
  avg: number;
  count: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
}

export interface TerminalInputTraceSummary {
  backendOutputBufferMs: NumericTraceSummary;
  browserChannelDispatchMs: NumericTraceSummary;
  browserDeliveryMs: NumericTraceSummary;
  browserTransportDeliveryMs: NumericTraceSummary;
  clientBufferMs: NumericTraceSummary;
  clientSendMs: NumericTraceSummary;
  commandAckMs: NumericTraceSummary;
  count: number;
  endToEndMs: NumericTraceSummary;
  ptyEchoMs: NumericTraceSummary;
  ptyWriteToCommandAckMs: NumericTraceSummary;
  renderMs: NumericTraceSummary;
  sendToEchoMs: NumericTraceSummary;
  serverQueueMs: NumericTraceSummary;
  transportResidualMs: NumericTraceSummary;
}

export interface TerminalInputTraceDiagnosticsSnapshot {
  activeTraceCount: number;
  completedTraces: TerminalInputTraceSample[];
  droppedTraces: number;
  summary: TerminalInputTraceSummary;
}
