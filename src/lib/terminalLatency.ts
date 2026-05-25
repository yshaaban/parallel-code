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
import type { ClientMessage } from '../../electron/remote/protocol';
import { getRuntimeClientId } from './runtime-client-id';
import { store } from '../store/state';

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
      waitForRenderedRoundTripProbe: (marker: string) => Promise<number>;
      waitForRoundTripProbe: (marker: string) => Promise<number>;
      reset: () => void;
    };
  }
}

interface TerminalLatencyDiagnosticsSnapshot {
  browserControl: ReturnType<typeof getBrowserControlSendStats>;
  flow: ReturnType<typeof getFlowRequestStats>;
  input: ReturnType<typeof getInputStageStats>;
  render: NumericLatencyStats;
  renderedRoundTrip: ReturnType<typeof getRenderedRoundTripStats>;
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

function pushCappedSample<Value>(samples: Value[], value: Value, maxSamples: number): void {
  samples.push(value);
  if (samples.length > maxSamples) {
    samples.shift();
  }
}

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
    waitForRenderedRoundTripProbe,
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
  pushCappedSample(perfSamples, { receiveTs, writeTs }, MAX_PERF_SAMPLES);
}

/** Get render latency stats (transport receive → xterm write complete). */
export function getRenderLatencyStats(): NumericLatencyStats {
  attachTerminalLatencyDiagnosticsStore();
  const deltas = perfSamples.map((s) => s.writeTs - s.receiveTs).sort((a, b) => a - b);
  return summarizeNumericLatencySamples(deltas);
}

export function resetPerfSamples(): void {
  attachTerminalLatencyDiagnosticsStore();
  perfSamples.length = 0;
}

// ---------------------------------------------------------------------------
// Input batching stage timing
// ---------------------------------------------------------------------------

const inputBufferSamples: number[] = [];
const inputDispatchSamples: number[] = [];
const inputAcceptSamples: number[] = [];
const inputAcceptedSettleSamples: number[] = [];
const inputCommandResultReceivedSamples: number[] = [];
const inputLeaseWaitSamples: number[] = [];
const inputSendSamples: number[] = [];
const MAX_INPUT_STAGE_SAMPLES = 200;
const inputStageSampleSets = [
  inputAcceptSamples,
  inputAcceptedSettleSamples,
  inputBufferSamples,
  inputCommandResultReceivedSamples,
  inputDispatchSamples,
  inputLeaseWaitSamples,
  inputSendSamples,
] as const;

function pushStageSample(samples: number[], value: number): void {
  pushCappedSample(samples, value, MAX_INPUT_STAGE_SAMPLES);
}

function summarizeNumericLatencySamples(samples: readonly number[]): NumericLatencyStats {
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

function recordStageDelta(samples: number[], startTs: number, endTs: number): void {
  if (startTs >= 0 && endTs >= 0) {
    pushStageSample(samples, Math.max(0, endTs - startTs));
  }
}

export function recordInputQueued(): number {
  attachTerminalLatencyDiagnosticsStore();
  return getPerfNow();
}

export function recordInputBuffered(queueTs: number): number {
  attachTerminalLatencyDiagnosticsStore();
  const flushTs = getPerfNow();
  recordStageDelta(inputBufferSamples, queueTs, flushTs);
  return flushTs;
}

export function recordInputLeaseRequested(): number {
  attachTerminalLatencyDiagnosticsStore();
  return getPerfNow();
}

export function recordInputLeaseResolved(requestedTs: number): void {
  attachTerminalLatencyDiagnosticsStore();
  const resolvedTs = getPerfNow();
  recordStageDelta(inputLeaseWaitSamples, requestedTs, resolvedTs);
}

export function recordInputDispatched(bufferedTs: number): number {
  attachTerminalLatencyDiagnosticsStore();
  const dispatchTs = getPerfNow();
  recordStageDelta(inputDispatchSamples, bufferedTs, dispatchTs);
  return dispatchTs;
}

export function recordInputCommandResultReceived(
  dispatchTs: number,
  resultReceivedTs: number,
): number {
  attachTerminalLatencyDiagnosticsStore();
  if (isPerfEnabled() && dispatchTs >= 0 && resultReceivedTs >= 0) {
    recordStageDelta(inputCommandResultReceivedSamples, dispatchTs, resultReceivedTs);
  }
  return resultReceivedTs;
}

export function recordInputAccepted(dispatchTs: number, resultReceivedTs?: number): void {
  attachTerminalLatencyDiagnosticsStore();
  const acceptedTs = getPerfNow();
  recordStageDelta(inputAcceptSamples, dispatchTs, acceptedTs);
  if (acceptedTs >= 0 && resultReceivedTs !== undefined && resultReceivedTs >= 0) {
    recordStageDelta(inputAcceptedSettleSamples, resultReceivedTs, acceptedTs);
  }
}

export function recordInputSent(bufferedTs: number): void {
  attachTerminalLatencyDiagnosticsStore();
  const sendTs = getPerfNow();
  recordStageDelta(inputSendSamples, bufferedTs, sendTs);
}

export function getInputStageStats(): {
  accepted: NumericLatencyStats;
  acceptedSettled: NumericLatencyStats;
  buffered: NumericLatencyStats;
  commandResultReceived: NumericLatencyStats;
  dispatched: NumericLatencyStats;
  leaseWait: NumericLatencyStats;
  sent: NumericLatencyStats;
} {
  attachTerminalLatencyDiagnosticsStore();
  return {
    accepted: summarizeNumericLatencySamples(inputAcceptSamples),
    acceptedSettled: summarizeNumericLatencySamples(inputAcceptedSettleSamples),
    buffered: summarizeNumericLatencySamples(inputBufferSamples),
    commandResultReceived: summarizeNumericLatencySamples(inputCommandResultReceivedSamples),
    dispatched: summarizeNumericLatencySamples(inputDispatchSamples),
    leaseWait: summarizeNumericLatencySamples(inputLeaseWaitSamples),
    sent: summarizeNumericLatencySamples(inputSendSamples),
  };
}

export function resetInputStageSamples(): void {
  attachTerminalLatencyDiagnosticsStore();
  for (const samples of inputStageSampleSets) {
    samples.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Browser control send-side pressure tracking
// ---------------------------------------------------------------------------

type BrowserControlSendType = ClientMessage['type'];

interface BrowserControlSendCounter {
  nonZeroBufferedSendAttempts: number;
  postSendBufferedAmountMax: number;
  sendAttempts: number;
  sendBufferedAmountMax: number;
  sendDurationSamples: number[];
}

interface BrowserControlSendCounterSnapshot {
  nonZeroBufferedSendAttempts: number;
  postSendBufferedAmountMax: number;
  sendAttempts: number;
  sendBufferedAmountMax: number;
  sendDurationMs: NumericLatencyStats;
}

interface BrowserControlSendStats extends BrowserControlSendCounterSnapshot {
  byType: Partial<Record<BrowserControlSendType, BrowserControlSendCounterSnapshot>>;
}

const browserControlSendStats = createBrowserControlSendCounter();
const browserControlSendStatsByType = new Map<BrowserControlSendType, BrowserControlSendCounter>();

function createBrowserControlSendCounter(): BrowserControlSendCounter {
  return {
    nonZeroBufferedSendAttempts: 0,
    postSendBufferedAmountMax: 0,
    sendAttempts: 0,
    sendBufferedAmountMax: 0,
    sendDurationSamples: [],
  };
}

function cloneBrowserControlSendCounter(
  counter: BrowserControlSendCounter,
): BrowserControlSendCounterSnapshot {
  return {
    nonZeroBufferedSendAttempts: counter.nonZeroBufferedSendAttempts,
    postSendBufferedAmountMax: counter.postSendBufferedAmountMax,
    sendAttempts: counter.sendAttempts,
    sendBufferedAmountMax: counter.sendBufferedAmountMax,
    sendDurationMs: summarizeNumericLatencySamples(counter.sendDurationSamples),
  };
}

function recordBrowserControlSendCounter(
  counter: BrowserControlSendCounter,
  bufferedAmount: number,
): void {
  counter.sendAttempts += 1;
  if (bufferedAmount > 0) {
    counter.nonZeroBufferedSendAttempts += 1;
  }
  counter.sendBufferedAmountMax = Math.max(counter.sendBufferedAmountMax, bufferedAmount);
}

function recordBrowserControlSendCompletedCounter(
  counter: BrowserControlSendCounter,
  durationMs: number,
  postSendBufferedAmount: number,
): void {
  pushStageSample(counter.sendDurationSamples, durationMs);
  counter.postSendBufferedAmountMax = Math.max(
    counter.postSendBufferedAmountMax,
    postSendBufferedAmount,
  );
}

function getBrowserControlSendCounterByType(
  type: BrowserControlSendType,
): BrowserControlSendCounter {
  let counter = browserControlSendStatsByType.get(type);
  if (!counter) {
    counter = createBrowserControlSendCounter();
    browserControlSendStatsByType.set(type, counter);
  }
  return counter;
}

function getBrowserControlSendStatsByType(): Partial<
  Record<BrowserControlSendType, BrowserControlSendCounterSnapshot>
> {
  const byType: Partial<Record<BrowserControlSendType, BrowserControlSendCounterSnapshot>> = {};
  for (const [type, counter] of browserControlSendStatsByType) {
    byType[type] = cloneBrowserControlSendCounter(counter);
  }
  return byType;
}

export function recordBrowserControlSendBufferedAmount(
  type: BrowserControlSendType,
  bufferedAmount: number,
): void {
  attachTerminalLatencyDiagnosticsStore();
  if (!isPerfEnabled() || !Number.isFinite(bufferedAmount) || bufferedAmount < 0) {
    return;
  }

  recordBrowserControlSendCounter(browserControlSendStats, bufferedAmount);
  recordBrowserControlSendCounter(getBrowserControlSendCounterByType(type), bufferedAmount);
}

export function recordBrowserControlSendCompleted(
  type: BrowserControlSendType,
  durationMs: number,
  postSendBufferedAmount: number,
): void {
  attachTerminalLatencyDiagnosticsStore();
  if (
    !isPerfEnabled() ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    !Number.isFinite(postSendBufferedAmount) ||
    postSendBufferedAmount < 0
  ) {
    return;
  }

  recordBrowserControlSendCompletedCounter(
    browserControlSendStats,
    durationMs,
    postSendBufferedAmount,
  );
  recordBrowserControlSendCompletedCounter(
    getBrowserControlSendCounterByType(type),
    durationMs,
    postSendBufferedAmount,
  );
}

export function getBrowserControlSendStats(): BrowserControlSendStats {
  attachTerminalLatencyDiagnosticsStore();
  return {
    ...cloneBrowserControlSendCounter(browserControlSendStats),
    byType: getBrowserControlSendStatsByType(),
  };
}

function resetBrowserControlSendCounter(counter: BrowserControlSendCounter): void {
  counter.nonZeroBufferedSendAttempts = 0;
  counter.postSendBufferedAmountMax = 0;
  counter.sendAttempts = 0;
  counter.sendBufferedAmountMax = 0;
  counter.sendDurationSamples.length = 0;
}

export function resetBrowserControlSendStats(): void {
  attachTerminalLatencyDiagnosticsStore();
  resetBrowserControlSendCounter(browserControlSendStats);
  browserControlSendStatsByType.clear();
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
  timeoutMs: number;
}

interface SettledProbeResult {
  cleanupTimerId: ReturnType<typeof setTimeout>;
  result: number;
}

const pendingProbes = new Map<string, PendingProbe>();
const pendingProbeRenders = new Map<string, PendingProbe>();
const probePromises = new Map<string, Promise<number>>();
const probeRenderPromises = new Map<string, Promise<number>>();
const settledProbeResults = new Map<string, SettledProbeResult>();
const settledRenderedProbeResults = new Map<string, SettledProbeResult>();
const roundTripSamples: number[] = [];
const renderedRoundTripSamples: number[] = [];
const MAX_RT_SAMPLES = 50;
const SETTLED_PROBE_RESULT_TTL_MS = 30_000;

function clearSettledProbeResultFrom(
  settledResults: Map<string, SettledProbeResult>,
  marker: string,
): void {
  const settledProbe = settledResults.get(marker);
  if (!settledProbe) {
    return;
  }

  clearTimeout(settledProbe.cleanupTimerId);
  settledResults.delete(marker);
}

function storeSettledProbeResultIn(
  settledResults: Map<string, SettledProbeResult>,
  marker: string,
  result: number,
): void {
  clearSettledProbeResultFrom(settledResults, marker);
  settledResults.set(marker, {
    cleanupTimerId: setTimeout(() => {
      settledResults.delete(marker);
    }, SETTLED_PROBE_RESULT_TTL_MS),
    result,
  });
}

function clearSettledProbeResult(marker: string): void {
  clearSettledProbeResultFrom(settledProbeResults, marker);
}

function clearSettledRenderedProbeResult(marker: string): void {
  clearSettledProbeResultFrom(settledRenderedProbeResults, marker);
}

function settlePendingProbe(marker: string, result: number): boolean {
  const settled = settlePendingProbeIn(
    marker,
    result,
    pendingProbes,
    probePromises,
    settledProbeResults,
  );
  if (settled && result >= 0) {
    scheduleRenderedProbeTimeout(marker);
  }
  return settled;
}

function settlePendingProbeRender(marker: string, result: number): boolean {
  return settlePendingProbeIn(
    marker,
    result,
    pendingProbeRenders,
    probeRenderPromises,
    settledRenderedProbeResults,
  );
}

function settlePendingProbeIn(
  marker: string,
  result: number,
  pending: Map<string, PendingProbe>,
  promises: Map<string, Promise<number>>,
  settledResults: Map<string, SettledProbeResult>,
): boolean {
  const probe = pending.get(marker);
  if (!probe) {
    return false;
  }

  if (probe.timeoutId !== undefined) {
    clearTimeout(probe.timeoutId);
  }
  pending.delete(marker);
  promises.delete(marker);
  if (probe.keepSettledResult) {
    storeSettledProbeResultIn(settledResults, marker, result);
  } else {
    clearSettledProbeResultFrom(settledResults, marker);
  }
  probe.resolve(result);
  return true;
}

function clearPendingProbes(result: number): void {
  for (const [marker] of pendingProbes) {
    settlePendingProbe(marker, result);
  }
  for (const [marker] of pendingProbeRenders) {
    settlePendingProbeRender(marker, result);
  }
}

/** Generate a unique probe marker. */
function makeProbeMarker(): string {
  return `${PROBE_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}${PROBE_SUFFIX}`;
}

function createResolvableProbePromise(): {
  promise: Promise<number>;
  resolve: (result: number) => void;
} {
  let resolvePromise: ((result: number) => void) | undefined;
  const promise = new Promise<number>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (result: number) => {
      resolvePromise?.(result);
    },
  };
}

function createPendingProbe(
  marker: string,
  sendTs: number,
  keepSettledResult: boolean,
  timeoutMs: number,
): PendingProbe {
  const probePromise = createResolvableProbePromise();
  const probe: PendingProbe = {
    keepSettledResult,
    promise: probePromise.promise,
    sendTs,
    resolve: probePromise.resolve,
    timeoutId: undefined,
    timeoutMs,
  };
  pendingProbes.set(marker, probe);
  probePromises.set(marker, probePromise.promise);
  const renderedProbePromise = createResolvableProbePromise();
  pendingProbeRenders.set(marker, {
    keepSettledResult,
    promise: renderedProbePromise.promise,
    resolve: renderedProbePromise.resolve,
    sendTs,
    timeoutId: undefined,
    timeoutMs,
  });
  probeRenderPromises.set(marker, renderedProbePromise.promise);
  return probe;
}

function scheduleProbeTimeout(marker: string): void {
  const probe = pendingProbes.get(marker);
  if (probe && probe.timeoutId === undefined) {
    probe.timeoutId = setTimeout(() => {
      settlePendingProbe(marker, -1);
    }, probe.timeoutMs);
  }

  scheduleRenderedProbeTimeout(marker);
}

function scheduleRenderedProbeTimeout(marker: string): void {
  const probe = pendingProbeRenders.get(marker);
  if (!probe || probe.timeoutId !== undefined) {
    return;
  }

  probe.timeoutId = setTimeout(() => {
    settlePendingProbeRender(marker, -1);
  }, probe.timeoutMs);
}

export function startRoundTripProbe(timeoutMs = 5000): string {
  attachTerminalLatencyDiagnosticsStore();
  const marker = makeProbeMarker();
  createPendingProbe(marker, performance.now(), true, timeoutMs);
  scheduleProbeTimeout(marker);
  return marker;
}

export async function waitForRoundTripProbe(marker: string): Promise<number> {
  attachTerminalLatencyDiagnosticsStore();
  return waitForProbeResult(marker, probePromises, settledProbeResults, clearSettledProbeResult);
}

export async function waitForRenderedRoundTripProbe(marker: string): Promise<number> {
  attachTerminalLatencyDiagnosticsStore();
  return waitForProbeResult(
    marker,
    probeRenderPromises,
    settledRenderedProbeResults,
    clearSettledRenderedProbeResult,
  );
}

async function waitForProbeResult(
  marker: string,
  promises: Map<string, Promise<number>>,
  settledResults: Map<string, SettledProbeResult>,
  clearSettledResult: (marker: string) => void,
): Promise<number> {
  const settledProbe = settledResults.get(marker);
  if (settledProbe) {
    clearSettledResult(marker);
    return settledProbe.result;
  }

  const promise = promises.get(marker);
  if (!promise) {
    return -1;
  }

  try {
    return await promise;
  } finally {
    promises.delete(marker);
    clearSettledResult(marker);
  }
}

/**
 * Send a probe to measure round-trip latency for a terminal.
 * Returns the measured round-trip time in ms, or -1 on timeout.
 */
export function measureRoundTrip(agentId: string, timeoutMs = 5000): Promise<number> {
  attachTerminalLatencyDiagnosticsStore();
  const marker = makeProbeMarker();
  const promise = createPendingProbe(marker, performance.now(), false, timeoutMs).promise;
  const taskId = store.agents?.[agentId]?.taskId;

  invoke(IPC.WriteToAgent, {
    agentId,
    ...(taskId ? { controllerId: getRuntimeClientId(), taskId } : {}),
    data: `echo ${marker}\r`,
  })
    .then(() => {
      scheduleProbeTimeout(marker);
    })
    .catch(() => {
      settlePendingProbe(marker, -1);
      settlePendingProbeRender(marker, -1);
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

export function hasPendingProbeRenders(): boolean {
  attachTerminalLatencyDiagnosticsStore();
  return pendingProbeRenders.size > 0;
}

/**
 * Call from TerminalView's output handler to detect probe markers in output.
 * Only call when `hasPendingProbes()` returns true — the caller skips the
 * expensive UTF-8 decode otherwise.
 */
export function detectProbeInOutput(text: string): void {
  attachTerminalLatencyDiagnosticsStore();
  detectProbeMarkersInOutput(text, pendingProbes, roundTripSamples, settlePendingProbe);
}

export function detectRenderedProbeInOutput(text: string): void {
  attachTerminalLatencyDiagnosticsStore();
  detectProbeMarkersInOutput(
    text,
    pendingProbeRenders,
    renderedRoundTripSamples,
    settlePendingProbeRender,
  );
}

function detectProbeMarkersInOutput(
  text: string,
  pending: Map<string, { sendTs: number }>,
  samples: number[],
  settleProbe: (marker: string, result: number) => boolean,
): void {
  if (pending.size === 0) {
    return;
  }

  for (const [marker, probe] of pending) {
    if (text.includes(marker)) {
      const rtt = Math.round((performance.now() - probe.sendTs) * 100) / 100;
      pushCappedSample(samples, rtt, MAX_RT_SAMPLES);
      settleProbe(marker, rtt);
    }
  }
}

/** Get round-trip latency stats from probe measurements. */
export function getRoundTripStats(): NumericLatencyStats {
  attachTerminalLatencyDiagnosticsStore();
  return summarizeNumericLatencySamples(roundTripSamples);
}

export function getRenderedRoundTripStats(): NumericLatencyStats {
  attachTerminalLatencyDiagnosticsStore();
  return summarizeNumericLatencySamples(renderedRoundTripSamples);
}

export function resetRoundTripSamples(): void {
  attachTerminalLatencyDiagnosticsStore();
  roundTripSamples.length = 0;
  renderedRoundTripSamples.length = 0;
  clearPendingProbes(-1);
  probePromises.clear();
  probeRenderPromises.clear();
  for (const marker of settledProbeResults.keys()) {
    clearSettledProbeResult(marker);
  }
  for (const marker of settledRenderedProbeResults.keys()) {
    clearSettledRenderedProbeResult(marker);
  }
}

export function assertTerminalLatencyStateCleanForTests(): void {
  assertMapEmpty(pendingProbes, 'pending terminal latency probes');
  assertMapEmpty(pendingProbeRenders, 'pending terminal latency rendered probes');
  assertMapEmpty(probePromises, 'retained terminal latency probe promises');
  assertMapEmpty(probeRenderPromises, 'retained terminal latency rendered probe promises');
  assertMapEmpty(settledProbeResults, 'retained terminal latency settled results');
  assertMapEmpty(settledRenderedProbeResults, 'retained terminal latency rendered settled results');
}

function assertMapEmpty(map: ReadonlyMap<unknown, unknown>, description: string): void {
  if (map.size !== 0) {
    throw new Error(`Expected no ${description}, found ${map.size}`);
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
    browserControl: getBrowserControlSendStats(),
    flow: getFlowRequestStats(),
    input: getInputStageStats(),
    render: getRenderLatencyStats(),
    renderedRoundTrip: getRenderedRoundTripStats(),
    roundTrip: getRoundTripStats(),
  };
}

export function resetTerminalLatencyDiagnostics(): void {
  attachTerminalLatencyDiagnosticsStore();
  resetPerfSamples();
  resetBrowserControlSendStats();
  resetInputStageSamples();
  resetRoundTripSamples();
  resetFlowEvents();
}
