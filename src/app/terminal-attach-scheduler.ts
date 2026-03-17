interface TerminalAttachCandidate {
  attach: () => void;
  attached: boolean;
  attachedReleased: boolean;
  getPriority: () => number;
  key: string;
}

const terminalAttachCandidates = new Map<string, TerminalAttachCandidate>();
const activeTerminalAttachKeys = new Set<string>();
const MAX_CONCURRENT_TERMINAL_ATTACHES = 2;

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

function canAttachMoreTerminals(): boolean {
  return activeTerminalAttachKeys.size < MAX_CONCURRENT_TERMINAL_ATTACHES;
}

function drainTerminalAttachQueue(): void {
  if (!canAttachMoreTerminals()) {
    return;
  }

  const pendingCandidates = listPendingTerminalAttachCandidates();
  for (const candidate of pendingCandidates) {
    if (!canAttachMoreTerminals()) {
      break;
    }

    candidate.attached = true;
    activeTerminalAttachKeys.add(candidate.key);
    candidate.attach();
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

export function registerTerminalAttachCandidate(
  key: string,
  getPriority: () => number,
  attach: () => void,
): TerminalAttachRegistration {
  const candidate: TerminalAttachCandidate = {
    attach,
    attached: false,
    attachedReleased: false,
    getPriority,
    key,
  };
  terminalAttachCandidates.set(key, candidate);
  queueTerminalAttachDrain();

  function release(): void {
    if (candidate.attachedReleased) {
      return;
    }

    candidate.attachedReleased = true;
    activeTerminalAttachKeys.delete(key);
    queueTerminalAttachDrain();
  }

  function unregister(): void {
    terminalAttachCandidates.delete(key);
    release();
  }

  function updatePriority(): void {
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
