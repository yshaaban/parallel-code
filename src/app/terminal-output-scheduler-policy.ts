import { isTerminalDenseOverloadActive } from './terminal-dense-overload';
import {
  isTerminalDenseFocusedInputProtectionActive,
  isTerminalFocusedInputEchoReservationActive,
} from './terminal-focused-input';
import { getTerminalFramePressureLevel } from './terminal-frame-pressure';
import {
  isTerminalSwitchWindowActive,
  isTerminalSwitchWindowAwaitingFirstPaint,
  isTerminalSwitchWindowAwaitingInputReady,
  isTerminalSwitchWindowSettling,
} from './terminal-switch-window';
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
import {
  getTerminalOutputDrainBudget,
  getTerminalOutputDrainCandidateLimit,
  type TerminalOutputPriority,
} from '../lib/terminal-output-priority';

export type TerminalOutputDrainLane = 'focused' | 'visible' | 'hidden';

export interface VisibleDrainBudgetContext {
  remainingNonTargetVisibleCandidateLimit: number | null;
  remainingNonTargetVisibleFrameBudget: number | null;
  remainingSwitchTargetReserveBudget: number | null;
}

interface TerminalOutputThrottle {
  budgetScale: number;
  candidateLimit: number | null;
}

const DEFAULT_MAX_FRAME_DRAIN_BYTES = 160 * 1024;
const MIN_VISIBLE_BACKGROUND_FRAME_BUDGET_BYTES = 1_024;
const DENSE_FOCUSED_INPUT_ACTIVE_VISIBLE_BUDGET_SCALE = 0.125;
const DENSE_FOCUSED_INPUT_BACKGROUND_BUDGET_SCALE = 0.0625;
const DENSE_FOCUSED_INPUT_HIDDEN_BUDGET_SCALE = 0.0625;
const DENSE_FOCUSED_INPUT_ECHO_RESERVATION_FOCUSED_BUDGET_SCALE = 2;
const DENSE_FOCUSED_INPUT_NON_TARGET_VISIBLE_CANDIDATE_LIMIT = 1;
const DENSE_FOCUSED_INPUT_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES = 1_024;

function hasTerminalOutputSwitchWindow(): boolean {
  return isTerminalSwitchWindowActive();
}

function getScaledBudget(scale: number | null): number {
  return scale ?? 1;
}

export function isNonTargetVisiblePriority(priority: TerminalOutputPriority): boolean {
  return priority === 'active-visible' || priority === 'visible-background';
}

export function minCandidateLimit(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  return Math.min(left, right);
}

export function getTerminalOutputDrainLaneOrder(lane: TerminalOutputDrainLane): number {
  switch (lane) {
    case 'focused':
      return 0;
    case 'visible':
      return 1;
    case 'hidden':
      return 2;
  }
}

export function getTerminalOutputLaneFrameBudget(
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

export function getPriorityPressureDrainBudgetScale(
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
): TerminalOutputThrottle | null {
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

export function getPriorityThrottle(
  priority: TerminalOutputPriority,
  drainLane: TerminalOutputDrainLane,
): TerminalOutputThrottle {
  const visibleTerminalCount = getVisibleTerminalCount();
  const pressureScale = getPriorityPressureDrainBudgetScale(priority, visibleTerminalCount);

  if (hasTerminalOutputSwitchWindow()) {
    if (isTerminalSwitchWindowAwaitingFirstPaint()) {
      switch (priority) {
        case 'active-visible':
          return { budgetScale: 0.25, candidateLimit: 1 };
        case 'visible-background':
          return { budgetScale: 0, candidateLimit: 0 };
        case 'focused':
        case 'switch-target-visible':
        case 'hidden':
          return { budgetScale: getScaledBudget(pressureScale), candidateLimit: null };
      }
    }

    if (
      getTerminalPerformanceExperimentConfig().switchTargetProtectUntilInputReady === true &&
      isTerminalSwitchWindowAwaitingInputReady()
    ) {
      switch (priority) {
        case 'active-visible':
          return { budgetScale: 0.25, candidateLimit: 1 };
        case 'visible-background':
          return { budgetScale: 0, candidateLimit: 0 };
        case 'focused':
        case 'switch-target-visible':
        case 'hidden':
          return { budgetScale: getScaledBudget(pressureScale), candidateLimit: null };
      }
    }

    if (isTerminalSwitchWindowSettling()) {
      switch (priority) {
        case 'active-visible':
          return { budgetScale: 0.5, candidateLimit: 1 };
        case 'visible-background':
          return { budgetScale: 0.25, candidateLimit: 1 };
        case 'focused':
        case 'switch-target-visible':
        case 'hidden':
          return { budgetScale: getScaledBudget(pressureScale), candidateLimit: null };
      }
    }

    switch (priority) {
      case 'active-visible':
        return { budgetScale: 0.5, candidateLimit: 1 };
      case 'visible-background':
        return { budgetScale: 0.25, candidateLimit: 1 };
      case 'focused':
      case 'switch-target-visible':
      case 'hidden':
        return { budgetScale: getScaledBudget(pressureScale), candidateLimit: null };
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

export function getSwitchWindowNonTargetVisibleCandidateLimit(
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

export function getSwitchTargetVisibleReserveBudget(
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  visibleLaneFrameBudget: number,
  hasSwitchTargetPending: boolean,
): number | null {
  if (drainLane !== 'visible' || !hasTerminalOutputSwitchWindow() || !hasSwitchTargetPending) {
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

export function getSharedNonTargetVisibleFrameBudget(
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

export function getVisibleDrainBudgetContext(
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  visibleLaneFrameBudget: number,
  hasSwitchTargetPending: boolean,
): VisibleDrainBudgetContext | null {
  if (drainLane !== 'visible') {
    return null;
  }

  const switchTargetReserveBudget = getSwitchTargetVisibleReserveBudget(
    drainLane,
    visibleTerminalCount,
    visibleLaneFrameBudget,
    hasSwitchTargetPending,
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

export function getPriorityFrameBudgetForDrainLane(
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

export function getPriorityDrainPlan(
  priority: TerminalOutputPriority,
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  laneFrameBudget: number,
  visibleDrainBudgetContext: VisibleDrainBudgetContext | null,
): {
  candidateLimit: number | null;
  priorityFrameBudget: number;
  remainingPriorityBudget: number;
} {
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

  return {
    candidateLimit,
    priorityFrameBudget,
    remainingPriorityBudget,
  };
}
