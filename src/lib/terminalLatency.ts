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
  }
}

interface PerfSample {
  receiveTs: number; // performance.now() when output arrived from WebSocket
  writeTs: number; // performance.now() when xterm.write callback fired
}

const perfSamples: PerfSample[] = [];
const MAX_PERF_SAMPLES = 200;

function isPerfEnabled(): boolean {
  return typeof window !== 'undefined' && window.__TERMINAL_PERF__ === true;
}

/** Record when output data was received from the transport layer. */
export function recordOutputReceived(): number {
  if (!isPerfEnabled()) return 0;
  return performance.now();
}

/** Record when xterm.write callback fires, completing the render. */
export function recordOutputWritten(receiveTs: number): void {
  if (!isPerfEnabled() || receiveTs === 0) return;
  const writeTs = performance.now();
  perfSamples.push({ receiveTs, writeTs });
  if (perfSamples.length > MAX_PERF_SAMPLES) perfSamples.shift();
}

/** Get render latency stats (transport receive → xterm write complete). */
export function getRenderLatencyStats(): {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
} {
  if (perfSamples.length === 0) {
    return { count: 0, avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }

  const deltas = perfSamples.map((s) => s.writeTs - s.receiveTs).sort((a, b) => a - b);
  const sum = deltas.reduce((a, b) => a + b, 0);

  return {
    count: deltas.length,
    avg: Math.round((sum / deltas.length) * 100) / 100,
    p50: deltas[Math.floor(deltas.length * 0.5)],
    p95: deltas[Math.floor(deltas.length * 0.95)],
    min: deltas[0],
    max: deltas[deltas.length - 1],
  };
}

export function resetPerfSamples(): void {
  perfSamples.length = 0;
}

// ---------------------------------------------------------------------------
// Probe-based round-trip latency measurement
// ---------------------------------------------------------------------------

const PROBE_PREFIX = '__LATENCY_PROBE_';
const PROBE_SUFFIX = '__';

interface PendingProbe {
  sendTs: number;
  resolve: (rtt: number) => void;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
}

const pendingProbes = new Map<string, PendingProbe>();
const roundTripSamples: number[] = [];
const MAX_RT_SAMPLES = 50;

function settlePendingProbe(marker: string, result: number): boolean {
  const probe = pendingProbes.get(marker);
  if (!probe) return false;
  clearTimeout(probe.timeoutId);
  pendingProbes.delete(marker);
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

/**
 * Send a probe to measure round-trip latency for a terminal.
 * Returns the measured round-trip time in ms, or -1 on timeout.
 */
export function measureRoundTrip(agentId: string, timeoutMs = 5000): Promise<number> {
  const marker = makeProbeMarker();
  const sendTs = performance.now();

  return new Promise<number>((resolve) => {
    // Register probe BEFORE sending the write so hasPendingProbes() is true
    // when the fast echo arrives. Timeout starts AFTER write is acknowledged
    // so IPC backpressure doesn't cause false -1 results.
    pendingProbes.set(marker, { sendTs, resolve, timeoutId: undefined });

    invoke(IPC.WriteToAgent, { agentId, data: `echo ${marker}\r` })
      .then(() => {
        // If detectProbeInOutput already resolved the probe, nothing to do.
        const probe = pendingProbes.get(marker);
        if (!probe) return;
        probe.timeoutId = setTimeout(() => {
          settlePendingProbe(marker, -1);
        }, timeoutMs);
      })
      .catch(() => {
        settlePendingProbe(marker, -1);
      });
  });
}

/** Returns true when there are active probes waiting for detection. */
export function hasPendingProbes(): boolean {
  return pendingProbes.size > 0;
}

/**
 * Call from TerminalView's output handler to detect probe markers in output.
 * Only call when `hasPendingProbes()` returns true — the caller skips the
 * expensive UTF-8 decode otherwise.
 */
export function detectProbeInOutput(text: string): void {
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
  if (roundTripSamples.length === 0) {
    return { count: 0, avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }

  const sorted = [...roundTripSamples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    count: sorted.length,
    avg: Math.round((sum / sorted.length) * 100) / 100,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function resetRoundTripSamples(): void {
  roundTripSamples.length = 0;
  clearPendingProbes(-1);
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

export function recordFlowEvent(type: 'pause' | 'resume'): void {
  if (!isPerfEnabled()) return;
  flowEvents.push({ ts: performance.now(), type });
  if (flowEvents.length > MAX_FLOW_EVENTS) flowEvents.shift();
}

/** Get flow control oscillation stats. */
export function getFlowStats(): {
  totalPauses: number;
  totalResumes: number;
  avgPauseDurationMs: number;
} {
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
    totalPauses: pauses,
    totalResumes: resumes,
    avgPauseDurationMs: pauses > 0 ? Math.round((totalPauseDuration / pauses) * 100) / 100 : 0,
  };
}

export function resetFlowEvents(): void {
  flowEvents.length = 0;
}
