import {
  hasTerminalDenseOverloadExperimentConfig,
  hasTerminalNonDenseFramePressureResponsiveExperimentConfig,
} from '../lib/terminal-performance-experiments';
import { isTerminalHighLoadModeEnabled } from './terminal-high-load-mode';

export type TerminalFramePressureLevel = 'critical' | 'elevated' | 'stable';

const ELEVATED_FRAME_GAP_MS = 20;
const CRITICAL_FRAME_GAP_MS = 40;
const MAX_RECENT_FRAME_GAPS = 12;

let framePressureAnimationFrame: ReturnType<typeof requestAnimationFrame> | null = null;
let framePressureInstalled = false;
let framePressureLevel: TerminalFramePressureLevel = 'stable';
let lastFrameAtMs: number | null = null;
let recentFrameGapsMs: number[] = [];
let framePressureLevelOverride: TerminalFramePressureLevel | null = null;
const framePressureListeners = new Set<() => void>();

function isFramePressureMonitoringEnabled(): boolean {
  const denseOverloadMonitoringEnabled =
    hasTerminalDenseOverloadExperimentConfig() && isTerminalHighLoadModeEnabled();
  return (
    (hasTerminalNonDenseFramePressureResponsiveExperimentConfig() ||
      denseOverloadMonitoringEnabled) &&
    typeof window !== 'undefined' &&
    typeof requestAnimationFrame === 'function' &&
    typeof cancelAnimationFrame === 'function'
  );
}

function pushFrameGapSample(frameGapMs: number): void {
  recentFrameGapsMs.push(frameGapMs);
  if (recentFrameGapsMs.length > MAX_RECENT_FRAME_GAPS) {
    recentFrameGapsMs.shift();
  }
}

function notifyFramePressureListeners(): void {
  for (const listener of framePressureListeners) {
    listener();
  }
}

function getFramePressureLevelFromRecentSamples(): TerminalFramePressureLevel {
  if (recentFrameGapsMs.some((frameGapMs) => frameGapMs >= CRITICAL_FRAME_GAP_MS)) {
    return 'critical';
  }

  if (recentFrameGapsMs.some((frameGapMs) => frameGapMs >= ELEVATED_FRAME_GAP_MS)) {
    return 'elevated';
  }

  return 'stable';
}

function sampleFramePressure(frameTimeMs: number): void {
  if (!framePressureInstalled) {
    return;
  }

  if (lastFrameAtMs !== null) {
    pushFrameGapSample(Math.max(0, frameTimeMs - lastFrameAtMs));
    const nextFramePressureLevel = getFramePressureLevelFromRecentSamples();
    if (nextFramePressureLevel !== framePressureLevel) {
      framePressureLevel = nextFramePressureLevel;
      notifyFramePressureListeners();
    }
  }

  lastFrameAtMs = frameTimeMs;
  framePressureAnimationFrame = requestAnimationFrame(sampleFramePressure);
}

function installFramePressureMonitor(): void {
  if (framePressureInstalled || !isFramePressureMonitoringEnabled()) {
    return;
  }

  framePressureInstalled = true;
  framePressureAnimationFrame = requestAnimationFrame(sampleFramePressure);
}

export function getTerminalFramePressureLevel(): TerminalFramePressureLevel {
  if (framePressureLevelOverride !== null) {
    return framePressureLevelOverride;
  }

  installFramePressureMonitor();
  return framePressureLevel;
}

export function subscribeTerminalFramePressureChanges(listener: () => void): () => void {
  framePressureListeners.add(listener);
  return function unsubscribe(): void {
    framePressureListeners.delete(listener);
  };
}

export function resetTerminalFramePressureForTests(): void {
  if (framePressureAnimationFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(framePressureAnimationFrame);
  }

  framePressureAnimationFrame = null;
  framePressureInstalled = false;
  framePressureLevel = 'stable';
  framePressureLevelOverride = null;
  lastFrameAtMs = null;
  recentFrameGapsMs = [];
  framePressureListeners.clear();
}

export function setTerminalFramePressureLevelForTests(
  nextLevel: TerminalFramePressureLevel | null,
): void {
  framePressureLevelOverride = nextLevel;
  notifyFramePressureListeners();
}
