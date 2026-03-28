import {
  recordTerminalOutputSchedulerCandidateCount,
  recordTerminalOutputSchedulerDrain,
  recordTerminalOutputSchedulerScan,
} from './runtime-diagnostics';
import {
  getPriorityDrainPlan,
  getPriorityFrameBudgetForDrainLane,
  getSwitchTargetVisibleReserveBudget,
  getTerminalOutputDrainLaneOrder,
  getTerminalOutputLaneFrameBudget,
  getVisibleDrainBudgetContext,
  isNonTargetVisiblePriority,
  type TerminalOutputDrainLane,
  type VisibleDrainBudgetContext,
} from './terminal-output-scheduler-policy';
import {
  isTerminalSwitchWindowActive,
  isTerminalSwitchWindowAwaitingFirstPaint,
  isTerminalSwitchWindowAwaitingInputReady,
  isTerminalSwitchWindowTargetRecoveryActive,
  isTerminalSwitchTargetTask,
} from './terminal-switch-window';
import { isTerminalDenseFocusedInputProtectionActive } from './terminal-focused-input';
import {
  getTerminalOutputPriorityOrder,
  type TerminalOutputPriority,
} from '../lib/terminal-output-priority';
import { getVisibleTerminalCount } from './terminal-visible-set';
import { getTerminalPerformanceExperimentConfig } from '../lib/terminal-performance-experiments';
import {
  getTerminalFramePressureLevel,
  type TerminalFramePressureLevel,
} from './terminal-frame-pressure';

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

const terminalOutputCandidates = new Map<string, TerminalOutputCandidate>();
const lastDrainedKeyByPriority = new Map<TerminalOutputPriority, string>();
const FOCUSED_TERMINAL_DRAIN_DELAY_MS = 0;
const HIDDEN_TERMINAL_DRAIN_DELAY_MS = 48;
const TERMINAL_OUTPUT_PRIORITY_BANDS: readonly TerminalOutputPriority[] = [
  'focused',
  'switch-target-visible',
  'active-visible',
  'visible-background',
  'hidden',
];

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

function matchesTerminalOutputCandidate(
  candidate: TerminalOutputCandidate,
  priority: TerminalOutputPriority,
  predicate?: (candidate: TerminalOutputCandidate) => boolean,
): boolean {
  if (candidate.getPendingBytes() <= 0 || candidate.getPriority() !== priority) {
    return false;
  }

  return predicate?.(candidate) ?? true;
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
    if (matchesTerminalOutputCandidate(candidate, priority, predicate)) {
      candidates.push(candidate);
    }
  }

  candidates.sort(sortTerminalOutputCandidates);
  const rotatedCandidates = rotateTerminalOutputCandidates(candidates, priority);
  recordTerminalOutputSchedulerScan(scannedCandidates, performance.now() - startedAtMs);
  return rotatedCandidates;
}

function getNonTargetVisibleCandidateLimit(
  priority: TerminalOutputPriority,
  visibleDrainBudgetContext: VisibleDrainBudgetContext | null,
): number | null {
  if (!isNonTargetVisiblePriority(priority)) {
    return null;
  }

  return visibleDrainBudgetContext?.remainingNonTargetVisibleCandidateLimit ?? null;
}

function drainTerminalOutputPriorityBand(
  priority: TerminalOutputPriority,
  remainingFrameBudget: number,
  priorityFrameBudget: number,
  drainLane: TerminalOutputDrainLane,
  visibleTerminalCount: number,
  visibleDrainBudgetContext: VisibleDrainBudgetContext | null,
  sharedCandidateLimit: number | null,
): {
  drainedCandidateCount: number;
  madeProgress: boolean;
  remainingFrameBudget: number;
  shouldDrainAgain: boolean;
  drainedBytes: number;
} {
  const drainPlan = getPriorityDrainPlan(
    priority,
    drainLane,
    visibleTerminalCount,
    priorityFrameBudget,
    sharedCandidateLimit === null && !isNonTargetVisiblePriority(priority)
      ? visibleDrainBudgetContext
      : {
          remainingNonTargetVisibleCandidateLimit: sharedCandidateLimit,
          remainingNonTargetVisibleFrameBudget:
            visibleDrainBudgetContext?.remainingNonTargetVisibleFrameBudget ?? null,
          remainingSwitchTargetReserveBudget:
            visibleDrainBudgetContext?.remainingSwitchTargetReserveBudget ?? null,
        },
  );
  const candidateLimit = drainPlan.candidateLimit;
  let remainingPriorityBudget = Math.min(remainingFrameBudget, drainPlan.remainingPriorityBudget);
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
  const drainPlan = getPriorityDrainPlan(
    priority,
    drainLane,
    visibleTerminalCount,
    laneFrameBudget,
    visibleDrainBudgetContext,
  );
  if (drainPlan.remainingPriorityBudget <= 0 || drainPlan.candidateLimit === 0) {
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
    hasSwitchTargetTerminalOutputPending(),
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
    hasSwitchTargetTerminalOutputPending(),
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
      visibleDrainBudgetContext,
      getNonTargetVisibleCandidateLimit(priority, visibleDrainBudgetContext),
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
    hasSwitchTargetTerminalOutputPending(),
  );
  const visibleDrainBudgetContext = getVisibleDrainBudgetContext(
    'visible',
    visibleTerminalCount,
    visibleLaneFrameBudget,
    hasSwitchTargetTerminalOutputPending(),
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
    sharedNonTargetVisibleFrameBudgetBytes:
      visibleDrainBudgetContext?.remainingNonTargetVisibleFrameBudget ?? null,
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
