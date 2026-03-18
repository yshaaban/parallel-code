let terminalTraceClockOffsetMs: number | null = null;
let terminalTraceClockBestRttMs: number | null = null;

export function getLocalTerminalTraceTimestampMs(): number {
  return performance.timeOrigin + performance.now();
}

export function clearTerminalTraceClockAlignment(): void {
  terminalTraceClockBestRttMs = null;
  terminalTraceClockOffsetMs = null;
}

export function setTerminalTraceClockAlignment(offsetMs: number, rttMs: number): void {
  if (!Number.isFinite(offsetMs) || !Number.isFinite(rttMs) || rttMs < 0) {
    return;
  }

  if (terminalTraceClockBestRttMs !== null && rttMs > terminalTraceClockBestRttMs) {
    return;
  }

  terminalTraceClockBestRttMs = rttMs;
  terminalTraceClockOffsetMs = offsetMs;
}

export function hasTerminalTraceClockAlignment(): boolean {
  return terminalTraceClockOffsetMs !== null;
}

export function getTerminalTraceTimestampMs(): number {
  const now = getLocalTerminalTraceTimestampMs();
  return terminalTraceClockOffsetMs === null ? now : now + terminalTraceClockOffsetMs;
}

export function getTerminalTraceClockAlignmentSnapshot(): {
  bestRttMs: number | null;
  offsetMs: number | null;
} {
  return {
    bestRttMs: terminalTraceClockBestRttMs,
    offsetMs: terminalTraceClockOffsetMs,
  };
}

export function resetTerminalTraceClockAlignmentForTests(): void {
  clearTerminalTraceClockAlignment();
}
