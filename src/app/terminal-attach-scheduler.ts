import { isBrowserColdBootstrapPending } from './browser-startup';
import {
  clearTerminalStartupEntry,
  registerTerminalStartupCandidate,
  resetTerminalStartupStateForTests,
  setTerminalStartupPhase,
} from '../store/terminal-startup';

interface TerminalAttachCandidate {
  attach: () => void;
  attached: boolean;
  attachedReleased: boolean;
  getPriority: () => number;
  key: string;
  ownerId?: number;
  taskId: string;
}

const terminalAttachCandidates = new Map<string, TerminalAttachCandidate>();
const activeTerminalAttachKeys = new Set<string>();
const MAX_CONCURRENT_TERMINAL_ATTACHES = 2;
const MAX_CONCURRENT_FOREGROUND_ATTACHES = 1;
let terminalAttachDrainQueued = false;

function isForegroundTerminalAttachPriority(priority: number): boolean {
  return priority <= 1;
}

function sortTerminalAttachCandidates(
  left: TerminalAttachCandidate,
  right: TerminalAttachCandidate,
): number {
  const priorityDifference = left.getPriority() - right.getPriority();
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return left.key.localeCompare(right.key);
}

function listPendingTerminalAttachCandidates(): TerminalAttachCandidate[] {
  return [...terminalAttachCandidates.values()]
    .filter((candidate) => !candidate.attached && !candidate.attachedReleased)
    .sort(sortTerminalAttachCandidates);
}

function countActiveForegroundTerminalAttaches(): number {
  let foregroundCount = 0;

  for (const key of activeTerminalAttachKeys) {
    const candidate = terminalAttachCandidates.get(key);
    if (!candidate) {
      continue;
    }

    if (isForegroundTerminalAttachPriority(candidate.getPriority())) {
      foregroundCount += 1;
    }
  }

  return foregroundCount;
}

function canAttachTerminalCandidate(candidate: TerminalAttachCandidate): boolean {
  if (terminalAttachCandidates.get(candidate.key) !== candidate) {
    return false;
  }

  if (isForegroundTerminalAttachPriority(candidate.getPriority())) {
    return countActiveForegroundTerminalAttaches() < MAX_CONCURRENT_FOREGROUND_ATTACHES;
  }

  return activeTerminalAttachKeys.size < MAX_CONCURRENT_TERMINAL_ATTACHES;
}

function handleTerminalAttachError(candidate: TerminalAttachCandidate, error: unknown): void {
  candidate.attachedReleased = true;
  if (terminalAttachCandidates.get(candidate.key) === candidate) {
    terminalAttachCandidates.delete(candidate.key);
    activeTerminalAttachKeys.delete(candidate.key);
    clearTerminalStartupEntry(candidate.key, candidate.ownerId);
  }

  console.warn('Terminal attach failed before the terminal could bind.', error);
  queueTerminalAttachDrain();
}

// Slots are released when the attach RPC is DISPATCHED (onAttachDispatched),
// not when it resolves, so a slot only guards the renderer CPU phases of an
// attach (xterm open/session start), never backend round trips. The drain
// skips ineligible candidates instead of breaking so one pending foreground
// candidate can never collapse background attach concurrency.
function drainTerminalAttachQueue(): void {
  for (const candidate of listPendingTerminalAttachCandidates()) {
    if (!canAttachTerminalCandidate(candidate)) {
      continue;
    }

    if (
      isBrowserColdBootstrapPending() &&
      !isForegroundTerminalAttachPriority(candidate.getPriority())
    ) {
      continue;
    }

    if (terminalAttachCandidates.get(candidate.key) !== candidate) {
      continue;
    }

    setTerminalStartupPhase(candidate.key, 'binding', candidate.ownerId);
    candidate.attached = true;
    activeTerminalAttachKeys.add(candidate.key);
    try {
      candidate.attach();
    } catch (error) {
      handleTerminalAttachError(candidate, error);
    }
  }
}

function queueTerminalAttachDrain(): void {
  if (terminalAttachDrainQueued) {
    return;
  }

  terminalAttachDrainQueued = true;
  queueMicrotask(() => {
    terminalAttachDrainQueued = false;
    drainTerminalAttachQueue();
  });
}

export interface TerminalAttachRegistration {
  release: () => void;
  unregister: () => void;
  updatePriority: () => void;
}

export interface RegisterTerminalAttachCandidateOptions {
  attach: () => void;
  getPriority: () => number;
  key: string;
  ownerId?: number;
  taskId: string;
}

export function registerTerminalAttachCandidate(
  options: RegisterTerminalAttachCandidateOptions,
): TerminalAttachRegistration {
  const candidate: TerminalAttachCandidate = {
    attach: options.attach,
    attached: false,
    attachedReleased: false,
    getPriority: options.getPriority,
    key: options.key,
    taskId: options.taskId,
    ...(options.ownerId === undefined ? {} : { ownerId: options.ownerId }),
  };
  activeTerminalAttachKeys.delete(candidate.key);
  terminalAttachCandidates.set(candidate.key, candidate);
  registerTerminalStartupCandidate(candidate.key, candidate.taskId, candidate.ownerId);
  queueTerminalAttachDrain();

  function release(): void {
    if (candidate.attachedReleased) {
      return;
    }

    candidate.attachedReleased = true;
    if (terminalAttachCandidates.get(candidate.key) === candidate) {
      activeTerminalAttachKeys.delete(candidate.key);
      if (!candidate.attached) {
        terminalAttachCandidates.delete(candidate.key);
        clearTerminalStartupEntry(candidate.key, candidate.ownerId);
      }
    }
    queueTerminalAttachDrain();
  }

  function unregister(): void {
    if (terminalAttachCandidates.get(candidate.key) !== candidate) {
      return;
    }

    release();
    terminalAttachCandidates.delete(candidate.key);
    clearTerminalStartupEntry(candidate.key, candidate.ownerId);
  }

  function updatePriority(): void {
    if (terminalAttachCandidates.get(candidate.key) !== candidate) {
      return;
    }

    if (candidate.attached) {
      return;
    }

    queueTerminalAttachDrain();
  }

  return {
    release,
    unregister,
    updatePriority,
  };
}

export function resetTerminalAttachSchedulerForTests(): void {
  terminalAttachCandidates.clear();
  activeTerminalAttachKeys.clear();
  terminalAttachDrainQueued = false;
  resetTerminalStartupStateForTests();
}

export function notifyTerminalAttachPolicyChanged(): void {
  queueTerminalAttachDrain();
}
