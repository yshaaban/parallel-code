export {
  getTerminalTraceTimestampMs,
  hasTerminalTraceClockAlignment,
} from './terminal-trace-clock';

/**
 * Terminal latency measurement utilities.
 *
 * Usage:
 *   import { recordOutputReceived, recordOutputWritten, getLatencyStats, resetLatencyStats } from './terminalLatency';
 *
 * Enable instrumentation by setting `window.__TERMINAL_PERF__ = true` in the
 * browser console before interacting with terminals.
 *
 * The probe-based round-trip measurement injects a marker via WriteToAgent and
 * detects it in the terminal output to measure end-to-end latency.
 */

import { invoke } from './ipc';
import { IPC } from '../../electron/ipc/channels';

// ---------------------------------------------------------------------------
// Performance timestamp tracking (opt-in via window.__TERMINAL_PERF__)
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __TERMINAL_PERF__?: boolean;
    __parallelCodeTerminalLatency?: {
      getSnapshot: () => TerminalLatencyDiagnosticsSnapshot;
      measureRoundTrip: (agentId: string, timeoutMs?: number) => Promise<number>;
      startRoundTripProbe: (timeoutMs?: number) => string;
      waitForRoundTripProbe: (marker: string) => Promise<number>;
      reset: () => void;
    };
  }
}

interface TerminalLatencyDiagnosticsSnapshot {
  flow: ReturnType<typeof getFlowRequestStats>;
  input: ReturnType<typeof getInputStageStats>;
  render: NumericLatencyStats;
  roundTrip: ReturnType<typeof getRoundTripStats>;
}

interface PerfSample {
  receiveTs: number; // performance.now() when output arrived from WebSocket
  writeTs: number; // performance.now() when xterm.write callback fired
}

interface NumericLatencyStats {
  avg: number;
  count: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
}

const perfSamples: PerfSample[] = [];
const MAX_PERF_SAMPLES = 200;

function createEmptyNumericLatencyStats(): NumericLatencyStats {
  return {
    avg: 0,
    count: 0,
    max: 0,
    min: 0,
    p50: 0,
    p95: 0,
  };
}

function getRequiredSortedSampleValue(samples: readonly number[], index: number): number {
  const sample = samples[index];
  if (sample === undefined) {
    throw new Error('Terminal latency sample index out of bounds');
  }

  return sample;
}

function getPercentileValue(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) {
    return 0;
  }

  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * fraction) - 1));
  return getRequiredSortedSampleValue(samples, index);
}

function isPerfEnabled(): boolean {
  return typeof window !== 'undefined' && window.__TERMINAL_PERF__ === true;
}

function attachTerminalLatencyDiagnosticsStore(): void {
  if (!isPerfEnabled() || typeof window === 'undefined') {
    return;
  }

  if (window.__parallelCodeTerminalLatency) {
    return;
  }

  window.__parallelCodeTerminalLatency = {
    getSnapshot: getTerminalLatencyDiagnosticsSnapshot,
    measureRoundTrip,
    startRoundTripProbe,
    waitForRoundTripProbe,
    reset: resetTerminalLatencyDiagnostics,
  };
}

export function installTerminalLatencyDiagnostics(): void {
  attachTerminalLatencyDiagnosticsStore();
}

function getPerfNow(): number {
  if (!isPerfEnabled()) {
    return -1;
  }

  return performance.now();
}

export function isTerminalPerfEnabled(): boolean {
  return isPerfEnabled();
}

/** Record when output data was received from the transport layer. */
export function recordOutputReceived(): number {
  attachTerminalLatencyDiagnosticsStore();
  if (!isPerfEnabled()) return 0;
  return performance.now();
}

/** Record when xterm.write callback fires, completing the render. */
export function recordOutputWritten(receiveTs: number): void {
  attachTerminalLatencyDiagnosticsStore();
  if (!isPerfEnabled() || receiveTs === 0) return;
  const writeTs = performance.now();
  perfSamples.push({ receiveTs, writeTs });
  if (perfSamples.length > MAX_PERF_SAMPLES) perfSamples.shift();
}

/** Get render latency stats (transport receive → xterm write complete). */
export function getRenderLatencyStats(): NumericLatencyStats {
  attachTerminalLatencyDiagnosticsStore();
  if (perfSamples.length === 0) {
    return createEmptyNumericLatencyStats();
  }

  const deltas = perfSamples.map((s) => s.writeTs - s.receiveTs).sort((a, b) => a - b);
  const sum = deltas.reduce((a, b) => a + b, 0);

  return {
    count: deltas.length,
    avg: Math.round((sum / deltas.length) * 100) / 100,
    p50: getPercentileValue(deltas, 0.5),
    p95: getPercentileValue(deltas, 0.95),
    min: getRequiredSortedSampleValue(deltas, 0),
    max: getRequiredSortedSampleValue(deltas, deltas.length - 1),
  };
}

export function resetPerfSamples(): void {
  attachTerminalLatencyDiagnosticsStore();
  perfSamples.length = 0;
}

// ---------------------------------------------------------------------------
// Input batching stage timing
// ---------------------------------------------------------------------------

const inputBufferSamples: number[] = [];
const inputSendSamples: number[] = [];
const MAX_INPUT_STAGE_SAMPLES = 200;

function pushStageSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > MAX_INPUT_STAGE_SAMPLES) {
    samples.shift();
  }
}

function getStageStats(samples: readonly number[]): NumericLatencyStats {
  if (samples.length === 0) {
    return createEmptyNumericLatencyStats();
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((accumulator, value) => accumulator + value, 0);

  return {
    count: sorted.length,
    avg: Math.round((sum / sorted.length) * 100) / 100,
    p50: getPercentileValue(sorted, 0.5),
    p95: getPercentileValue(sorted, 0.95),
    min: getRequiredSortedSampleValue(sorted, 0),
    max: getRequiredSortedSampleValue(sorted, sorted.length - 1),
  };
}

export function recordInputQueued(): number {
  attachTerminalLatencyDiagnosticsStore();
  return getPerfNow();
}

export function recordInputBuffered(queueTs: number): number {
  attachTerminalLatencyDiagnosticsStore();
  const flushTs = getPerfNow();
  if (flushTs >= 0 && queueTs >= 0) {
    pushStageSample(inputBufferSamples, Math.max(0, flushTs - queueTs));
  }
  return flushTs;
}

export function recordInputSent(bufferedTs: number): void {
  attachTerminalLatencyDiagnosticsStore();
  const sendTs = getPerfNow();
  if (sendTs >= 0 && bufferedTs >= 0) {
    pushStageSample(inputSendSamples, Math.max(0, sendTs - bufferedTs));
  }
}

export function getInputStageStats(): {
  buffered: NumericLatencyStats;
  sent: NumericLatencyStats;
} {
  attachTerminalLatencyDiagnosticsStore();
  return {
    buffered: getStageStats(inputBufferSamples),
    sent: getStageStats(inputSendSamples),
  };
}

export function resetInputStageSamples(): void {
  attachTerminalLatencyDiagnosticsStore();
  inputBufferSamples.length = 0;
  inputSendSamples.length = 0;
}

// ---------------------------------------------------------------------------
// Probe-based round-trip latency measurement
// ---------------------------------------------------------------------------

const PROBE_PREFIX = '__LATENCY_PROBE_';
const PROBE_SUFFIX = '__';

interface PendingProbe {
  keepSettledResult: boolean;
  promise: Promise<number>;
  sendTs: number;
  resolve: (rtt: number) => void;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
}

interface SettledProbeResult {
  cleanupTimerId: ReturnType<typeof setTimeout>;
  result: number;
}

const pendingProbes = new Map<string, PendingProbe>();
const probePromises = new Map<string, Promise<number>>();
const settledProbeResults = new Map<string, SettledProbeResult>();
const roundTripSamples: number[] = [];
const MAX_RT_SAMPLES = 50;
const SETTLED_PROBE_RESULT_TTL_MS = 30_000;

function clearSettledProbeResult(marker: string): void {
  const settledProbe = settledProbeResults.get(marker);
  if (!settledProbe) {
    return;
  }

  clearTimeout(settledProbe.cleanupTimerId);
  settledProbeResults.delete(marker);
}

function storeSettledProbeResult(marker: string, result: number): void {
  clearSettledProbeResult(marker);
  settledProbeResults.set(marker, {
    cleanupTimerId: setTimeout(() => {
      settledProbeResults.delete(marker);
    }, SETTLED_PROBE_RESULT_TTL_MS),
    result,
  });
}

function settlePendingProbe(marker: string, result: number): boolean {
  const probe = pendingProbes.get(marker);
  if (!probe) return false;
  clearTimeout(probe.timeoutId);
  pendingProbes.delete(marker);
  probePromises.delete(marker);
  if (probe.keepSettledResult) {
    storeSettledProbeResult(marker, result);
  } else {
    clearSettledProbeResult(marker);
  }
  probe.resolve(result);
  return true;
}

function clearPendingProbes(result: number): void {
  for (const [marker] of pendingProbes) {
    settlePendingProbe(marker, result);
  }
}

/** Generate a unique probe marker. */
function makeProbeMarker(): string {
  return `${PROBE_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}${PROBE_SUFFIX}`;
}

function createPendingProbe(
  marker: string,
  sendTs: number,
  keepSettledResult: boolean,
): PendingProbe {
  let resolveProbe: ((rtt: number) => void) | undefined;
  const promise = new Promise<number>((resolve) => {
    resolveProbe = resolve;
  });
  const probe: PendingProbe = {
    keepSettledResult,
    promise,
    sendTs,
    resolve: (result: number) => {
      resolveProbe?.(result);
    },
    timeoutId: undefined,
  };
  pendingProbes.set(marker, probe);
  probePromises.set(marker, promise);
  return probe;
}

function scheduleProbeTimeout(marker: string, timeoutMs: number): void {
  const probe = pendingProbes.get(marker);
  if (!probe) {
    return;
  }

  probe.timeoutId = setTimeout(() => {
    settlePendingProbe(marker, -1);
  }, timeoutMs);
}

export function startRoundTripProbe(timeoutMs = 5000): string {
  attachTerminalLatencyDiagnosticsStore();
  const marker = makeProbeMarker();
  createPendingProbe(marker, performance.now(), true);
  scheduleProbeTimeout(marker, timeoutMs);
  return marker;
}

export async function waitForRoundTripProbe(marker: string): Promise<number> {
  attachTerminalLatencyDiagnosticsStore();
  const settledProbe = settledProbeResults.get(marker);
  if (settledProbe) {
    clearSettledProbeResult(marker);
    return settledProbe.result;
  }

  const promise = probePromises.get(marker);
  if (!promise) {
    return -1;
  }

  try {
    return await promise;
  } finally {
    probePromises.delete(marker);
    clearSettledProbeResult(marker);
  }
}

/**
 * Send a probe to measure round-trip latency for a terminal.
 * Returns the measured round-trip time in ms, or -1 on timeout.
 */
export function measureRoundTrip(agentId: string, timeoutMs = 5000): Promise<number> {
  attachTerminalLatencyDiagnosticsStore();
  const marker = makeProbeMarker();
  const promise = createPendingProbe(marker, performance.now(), false).promise;

  invoke(IPC.WriteToAgent, { agentId, data: `echo ${marker}\r` })
    .then(() => {
      if (!pendingProbes.has(marker)) {
        return;
      }
      scheduleProbeTimeout(marker, timeoutMs);
    })
    .catch(() => {
      settlePendingProbe(marker, -1);
    });

  return promise.finally(() => {
    probePromises.delete(marker);
    clearSettledProbeResult(marker);
  });
}

/** Returns true when there are active probes waiting for detection. */
export function hasPendingProbes(): boolean {
  attachTerminalLatencyDiagnosticsStore();
  return pendingProbes.size > 0;
}

/**
 * Call from TerminalView's output handler to detect probe markers in output.
 * Only call when `hasPendingProbes()` returns true — the caller skips the
 * expensive UTF-8 decode otherwise.
 */
export function detectProbeInOutput(text: string): void {
  attachTerminalLatencyDiagnosticsStore();
  if (pendingProbes.size === 0) return;

  for (const [marker, probe] of pendingProbes) {
    if (text.includes(marker)) {
      const rtt = Math.round((performance.now() - probe.sendTs) * 100) / 100;
      roundTripSamples.push(rtt);
      if (roundTripSamples.length > MAX_RT_SAMPLES) roundTripSamples.shift();
      settlePendingProbe(marker, rtt);
    }
  }
}

/** Get round-trip latency stats from probe measurements. */
export function getRoundTripStats(): {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
} {
  attachTerminalLatencyDiagnosticsStore();
  if (roundTripSamples.length === 0) {
    return { count: 0, avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }

  const sorted = [...roundTripSamples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    count: sorted.length,
    avg: Math.round((sum / sorted.length) * 100) / 100,
    p50: getPercentileValue(sorted, 0.5),
    p95: getPercentileValue(sorted, 0.95),
    min: getRequiredSortedSampleValue(sorted, 0),
    max: getRequiredSortedSampleValue(sorted, sorted.length - 1),
  };
}

export function resetRoundTripSamples(): void {
  attachTerminalLatencyDiagnosticsStore();
  roundTripSamples.length = 0;
  clearPendingProbes(-1);
  probePromises.clear();
  for (const marker of settledProbeResults.keys()) {
    clearSettledProbeResult(marker);
  }
}

export function assertTerminalLatencyStateCleanForTests(): void {
  if (pendingProbes.size !== 0) {
    throw new Error(`Expected no pending terminal latency probes, found ${pendingProbes.size}`);
  }

  if (probePromises.size !== 0) {
    throw new Error(
      `Expected no retained terminal latency probe promises, found ${probePromises.size}`,
    );
  }

  if (settledProbeResults.size !== 0) {
    throw new Error(
      `Expected no retained terminal latency settled results, found ${settledProbeResults.size}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Flow control event tracking
// ---------------------------------------------------------------------------

interface FlowEvent {
  ts: number;
  type: 'pause' | 'resume';
}

const flowEvents: FlowEvent[] = [];
const MAX_FLOW_EVENTS = 200;

export function recordFlowRequest(type: 'pause' | 'resume'): void {
  attachTerminalLatencyDiagnosticsStore();
  if (!isPerfEnabled()) return;
  flowEvents.push({ ts: performance.now(), type });
  if (flowEvents.length > MAX_FLOW_EVENTS) flowEvents.shift();
}

/** Get flow-control request stats. These reflect requested transitions, not confirmed PTY state. */
export function getFlowRequestStats(): {
  avgPauseRequestWindowMs: number;
  pauseRequests: number;
  resumeRequests: number;
} {
  attachTerminalLatencyDiagnosticsStore();
  let pauses = 0;
  let resumes = 0;
  let totalPauseDuration = 0;
  let lastPauseTs = 0;

  for (const evt of flowEvents) {
    if (evt.type === 'pause') {
      pauses++;
      lastPauseTs = evt.ts;
    } else {
      resumes++;
      if (lastPauseTs > 0) {
        totalPauseDuration += evt.ts - lastPauseTs;
        lastPauseTs = 0;
      }
    }
  }

  return {
    avgPauseRequestWindowMs: pauses > 0 ? Math.round((totalPauseDuration / pauses) * 100) / 100 : 0,
    pauseRequests: pauses,
    resumeRequests: resumes,
  };
}

export function resetFlowEvents(): void {
  attachTerminalLatencyDiagnosticsStore();
  flowEvents.length = 0;
}

export function getTerminalLatencyDiagnosticsSnapshot(): TerminalLatencyDiagnosticsSnapshot {
  attachTerminalLatencyDiagnosticsStore();
  return {
    flow: getFlowRequestStats(),
    input: getInputStageStats(),
    render: getRenderLatencyStats(),
    roundTrip: getRoundTripStats(),
  };
}

export function resetTerminalLatencyDiagnostics(): void {
  attachTerminalLatencyDiagnosticsStore();
  resetPerfSamples();
  resetInputStageSamples();
  resetRoundTripSamples();
  resetFlowEvents();
}
