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
    .filter((candidate) => !candidate.attached)
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

function drainTerminalAttachQueue(): void {
  const pendingCandidates = listPendingTerminalAttachCandidates();
  const highestPendingCandidate = pendingCandidates[0];
  const shouldSerializeForeground =
    highestPendingCandidate !== undefined &&
    isForegroundTerminalAttachPriority(highestPendingCandidate.getPriority());

  for (const candidate of pendingCandidates) {
    if (!canAttachTerminalCandidate(candidate)) {
      break;
    }

    if (
      isBrowserColdBootstrapPending() &&
      !isForegroundTerminalAttachPriority(candidate.getPriority())
    ) {
      break;
    }

    if (shouldSerializeForeground && !isForegroundTerminalAttachPriority(candidate.getPriority())) {
      break;
    }

    if (terminalAttachCandidates.get(candidate.key) !== candidate) {
      continue;
    }

    setTerminalStartupPhase(candidate.key, 'binding', candidate.ownerId);
    candidate.attached = true;
    activeTerminalAttachKeys.add(candidate.key);
    candidate.attach();

    if (shouldSerializeForeground) {
      break;
    }
  }
}

function queueTerminalAttachDrain(): void {
  queueMicrotask(drainTerminalAttachQueue);
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
  resetTerminalStartupStateForTests();
}

export function notifyTerminalAttachPolicyChanged(): void {
  queueTerminalAttachDrain();
}
