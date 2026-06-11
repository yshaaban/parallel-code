import type { WebSocketReconnectDelayContext } from './websocket-client';

const DEFAULT_FAST_RECONNECT_WINDOW_MS = 30_000;
const DEFAULT_STALE_SUCCESS_WINDOW_MS = 120_000;
const FAST_RECONNECT_DELAYS_MS = [0, 250, 500, 1_000, 2_000] as const;
const STALE_SUCCESS_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const MAX_RECONNECT_DELAY_MS = 5_000;

export const WEAK_CONNECTIVITY_CLIENT_HEARTBEAT = {
  maxMissedPongs: 2,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 12_000,
} as const;

// Wake-time zombie-socket detection: after a hidden gap (or an 'online'
// event), an OPEN socket is probed with a short ping deadline instead of being
// trusted, so silent input loss is bounded by the deadline rather than the
// heartbeat cycle.
export const WAKE_LIVENESS_PROBE = {
  minHiddenGapMs: 5_000,
  probeDeadlineMs: 2_000,
} as const;

function clampDelay(delayMs: number): number {
  return Math.max(0, Math.min(delayMs, MAX_RECONNECT_DELAY_MS));
}

function getAgeMs(timestampMs: number | null, nowMs: number): number | null {
  if (timestampMs === null) {
    return null;
  }
  return Math.max(0, nowMs - timestampMs);
}

function isAgeWithinWindow(ageMs: number | null, windowMs: number): boolean {
  return ageMs !== null && ageMs <= windowMs;
}

function getDelayFromTable(attempt: number, delaysMs: readonly number[]): number {
  const index = Math.min(Math.max(0, attempt), delaysMs.length - 1);
  return delaysMs[index] ?? MAX_RECONNECT_DELAY_MS;
}

function addJitter(delayMs: number): number {
  if (delayMs === 0) {
    return 0;
  }

  return Math.floor(delayMs * (0.85 + Math.random() * 0.3));
}

export function getWeakConnectivityReconnectDelayMs(
  attempt: number,
  context: WebSocketReconnectDelayContext,
): number {
  if (!context.hasConnected) {
    return clampDelay(addJitter(getDelayFromTable(attempt, STALE_SUCCESS_RECONNECT_DELAYS_MS)));
  }

  const nowMs = Date.now();
  const disconnectedAgeMs = getAgeMs(context.lastDisconnectedAt, nowMs);
  if (isAgeWithinWindow(disconnectedAgeMs, DEFAULT_FAST_RECONNECT_WINDOW_MS)) {
    return clampDelay(addJitter(getDelayFromTable(attempt, FAST_RECONNECT_DELAYS_MS)));
  }

  if (isAgeWithinWindow(disconnectedAgeMs, DEFAULT_STALE_SUCCESS_WINDOW_MS)) {
    return clampDelay(addJitter(getDelayFromTable(attempt, STALE_SUCCESS_RECONNECT_DELAYS_MS)));
  }

  return clampDelay(addJitter(Math.min(200 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS)));
}
