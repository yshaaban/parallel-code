import {
  getTerminalOutputDrainBudget,
  getTerminalOutputPriorityOrder,
  type TerminalOutputPriority,
} from '../lib/terminal-output-priority';

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
}

export interface TerminalOutputRegistration {
  requestDrain: () => void;
  unregister: () => void;
  updatePriority: () => void;
}

type TerminalOutputDrainLane = 'focused' | 'visible' | 'hidden';

const terminalOutputCandidates = new Map<string, TerminalOutputCandidate>();
const lastDrainedKeyByPriority = new Map<TerminalOutputPriority, string>();
const FOCUSED_TERMINAL_DRAIN_DELAY_MS = 0;
const MAX_FRAME_DRAIN_BYTES = 160 * 1024;
const HIDDEN_TERMINAL_DRAIN_DELAY_MS = 48;
const TERMINAL_OUTPUT_PRIORITY_BANDS: readonly TerminalOutputPriority[] = [
  'focused',
  'active-visible',
  'visible-background',
  'hidden',
];

let scheduledDrain: ScheduledHandle | null = null;

function hasVisibleTerminalOutputPending(): boolean {
  for (const candidate of terminalOutputCandidates.values()) {
    if (candidate.getPendingBytes() <= 0) {
      continue;
    }

    if (candidate.getPriority() !== 'hidden') {
      return true;
    }
  }

  return false;
}

function hasFocusedTerminalOutputPending(): boolean {
  for (const candidate of terminalOutputCandidates.values()) {
    if (candidate.getPendingBytes() <= 0) {
      continue;
    }

    if (candidate.getPriority() === 'focused') {
      return true;
    }
  }

  return false;
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

  if (hasVisibleTerminalOutputPending()) {
    return 'visible';
  }

  return 'hidden';
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
): TerminalOutputCandidate[] {
  const candidates = [...terminalOutputCandidates.values()]
    .filter((candidate) => candidate.getPendingBytes() > 0 && candidate.getPriority() === priority)
    .sort(sortTerminalOutputCandidates);
  return rotateTerminalOutputCandidates(candidates, priority);
}

function drainTerminalOutputPriorityBand(
  priority: TerminalOutputPriority,
  remainingFrameBudget: number,
): {
  madeProgress: boolean;
  remainingFrameBudget: number;
  shouldDrainAgain: boolean;
} {
  let remainingPriorityBudget = Math.min(
    remainingFrameBudget,
    getTerminalOutputDrainBudget(priority),
  );
  if (remainingPriorityBudget <= 0) {
    return {
      madeProgress: false,
      remainingFrameBudget,
      shouldDrainAgain: false,
    };
  }

  let madeProgress = false;
  let shouldDrainAgain = false;
  let nextFrameBudget = remainingFrameBudget;
  const pendingCandidates = listPendingTerminalOutputCandidatesForPriority(priority);

  for (const candidate of pendingCandidates) {
    if (nextFrameBudget <= 0 || remainingPriorityBudget <= 0) {
      shouldDrainAgain = true;
      break;
    }

    const candidateBudget = Math.min(nextFrameBudget, remainingPriorityBudget);
    if (candidateBudget <= 0) {
      continue;
    }

    const drainedBytes = candidate.drain(candidateBudget);
    if (drainedBytes <= 0) {
      if (candidate.getPendingBytes() > 0) {
        shouldDrainAgain = true;
      }
      continue;
    }

    nextFrameBudget -= drainedBytes;
    remainingPriorityBudget -= drainedBytes;
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
    madeProgress,
    remainingFrameBudget: nextFrameBudget,
    shouldDrainAgain,
  };
}

function hasPendingTerminalOutput(): boolean {
  for (const candidate of terminalOutputCandidates.values()) {
    if (candidate.getPendingBytes() > 0) {
      return true;
    }
  }

  return false;
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
        drainTerminalOutputQueue();
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
        drainTerminalOutputQueue();
      }),
      kind: 'animation-frame',
      lane: 'visible',
    };
    return;
  }

  scheduledDrain = {
    handle: globalThis.setTimeout(() => {
      scheduledDrain = null;
      drainTerminalOutputQueue();
    }, HIDDEN_TERMINAL_DRAIN_DELAY_MS),
    kind: 'timeout',
    lane: 'hidden',
  };
}

function drainTerminalOutputQueue(): void {
  clearScheduledDrain();

  let remainingBudget = MAX_FRAME_DRAIN_BYTES;
  let madeProgress = false;
  let shouldDrainAgain = false;

  for (const priority of TERMINAL_OUTPUT_PRIORITY_BANDS) {
    if (remainingBudget <= 0) {
      shouldDrainAgain = true;
      break;
    }

    const bandResult = drainTerminalOutputPriorityBand(priority, remainingBudget);
    remainingBudget = bandResult.remainingFrameBudget;
    madeProgress ||= bandResult.madeProgress;
    shouldDrainAgain ||= bandResult.shouldDrainAgain;
  }

  if (
    (shouldDrainAgain || (!madeProgress && hasPendingTerminalOutput())) &&
    hasPendingTerminalOutput()
  ) {
    scheduleTerminalOutputDrain();
  }
}

export function registerTerminalOutputCandidate(
  key: string,
  getPriority: () => TerminalOutputPriority,
  getPendingBytes: () => number,
  drain: (maxBytes: number) => number,
): TerminalOutputRegistration {
  const candidate: TerminalOutputCandidate = {
    drain,
    getPendingBytes,
    getPriority,
    key,
  };
  terminalOutputCandidates.set(key, candidate);

  function requestDrain(): void {
    if (candidate.getPendingBytes() <= 0) {
      return;
    }

    scheduleTerminalOutputDrain();
  }

  function unregister(): void {
    terminalOutputCandidates.delete(key);
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

export function resetTerminalOutputSchedulerForTests(): void {
  terminalOutputCandidates.clear();
  lastDrainedKeyByPriority.clear();
  clearScheduledDrain();
}
