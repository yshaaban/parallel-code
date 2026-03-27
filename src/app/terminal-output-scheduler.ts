import {
  recordTerminalOutputSchedulerCandidateCount,
  recordTerminalOutputSchedulerDrain,
  recordTerminalOutputSchedulerScan,
} from './runtime-diagnostics';
import {
  isTerminalDenseFocusedInputProtectionActive,
  isTerminalFocusedInputEchoReservationActive,
} from './terminal-focused-input';
import { getTerminalFramePressureLevel } from './terminal-frame-pressure';
import { isTerminalDenseOverloadActive } from './terminal-dense-overload';
import {
  isTerminalSwitchWindowActive,
  isTerminalSwitchWindowAwaitingFirstPaint,
  isTerminalSwitchWindowAwaitingInputReady,
  isTerminalSwitchWindowSettling,
  isTerminalSwitchWindowTargetRecoveryActive,
  isTerminalSwitchTargetTask,
} from './terminal-switch-window';
import {
  getTerminalOutputDrainCandidateLimit,
  getTerminalOutputDrainBudget,
  getTerminalOutputPriorityOrder,
  type TerminalOutputPriority,
} from '../lib/terminal-output-priority';
import { getVisibleTerminalCount } from './terminal-visible-set';
import {
  getTerminalExperimentDenseOverloadLaneFrameBudgetOverride,
  getTerminalExperimentDenseOverloadNonTargetVisibleFrameBudgetOverride,
  getTerminalExperimentDenseOverloadPressureDrainBudgetScale,
  getTerminalExperimentDenseOverloadSwitchTargetReserveBytes,
  getTerminalExperimentLaneFrameBudgetOverride,
  getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale,
  getTerminalExperimentNonTargetVisibleFrameBudgetOverride,
  getTerminalExperimentSwitchTargetReserveBytes,
  getTerminalExperimentVisibleCountPressureDrainBudgetScale,
  getTerminalPerformanceExperimentConfig,
} from '../lib/terminal-performance-experiments';
import type { TerminalFramePressureLevel } from './terminal-frame-pressure';

type ScheduledHandle =
  | {
      handle: ReturnType<typeof requestAnimationFrame>;
      kind: 'animation-frame';
      lane: TerminalOutputDrainLane;
    }
  | {
      handle: ReturnType<typeof setTimeout>;
      kind: 'timeout';
      lane: TerminalOutputDrainLane;
    };

interface TerminalOutputCandidate {
  drain: (maxBytes: number) => number;
  getPendingBytes: () => number;
  getPriority: () => TerminalOutputPriority;
  key: string;
  taskId: string;
}

export interface TerminalOutputRegistration {
  requestDrain: () => void;
  unregister: () => void;
  updatePriority: () => void;
}

export interface TerminalOutputPacingSnapshot {
  denseFocusedInputProtectionActive: boolean;
  framePressureLevel: TerminalFramePressureLevel;
  focusedPreemptionWindowActive: boolean;
  laneFrameBudgetBytes: Record<TerminalOutputDrainLane, number>;
  sharedNonTargetVisibleFrameBudgetBytes: number | null;
  switchTargetReserveBudgetBytes: number | null;
  switchWindowActive: boolean;
  visibleTerminalCount: number;
}

type TerminalOutputDrainLane = 'focused' | 'visible' | 'hidden';

interface VisibleDrainBudgetContext {
  remainingNonTargetVisibleCandidateLimit: number | null;
  remainingNonTargetVisibleFrameBudget: number | null;
  remainingSwitchTargetReserveBudget: number | null;
}

const terminalOutputCandidates = new Map<string, TerminalOutputCandidate>();
const lastDrainedKeyByPriority = new Map<TerminalOutputPriority, string>();
const FOCUSED_TERMINAL_DRAIN_DELAY_MS = 0;
const DEFAULT_MAX_FRAME_DRAIN_BYTES = 160 * 1024;
const HIDDEN_TERMINAL_DRAIN_DELAY_MS = 48;
const TERMINAL_OUTPUT_PRIORITY_BANDS: readonly TerminalOutputPriority[] = [
  'focused',
  'switch-target-visible',
  'active-visible',
  'visible-background',
  'hidden',
];
const MIN_VISIBLE_BACKGROUND_FRAME_BUDGET_BYTES = 1_024;
const DENSE_FOCUSED_INPUT_ACTIVE_VISIBLE_BUDGET_SCALE = 0.125;
const DENSE_FOCUSED_INPUT_BACKGROUND_BUDGET_SCALE = 0.0625;
const DENSE_FOCUSED_INPUT_HIDDEN_BUDGET_SCALE = 0.0625;
const DENSE_FOCUSED_INPUT_ECHO_RESERVATION_FOCUSED_BUDGET_SCALE = 2;
const DENSE_FOCUSED_INPUT_NON_TARGET_VISIBLE_CANDIDATE_LIMIT = 1;
const DENSE_FOCUSED_INPUT_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES = 1_024;

let scheduledDrain: ScheduledHandle | null = null;
let focusedTerminalOutputPreemptionUntilAt = 0;

function hasFocusedTerminalOutputPreemptionWindow(): boolean {
  return performance.now() <= focusedTerminalOutputPreemptionUntilAt;
}

function hasTerminalOutputSwitchWindow(): boolean {
  return isTerminalSwitchWindowActive();
}

function shouldPromoteSwitchTargetToFocusedLane(): boolean {
  if (!hasTerminalOutputSwitchWindow()) {
    return false;
  }

  if (isTerminalSwitchWindowAwaitingFirstPaint()) {
    return true;
  }

  return (
    getTerminalPerformanceExperimentConfig().switchTargetProtectUntilInputReady === true &&
    isTerminalSwitchWindowAwaitingInputReady()
  );
}

function getSwitchWindowPriorityBands(): readonly TerminalOutputPriority[] {
  if (shouldPromoteSwitchTargetToFocusedLane()) {
    return ['focused', 'switch-target-visible'];
  }

  return ['focused', 'switch-target-visible', 'active-visible'];
}

function getSwitchWindowDesiredDrainLane(): TerminalOutputDrainLane {
  if (shouldPromoteSwitchTargetToFocusedLane()) {
    return 'focused';
  }

  return 'visible';
}

function getHiddenTerminalDrainDelayMs(): number {
  return (
    getTerminalPerformanceExperimentConfig().backgroundDrainDelayMs ??
    HIDDEN_TERMINAL_DRAIN_DELAY_MS
  );
}

function getTerminalOutputLaneFrameBudget(
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
): number {
  if (isTerminalDenseOverloadActive(visibleTerminalCount)) {
    const denseOverloadOverride = getTerminalExperimentDenseOverloadLaneFrameBudgetOverride(
      drainLane,
      visibleTerminalCount,
    );
    if (denseOverloadOverride !== null) {
      return denseOverloadOverride;
    }
  }

  const override = getTerminalExperimentLaneFrameBudgetOverride(drainLane, visibleTerminalCount);
  return override ?? DEFAULT_MAX_FRAME_DRAIN_BYTES;
}

function getTerminalOutputPriorityBandsForLane(
  drainLane: TerminalOutputDrainLane,
): readonly TerminalOutputPriority[] {
  if (drainLane === 'focused' && hasTerminalOutputSwitchWindow()) {
    return getSwitchWindowPriorityBands();
  }

  if (drainLane === 'focused' && hasFocusedTerminalOutputPreemptionWindow()) {
    switch (getTerminalPerformanceExperimentConfig().focusedPreemptionDrainScope) {
      case 'focused':
        return ['focused'];
      case 'visible':
        return ['focused', 'active-visible', 'visible-background'];
      case 'all':
        return TERMINAL_OUTPUT_PRIORITY_BANDS;
    }
  }

  return TERMINAL_OUTPUT_PRIORITY_BANDS;
}

function hasPendingTerminalOutputMatching(
  predicate: (candidate: TerminalOutputCandidate) => boolean,
): boolean {
  const startedAtMs = performance.now();
  let scannedCandidates = 0;

  for (const candidate of terminalOutputCandidates.values()) {
    scannedCandidates += 1;
    if (candidate.getPendingBytes() > 0 && predicate(candidate)) {
      recordTerminalOutputSchedulerScan(scannedCandidates, performance.now() - startedAtMs);
      return true;
    }
  }

  recordTerminalOutputSchedulerScan(scannedCandidates, performance.now() - startedAtMs);
  return false;
}

function hasVisibleTerminalOutputPending(): boolean {
  return hasPendingTerminalOutputMatching((candidate) => candidate.getPriority() !== 'hidden');
}

function hasFocusedTerminalOutputPending(): boolean {
  return hasPendingTerminalOutputMatching((candidate) => candidate.getPriority() === 'focused');
}

function hasSwitchTargetTerminalOutputPending(): boolean {
  return hasPendingTerminalOutputMatching(
    (candidate) => candidate.getPriority() === 'switch-target-visible',
  );
}

function getTerminalOutputDrainLaneOrder(lane: TerminalOutputDrainLane): number {
  switch (lane) {
    case 'focused':
      return 0;
    case 'visible':
      return 1;
    case 'hidden':
      return 2;
  }
}

function getDesiredTerminalOutputDrainLane(): TerminalOutputDrainLane {
  if (hasFocusedTerminalOutputPending()) {
    return 'focused';
  }

  if (hasTerminalOutputSwitchWindow() && hasSwitchTargetTerminalOutputPending()) {
    return getSwitchWindowDesiredDrainLane();
  }

  if (hasVisibleTerminalOutputPending()) {
    return 'visible';
  }

  return 'hidden';
}

function isNonTargetVisiblePriority(priority: TerminalOutputPriority): boolean {
  return priority === 'active-visible' || priority === 'visible-background';
}

function canDrainTerminalOutputCandidate(
  candidate: TerminalOutputCandidate,
  priority: TerminalOutputPriority,
): boolean {
  if (!isTerminalSwitchWindowTargetRecoveryActive()) {
    return true;
  }

  switch (priority) {
    case 'focused':
    case 'switch-target-visible':
    case 'hidden':
      return isTerminalSwitchTargetTask(candidate.taskId);
    case 'active-visible':
    case 'visible-background':
      return false;
  }
}

function clearScheduledDrain(): void {
  if (!scheduledDrain) {
    return;
  }

  if (scheduledDrain.kind === 'animation-frame') {
    cancelAnimationFrame(scheduledDrain.handle);
  } else {
    clearTimeout(scheduledDrain.handle);
  }

  scheduledDrain = null;
}

function sortTerminalOutputCandidates(
  left: TerminalOutputCandidate,
  right: TerminalOutputCandidate,
): number {
  const priorityDifference =
    getTerminalOutputPriorityOrder(left.getPriority()) -
    getTerminalOutputPriorityOrder(right.getPriority());
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return left.key.localeCompare(right.key);
}

function rotateTerminalOutputCandidates(
  candidates: readonly TerminalOutputCandidate[],
  priority: TerminalOutputPriority,
): TerminalOutputCandidate[] {
  const lastDrainedKey = lastDrainedKeyByPriority.get(priority);
  if (!lastDrainedKey) {
    return [...candidates];
  }

  const startIndex = candidates.findIndex((candidate) => candidate.key === lastDrainedKey);
  if (startIndex < 0 || startIndex === candidates.length - 1) {
    return [...candidates];
  }

  return [...candidates.slice(startIndex + 1), ...candidates.slice(0, startIndex + 1)];
}

function listPendingTerminalOutputCandidatesForPriority(
  priority: TerminalOutputPriority,
  predicate?: (candidate: TerminalOutputCandidate) => boolean,
): TerminalOutputCandidate[] {
  const startedAtMs = performance.now();
  const candidates: TerminalOutputCandidate[] = [];
  let scannedCandidates = 0;

  for (const candidate of terminalOutputCandidates.values()) {
    scannedCandidates += 1;
    if (
      candidate.getPendingBytes() > 0 &&
      candidate.getPriority() === priority &&
      (predicate?.(candidate) ?? true)
    ) {
      candidates.push(candidate);
    }
  }

  candidates.sort(sortTerminalOutputCandidates);
  const rotatedCandidates = rotateTerminalOutputCandidates(candidates, priority);
  recordTerminalOutputSchedulerScan(scannedCandidates, performance.now() - startedAtMs);
  return rotatedCandidates;
}

function minCandidateLimit(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  return Math.min(left, right);
}

function getAdaptiveVisibleThrottleSettings(priority: TerminalOutputPriority): {
  minimumVisibleCount: number;
  throttleMode: 'aggressive' | 'moderate' | 'off';
} | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();

  switch (priority) {
    case 'active-visible':
      return {
        minimumVisibleCount: experimentConfig.adaptiveActiveVisibleMinimumVisibleCount,
        throttleMode: experimentConfig.adaptiveActiveVisibleThrottleMode,
      };
    case 'visible-background':
      return {
        minimumVisibleCount: experimentConfig.adaptiveVisibleBackgroundMinimumVisibleCount,
        throttleMode: experimentConfig.adaptiveVisibleBackgroundThrottleMode,
      };
    case 'focused':
    case 'switch-target-visible':
    case 'hidden':
      return null;
  }
}

function getAdaptiveVisiblePressureThrottle(
  priority: TerminalOutputPriority,
  visibleTerminalCount: number,
): {
  candidateLimit: number | null;
  budgetScale: number;
} | null {
  const throttleSettings = getAdaptiveVisibleThrottleSettings(priority);
  if (throttleSettings === null || throttleSettings.throttleMode === 'off') {
    return null;
  }

  if (visibleTerminalCount < throttleSettings.minimumVisibleCount) {
    return null;
  }

  const pressureLevel = getTerminalFramePressureLevel();
  const throttleMode = throttleSettings.throttleMode;

  if (priority === 'active-visible') {
    if (throttleMode === 'moderate') {
      switch (pressureLevel) {
        case 'stable':
          return null;
        case 'elevated':
          return {
            budgetScale: 0.75,
            candidateLimit: 1,
          };
        case 'critical':
          return {
            budgetScale: 0.5,
            candidateLimit: 1,
          };
      }
    }

    switch (pressureLevel) {
      case 'stable':
        return null;
      case 'elevated':
        return {
          budgetScale: 0.5,
          candidateLimit: 1,
        };
      case 'critical':
        return {
          budgetScale: 0.25,
          candidateLimit: 1,
        };
    }
  }

  if (throttleMode === 'moderate') {
    switch (pressureLevel) {
      case 'stable':
        return null;
      case 'elevated':
        return {
          budgetScale: 0.5,
          candidateLimit: 1,
        };
      case 'critical':
        return {
          budgetScale: 0.25,
          candidateLimit: 1,
        };
    }
  }

  switch (pressureLevel) {
    case 'stable':
      return null;
    case 'elevated':
      return {
        budgetScale: 0.33,
        candidateLimit: 1,
      };
    case 'critical':
      return {
        budgetScale: 0.125,
        candidateLimit: 1,
      };
  }
}

function getPriorityThrottle(
  priority: TerminalOutputPriority,
  drainLane: TerminalOutputDrainLane,
): {
  candidateLimit: number | null;
  budgetScale: number;
} {
  const visibleTerminalCount = getVisibleTerminalCount();
  const pressureScale = getPriorityPressureDrainBudgetScale(priority, visibleTerminalCount);

  if (hasTerminalOutputSwitchWindow()) {
    if (isTerminalSwitchWindowAwaitingFirstPaint()) {
      switch (priority) {
        case 'active-visible':
          return {
            budgetScale: 0.25,
            candidateLimit: 1,
          };
        case 'visible-background':
          return {
            budgetScale: 0,
            candidateLimit: 0,
          };
        case 'focused':
        case 'switch-target-visible':
        case 'hidden':
          return {
            budgetScale: getScaledBudget(pressureScale),
            candidateLimit: null,
          };
      }
    }

    if (
      getTerminalPerformanceExperimentConfig().switchTargetProtectUntilInputReady === true &&
      isTerminalSwitchWindowAwaitingInputReady()
    ) {
      switch (priority) {
        case 'active-visible':
          return {
            budgetScale: 0.25,
            candidateLimit: 1,
          };
        case 'visible-background':
          return {
            budgetScale: 0,
            candidateLimit: 0,
          };
        case 'focused':
        case 'switch-target-visible':
        case 'hidden':
          return {
            budgetScale: getScaledBudget(pressureScale),
            candidateLimit: null,
          };
      }
    }

    if (isTerminalSwitchWindowSettling()) {
      switch (priority) {
        case 'active-visible':
          return {
            budgetScale: 0.5,
            candidateLimit: 1,
          };
        case 'visible-background':
          return {
            budgetScale: 0.25,
            candidateLimit: 1,
          };
        case 'focused':
        case 'switch-target-visible':
        case 'hidden':
          return {
            budgetScale: getScaledBudget(pressureScale),
            candidateLimit: null,
          };
      }
    }

    switch (priority) {
      case 'active-visible':
        return {
          budgetScale: 0.5,
          candidateLimit: 1,
        };
      case 'visible-background':
        return {
          budgetScale: 0.25,
          candidateLimit: 1,
        };
      case 'focused':
      case 'switch-target-visible':
      case 'hidden':
        return {
          budgetScale: getScaledBudget(pressureScale),
          candidateLimit: null,
        };
    }
  }

  if (isTerminalDenseFocusedInputProtectionActive(visibleTerminalCount)) {
    if (isTerminalFocusedInputEchoReservationActive()) {
      switch (priority) {
        case 'focused':
          return {
            budgetScale: Math.max(
              DENSE_FOCUSED_INPUT_ECHO_RESERVATION_FOCUSED_BUDGET_SCALE,
              getScaledBudget(pressureScale),
            ),
            candidateLimit: null,
          };
        case 'switch-target-visible':
          return {
            budgetScale: getScaledBudget(pressureScale),
            candidateLimit: 1,
          };
        case 'active-visible':
        case 'visible-background':
        case 'hidden':
          return {
            budgetScale: 0,
            candidateLimit: 0,
          };
      }
    }

    switch (priority) {
      case 'focused':
        return {
          budgetScale: Math.max(1.5, getScaledBudget(pressureScale)),
          candidateLimit: null,
        };
      case 'switch-target-visible':
        return {
          budgetScale: getScaledBudget(pressureScale),
          candidateLimit: 1,
        };
      case 'active-visible':
        return {
          budgetScale: DENSE_FOCUSED_INPUT_ACTIVE_VISIBLE_BUDGET_SCALE,
          candidateLimit: DENSE_FOCUSED_INPUT_NON_TARGET_VISIBLE_CANDIDATE_LIMIT,
        };
      case 'visible-background':
        return {
          budgetScale: DENSE_FOCUSED_INPUT_BACKGROUND_BUDGET_SCALE,
          candidateLimit: DENSE_FOCUSED_INPUT_NON_TARGET_VISIBLE_CANDIDATE_LIMIT,
        };
      case 'hidden':
        return {
          budgetScale: DENSE_FOCUSED_INPUT_HIDDEN_BUDGET_SCALE,
          candidateLimit: 1,
        };
    }
  }

  if (drainLane !== 'visible') {
    return {
      budgetScale: getScaledBudget(pressureScale),
      candidateLimit: null,
    };
  }

  const adaptiveThrottle = getAdaptiveVisiblePressureThrottle(priority, visibleTerminalCount);
  if (adaptiveThrottle !== null) {
    return {
      ...adaptiveThrottle,
      budgetScale: adaptiveThrottle.budgetScale * (pressureScale ?? 1),
    };
  }

  return {
    budgetScale: getScaledBudget(pressureScale),
    candidateLimit: null,
  };
}

function getPriorityPressureDrainBudgetScale(
  priority: TerminalOutputPriority,
  visibleTerminalCount: number,
): number | null {
  if (priority === 'hidden') {
    return null;
  }

  const pressureLevel = getTerminalFramePressureLevel();
  const visibleCountScale = getTerminalExperimentVisibleCountPressureDrainBudgetScale(
    priority,
    visibleTerminalCount,
    pressureLevel,
  );
  const denseOverloadScale = isTerminalDenseOverloadActive(visibleTerminalCount)
    ? getTerminalExperimentDenseOverloadPressureDrainBudgetScale(
        priority,
        visibleTerminalCount,
        pressureLevel,
      )
    : null;

  if (visibleCountScale === null) {
    return denseOverloadScale;
  }

  if (denseOverloadScale === null) {
    return visibleCountScale;
  }

  return visibleCountScale * denseOverloadScale;
}

function getScaledBudget(scale: number | null): number {
  return scale ?? 1;
}

function drainTerminalOutputPriorityBand(
  priority: TerminalOutputPriority,
  remainingFrameBudget: number,
  priorityFrameBudget: number,
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  sharedCandidateLimit: number | null,
): {
  drainedCandidateCount: number;
  madeProgress: boolean;
  remainingFrameBudget: number;
  shouldDrainAgain: boolean;
  drainedBytes: number;
} {
  const throttle = getPriorityThrottle(priority, drainLane);
  const candidateLimit = minCandidateLimit(
    getTerminalOutputDrainCandidateLimit(priority, visibleTerminalCount),
    minCandidateLimit(throttle.candidateLimit, sharedCandidateLimit),
  );
  let remainingPriorityBudget = Math.min(
    priorityFrameBudget,
    getTerminalOutputDrainBudget(priority, visibleTerminalCount),
  );
  remainingPriorityBudget = Math.max(0, Math.floor(remainingPriorityBudget * throttle.budgetScale));
  if (priority === 'visible-background' && remainingPriorityBudget > 0) {
    const maximumVisibleBackgroundBudget = Math.min(remainingFrameBudget, priorityFrameBudget);
    if (maximumVisibleBackgroundBudget >= MIN_VISIBLE_BACKGROUND_FRAME_BUDGET_BYTES) {
      remainingPriorityBudget = Math.max(
        MIN_VISIBLE_BACKGROUND_FRAME_BUDGET_BYTES,
        remainingPriorityBudget,
      );
    }
    remainingPriorityBudget = Math.min(maximumVisibleBackgroundBudget, remainingPriorityBudget);
  }
  if (remainingPriorityBudget <= 0 || candidateLimit === 0) {
    const hasPendingCandidatesForPriority = hasPendingTerminalOutputMatching(
      (candidate) =>
        candidate.getPriority() === priority &&
        canDrainTerminalOutputCandidate(candidate, priority),
    );
    return {
      drainedCandidateCount: 0,
      madeProgress: false,
      remainingFrameBudget,
      shouldDrainAgain: hasPendingCandidatesForPriority,
      drainedBytes: 0,
    };
  }

  let madeProgress = false;
  let shouldDrainAgain = false;
  let nextFrameBudget = remainingFrameBudget;
  let drainedBytes = 0;
  const pendingCandidates = listPendingTerminalOutputCandidatesForPriority(priority, (candidate) =>
    canDrainTerminalOutputCandidate(candidate, priority),
  );
  let drainedCandidateCount = 0;

  for (const candidate of pendingCandidates) {
    if (candidateLimit !== null && drainedCandidateCount >= candidateLimit) {
      shouldDrainAgain = true;
      break;
    }

    if (nextFrameBudget <= 0 || remainingPriorityBudget <= 0) {
      shouldDrainAgain = true;
      break;
    }

    const candidateBudget = Math.min(nextFrameBudget, remainingPriorityBudget);
    if (candidateBudget <= 0) {
      continue;
    }

    const drainedBytesThisCandidate = candidate.drain(candidateBudget);
    if (drainedBytesThisCandidate <= 0) {
      if (candidate.getPendingBytes() > 0) {
        shouldDrainAgain = true;
      }
      continue;
    }

    nextFrameBudget -= drainedBytesThisCandidate;
    remainingPriorityBudget -= drainedBytesThisCandidate;
    drainedBytes += drainedBytesThisCandidate;
    drainedCandidateCount += 1;
    madeProgress = true;
    lastDrainedKeyByPriority.set(priority, candidate.key);

    if (candidate.getPendingBytes() > 0) {
      shouldDrainAgain = true;
    }
  }

  if (pendingCandidates.some((candidate) => candidate.getPendingBytes() > 0)) {
    shouldDrainAgain = true;
  }

  return {
    drainedCandidateCount,
    madeProgress,
    remainingFrameBudget: nextFrameBudget,
    shouldDrainAgain,
    drainedBytes,
  };
}

function getSwitchWindowNonTargetVisibleCandidateLimit(
  drainLane: TerminalOutputDrainLane,
): number | null {
  if (
    drainLane !== 'visible' ||
    !hasTerminalOutputSwitchWindow() ||
    isTerminalSwitchWindowAwaitingFirstPaint()
  ) {
    return null;
  }

  return getTerminalPerformanceExperimentConfig().switchWindowNonTargetVisibleCandidateLimit;
}

function getSwitchTargetVisibleReserveBudget(
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  visibleLaneFrameBudget: number,
): number | null {
  if (
    drainLane !== 'visible' ||
    !hasTerminalOutputSwitchWindow() ||
    !hasSwitchTargetTerminalOutputPending()
  ) {
    return null;
  }

  const configuredReserve = getTerminalExperimentSwitchTargetReserveBytes(visibleTerminalCount);
  const denseOverloadReserve = isTerminalDenseOverloadActive(visibleTerminalCount)
    ? getTerminalExperimentDenseOverloadSwitchTargetReserveBytes(visibleTerminalCount)
    : null;
  const effectiveReserve = denseOverloadReserve ?? configuredReserve;
  if (effectiveReserve === null) {
    return null;
  }

  return Math.min(visibleLaneFrameBudget, effectiveReserve);
}

function getSharedNonTargetVisibleFrameBudget(
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  visibleLaneFrameBudget: number,
  switchTargetReserveBudget: number | null,
): number | null {
  if (drainLane !== 'visible') {
    return null;
  }

  const configuredSharedBudget =
    (isTerminalDenseOverloadActive(visibleTerminalCount)
      ? getTerminalExperimentDenseOverloadNonTargetVisibleFrameBudgetOverride(visibleTerminalCount)
      : null) ?? getTerminalExperimentNonTargetVisibleFrameBudgetOverride(visibleTerminalCount);
  const remainingVisibleLaneBudget =
    switchTargetReserveBudget === null
      ? visibleLaneFrameBudget
      : Math.max(0, visibleLaneFrameBudget - switchTargetReserveBudget);
  const baseSharedBudget =
    configuredSharedBudget === null
      ? remainingVisibleLaneBudget
      : Math.min(remainingVisibleLaneBudget, configuredSharedBudget);
  if (isTerminalDenseFocusedInputProtectionActive(visibleTerminalCount)) {
    if (isTerminalFocusedInputEchoReservationActive()) {
      return 0;
    }

    return Math.min(baseSharedBudget, DENSE_FOCUSED_INPUT_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES);
  }

  const pressureScale = getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(
    visibleTerminalCount,
    getTerminalFramePressureLevel(),
  );
  if (pressureScale === null) {
    return baseSharedBudget;
  }

  return Math.max(0, Math.floor(baseSharedBudget * pressureScale));
}

function getVisibleDrainBudgetContext(
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  visibleLaneFrameBudget: number,
): VisibleDrainBudgetContext | null {
  if (drainLane !== 'visible') {
    return null;
  }

  const switchTargetReserveBudget = getSwitchTargetVisibleReserveBudget(
    drainLane,
    visibleTerminalCount,
    visibleLaneFrameBudget,
  );
  return {
    remainingNonTargetVisibleCandidateLimit:
      getSwitchWindowNonTargetVisibleCandidateLimit(drainLane),
    remainingNonTargetVisibleFrameBudget: getSharedNonTargetVisibleFrameBudget(
      drainLane,
      visibleTerminalCount,
      visibleLaneFrameBudget,
      switchTargetReserveBudget,
    ),
    remainingSwitchTargetReserveBudget: switchTargetReserveBudget,
  };
}

function getPriorityFrameBudgetForDrainLane(
  priority: TerminalOutputPriority,
  remainingFrameBudget: number,
  visibleDrainBudgetContext: VisibleDrainBudgetContext | null,
): number {
  if (visibleDrainBudgetContext === null) {
    return remainingFrameBudget;
  }

  if (
    priority === 'switch-target-visible' &&
    visibleDrainBudgetContext.remainingSwitchTargetReserveBudget !== null
  ) {
    return Math.min(
      remainingFrameBudget,
      visibleDrainBudgetContext.remainingSwitchTargetReserveBudget,
    );
  }

  if (
    isNonTargetVisiblePriority(priority) &&
    visibleDrainBudgetContext.remainingNonTargetVisibleFrameBudget !== null
  ) {
    return Math.min(
      remainingFrameBudget,
      visibleDrainBudgetContext.remainingNonTargetVisibleFrameBudget,
    );
  }

  return remainingFrameBudget;
}

function hasPendingNonTargetVisibleTerminalOutput(): boolean {
  return hasPendingTerminalOutputMatching((candidate) =>
    isNonTargetVisiblePriority(candidate.getPriority()),
  );
}

function hasPendingTerminalOutputOutsidePriorityBands(
  priorityBands: ReadonlyArray<TerminalOutputPriority>,
): boolean {
  return hasPendingTerminalOutputMatching(
    (candidate) => !priorityBands.includes(candidate.getPriority()),
  );
}

function hasPendingTerminalOutput(): boolean {
  return hasPendingTerminalOutputMatching(() => true);
}

function hasDrainableTerminalOutputForPriority(
  priority: TerminalOutputPriority,
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  laneFrameBudget: number,
  visibleDrainBudgetContext: VisibleDrainBudgetContext | null,
): boolean {
  const throttle = getPriorityThrottle(priority, drainLane);
  const candidateLimit = minCandidateLimit(
    getTerminalOutputDrainCandidateLimit(priority, visibleTerminalCount),
    minCandidateLimit(
      throttle.candidateLimit,
      isNonTargetVisiblePriority(priority)
        ? (visibleDrainBudgetContext?.remainingNonTargetVisibleCandidateLimit ?? null)
        : null,
    ),
  );
  const priorityFrameBudget = getPriorityFrameBudgetForDrainLane(
    priority,
    laneFrameBudget,
    visibleDrainBudgetContext,
  );
  let remainingPriorityBudget = Math.min(
    priorityFrameBudget,
    getTerminalOutputDrainBudget(priority, visibleTerminalCount),
  );
  remainingPriorityBudget = Math.max(0, Math.floor(remainingPriorityBudget * throttle.budgetScale));
  if (priority === 'visible-background' && remainingPriorityBudget > 0) {
    const maximumVisibleBackgroundBudget = Math.min(laneFrameBudget, priorityFrameBudget);
    if (maximumVisibleBackgroundBudget >= MIN_VISIBLE_BACKGROUND_FRAME_BUDGET_BYTES) {
      remainingPriorityBudget = Math.max(
        MIN_VISIBLE_BACKGROUND_FRAME_BUDGET_BYTES,
        remainingPriorityBudget,
      );
    }
    remainingPriorityBudget = Math.min(maximumVisibleBackgroundBudget, remainingPriorityBudget);
  }

  if (remainingPriorityBudget <= 0 || candidateLimit === 0) {
    return false;
  }

  return hasPendingTerminalOutputMatching(
    (candidate) =>
      candidate.getPriority() === priority && canDrainTerminalOutputCandidate(candidate, priority),
  );
}

function hasDrainableTerminalOutputForLane(
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
): boolean {
  const laneFrameBudget = getTerminalOutputLaneFrameBudget(drainLane, visibleTerminalCount);
  const visibleDrainBudgetContext = getVisibleDrainBudgetContext(
    drainLane,
    visibleTerminalCount,
    laneFrameBudget,
  );

  for (const priority of getTerminalOutputPriorityBandsForLane(drainLane)) {
    if (
      hasDrainableTerminalOutputForPriority(
        priority,
        drainLane,
        visibleTerminalCount,
        laneFrameBudget,
        visibleDrainBudgetContext,
      )
    ) {
      return true;
    }
  }

  return false;
}

function hasDeferredSwitchWindowOutput(
  priorityBands: ReadonlyArray<TerminalOutputPriority>,
): boolean {
  if (!hasTerminalOutputSwitchWindow() || isTerminalSwitchWindowTargetRecoveryActive()) {
    return false;
  }

  if (
    priorityBands.length < TERMINAL_OUTPUT_PRIORITY_BANDS.length &&
    hasPendingTerminalOutputOutsidePriorityBands(priorityBands)
  ) {
    return true;
  }

  const shouldPollNonTargetVisibleOutput =
    isTerminalSwitchWindowAwaitingFirstPaint() ||
    (getTerminalPerformanceExperimentConfig().switchTargetProtectUntilInputReady === true &&
      isTerminalSwitchWindowAwaitingInputReady());
  if (!shouldPollNonTargetVisibleOutput) {
    return false;
  }

  return hasPendingTerminalOutputMatching((candidate) =>
    isNonTargetVisiblePriority(candidate.getPriority()),
  );
}

function scheduleTerminalOutputDrain(): void {
  const desiredLane = getDesiredTerminalOutputDrainLane();
  if (scheduledDrain) {
    const currentLaneOrder = getTerminalOutputDrainLaneOrder(scheduledDrain.lane);
    const desiredLaneOrder = getTerminalOutputDrainLaneOrder(desiredLane);
    if (currentLaneOrder <= desiredLaneOrder) {
      return;
    }

    clearScheduledDrain();
  }

  if (desiredLane === 'focused') {
    scheduledDrain = {
      handle: globalThis.setTimeout(() => {
        scheduledDrain = null;
        drainTerminalOutputQueue(getDesiredTerminalOutputDrainLane());
      }, FOCUSED_TERMINAL_DRAIN_DELAY_MS),
      kind: 'timeout',
      lane: 'focused',
    };
    return;
  }

  if (desiredLane === 'visible') {
    scheduledDrain = {
      handle: requestAnimationFrame(() => {
        scheduledDrain = null;
        drainTerminalOutputQueue(getDesiredTerminalOutputDrainLane());
      }),
      kind: 'animation-frame',
      lane: 'visible',
    };
    return;
  }

  scheduledDrain = {
    handle: globalThis.setTimeout(() => {
      scheduledDrain = null;
      drainTerminalOutputQueue(getDesiredTerminalOutputDrainLane());
    }, getHiddenTerminalDrainDelayMs()),
    kind: 'timeout',
    lane: 'hidden',
  };
}

function drainTerminalOutputQueue(drainLane: TerminalOutputDrainLane): void {
  const startedAtMs = performance.now();
  clearScheduledDrain();

  const visibleTerminalCount = getVisibleTerminalCount();
  const laneFrameBudget = getTerminalOutputLaneFrameBudget(drainLane, visibleTerminalCount);
  let remainingBudget = laneFrameBudget;
  let madeProgress = false;
  let shouldDrainAgain = false;
  let drainedBytes = 0;
  const priorityBands = getTerminalOutputPriorityBandsForLane(drainLane);
  const visibleDrainBudgetContext = getVisibleDrainBudgetContext(
    drainLane,
    visibleTerminalCount,
    laneFrameBudget,
  );

  for (const priority of priorityBands) {
    if (remainingBudget <= 0) {
      shouldDrainAgain = true;
      break;
    }

    const bandResult = drainTerminalOutputPriorityBand(
      priority,
      remainingBudget,
      getPriorityFrameBudgetForDrainLane(priority, remainingBudget, visibleDrainBudgetContext),
      drainLane,
      visibleTerminalCount,
      isNonTargetVisiblePriority(priority)
        ? (visibleDrainBudgetContext?.remainingNonTargetVisibleCandidateLimit ?? null)
        : null,
    );
    remainingBudget = bandResult.remainingFrameBudget;
    madeProgress ||= bandResult.madeProgress;
    shouldDrainAgain ||= bandResult.shouldDrainAgain;
    drainedBytes += bandResult.drainedBytes;
    if (
      visibleDrainBudgetContext !== null &&
      priority === 'switch-target-visible' &&
      visibleDrainBudgetContext.remainingSwitchTargetReserveBudget !== null
    ) {
      visibleDrainBudgetContext.remainingSwitchTargetReserveBudget = Math.max(
        0,
        visibleDrainBudgetContext.remainingSwitchTargetReserveBudget - bandResult.drainedBytes,
      );
    }
    if (
      visibleDrainBudgetContext !== null &&
      visibleDrainBudgetContext.remainingNonTargetVisibleFrameBudget !== null &&
      isNonTargetVisiblePriority(priority)
    ) {
      visibleDrainBudgetContext.remainingNonTargetVisibleFrameBudget = Math.max(
        0,
        visibleDrainBudgetContext.remainingNonTargetVisibleFrameBudget - bandResult.drainedBytes,
      );
      if (visibleDrainBudgetContext.remainingNonTargetVisibleFrameBudget === 0) {
        shouldDrainAgain ||= hasPendingNonTargetVisibleTerminalOutput();
      }
    }
    if (
      visibleDrainBudgetContext !== null &&
      visibleDrainBudgetContext.remainingNonTargetVisibleCandidateLimit !== null &&
      isNonTargetVisiblePriority(priority)
    ) {
      visibleDrainBudgetContext.remainingNonTargetVisibleCandidateLimit = Math.max(
        0,
        visibleDrainBudgetContext.remainingNonTargetVisibleCandidateLimit -
          bandResult.drainedCandidateCount,
      );
    }
  }

  const hasRemainingPendingOutput = hasPendingTerminalOutput();
  const hasRemainingDrainableOutput = hasDrainableTerminalOutputForLane(
    drainLane,
    visibleTerminalCount,
  );
  const hasDeferredPriorityOutput =
    priorityBands.length < TERMINAL_OUTPUT_PRIORITY_BANDS.length &&
    hasPendingTerminalOutputOutsidePriorityBands(priorityBands);
  const hasDeferredSwitchWindowPendingOutput = hasDeferredSwitchWindowOutput(priorityBands);
  const shouldReschedule =
    hasRemainingPendingOutput &&
    (hasRemainingDrainableOutput ||
      hasDeferredPriorityOutput ||
      hasDeferredSwitchWindowPendingOutput);
  recordTerminalOutputSchedulerDrain({
    drainedBytes,
    durationMs: performance.now() - startedAtMs,
    lane: drainLane,
    rescheduled: shouldReschedule,
  });

  if (shouldReschedule) {
    scheduleTerminalOutputDrain();
  }
}

export function registerTerminalOutputCandidate(
  key: string,
  getPriority: () => TerminalOutputPriority,
  getPendingBytes: () => number,
  drain: (maxBytes: number) => number,
): TerminalOutputRegistration;
export function registerTerminalOutputCandidate(
  key: string,
  taskId: string,
  getPriority: () => TerminalOutputPriority,
  getPendingBytes: () => number,
  drain: (maxBytes: number) => number,
): TerminalOutputRegistration;
export function registerTerminalOutputCandidate(
  key: string,
  taskIdOrGetPriority: string | (() => TerminalOutputPriority),
  getPriorityOrPendingBytes: (() => TerminalOutputPriority) | (() => number),
  getPendingBytesOrDrain: (() => number) | ((maxBytes: number) => number),
  drainMaybe?: (maxBytes: number) => number,
): TerminalOutputRegistration {
  let taskId = key;
  let getPriority: () => TerminalOutputPriority;
  let getPendingBytes: () => number;
  let drain: (maxBytes: number) => number;

  if (typeof taskIdOrGetPriority === 'string') {
    taskId = taskIdOrGetPriority;
    getPriority = getPriorityOrPendingBytes as () => TerminalOutputPriority;
    getPendingBytes = getPendingBytesOrDrain as () => number;
    drain = drainMaybe as (maxBytes: number) => number;
  } else {
    getPriority = taskIdOrGetPriority;
    getPendingBytes = getPriorityOrPendingBytes as () => number;
    drain = getPendingBytesOrDrain as (maxBytes: number) => number;
  }

  const candidate: TerminalOutputCandidate = {
    drain,
    getPendingBytes,
    getPriority,
    key,
    taskId,
  };
  terminalOutputCandidates.set(key, candidate);
  recordTerminalOutputSchedulerCandidateCount(terminalOutputCandidates.size);

  function requestDrain(): void {
    if (candidate.getPendingBytes() <= 0) {
      return;
    }

    scheduleTerminalOutputDrain();
  }

  function unregister(): void {
    terminalOutputCandidates.delete(key);
    recordTerminalOutputSchedulerCandidateCount(terminalOutputCandidates.size);
    if (!hasPendingTerminalOutput()) {
      clearScheduledDrain();
    }
  }

  function updatePriority(): void {
    requestDrain();
  }

  return {
    requestDrain,
    unregister,
    updatePriority,
  };
}

export function armFocusedTerminalOutputPreemption(): void {
  const focusedPreemptionWindowMs =
    getTerminalPerformanceExperimentConfig().focusedPreemptionWindowMs;
  if (focusedPreemptionWindowMs <= 0) {
    return;
  }

  focusedTerminalOutputPreemptionUntilAt = performance.now() + focusedPreemptionWindowMs;
}

export function requestTerminalOutputDrain(): void {
  if (!hasPendingTerminalOutput()) {
    return;
  }

  scheduleTerminalOutputDrain();
}

export function getTerminalOutputPacingSnapshot(): TerminalOutputPacingSnapshot {
  const visibleTerminalCount = getVisibleTerminalCount();
  const framePressureLevel = getTerminalFramePressureLevel();
  const focusedLaneFrameBudget = getTerminalOutputLaneFrameBudget('focused', visibleTerminalCount);
  const visibleLaneFrameBudget = getTerminalOutputLaneFrameBudget('visible', visibleTerminalCount);
  const hiddenLaneFrameBudget = getTerminalOutputLaneFrameBudget('hidden', visibleTerminalCount);
  const switchTargetReserveBudget = getSwitchTargetVisibleReserveBudget(
    'visible',
    visibleTerminalCount,
    visibleLaneFrameBudget,
  );

  return {
    denseFocusedInputProtectionActive:
      isTerminalDenseFocusedInputProtectionActive(visibleTerminalCount),
    focusedPreemptionWindowActive: hasFocusedTerminalOutputPreemptionWindow(),
    framePressureLevel,
    laneFrameBudgetBytes: {
      focused: focusedLaneFrameBudget,
      hidden: hiddenLaneFrameBudget,
      visible: visibleLaneFrameBudget,
    },
    sharedNonTargetVisibleFrameBudgetBytes: getSharedNonTargetVisibleFrameBudget(
      'visible',
      visibleTerminalCount,
      visibleLaneFrameBudget,
      switchTargetReserveBudget,
    ),
    switchTargetReserveBudgetBytes: switchTargetReserveBudget,
    switchWindowActive: hasTerminalOutputSwitchWindow(),
    visibleTerminalCount,
  };
}

export function resetTerminalOutputSchedulerForTests(): void {
  terminalOutputCandidates.clear();
  lastDrainedKeyByPriority.clear();
  clearScheduledDrain();
  focusedTerminalOutputPreemptionUntilAt = 0;
}
