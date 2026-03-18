export type TerminalInputTraceKind = 'burst' | 'control' | 'interactive' | 'paste';

export interface TerminalInputTraceMessage {
  bufferedAtMs: number;
  inputChars: number;
  inputKind: TerminalInputTraceKind;
  sendStartedAtMs: number;
  startedAtMs: number;
}

export interface TerminalInputTraceClientUpdate {
  agentId: string;
  outputReceivedAtMs: number;
  outputRenderedAtMs: number;
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
  bufferedAtMs: number | null;
  outputReceivedAtMs: number | null;
  outputRenderedAtMs: number | null;
  ptyEnqueuedAtMs: number | null;
  ptyFlushedAtMs: number | null;
  ptyWrittenAtMs: number | null;
  sendStartedAtMs: number | null;
  serverReceivedAtMs: number | null;
  startedAtMs: number | null;
}

export interface TerminalInputTraceSample {
  agentId: string;
  clientId: string | null;
  completed: boolean;
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
  clientBufferMs: NumericTraceSummary;
  clientSendMs: NumericTraceSummary;
  count: number;
  endToEndMs: NumericTraceSummary;
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
