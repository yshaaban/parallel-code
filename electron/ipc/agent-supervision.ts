import type {
  AgentSupervisionEvent,
  AgentSupervisionSnapshot,
  AgentSupervisionState,
  PauseReason,
  TaskAttentionReason,
} from '../../src/domain/server-state.js';
import {
  hasHydraPromptInTail,
  looksLikePromptLine,
  looksLikeQuestionInVisibleTail,
  normalizeForComparison,
  stripAnsi,
} from '../../src/lib/prompt-detection.js';

const DEFAULT_QUIET_AFTER_MS = 30_000;
const TAIL_LIMIT = 4_096;
const PREVIEW_LIMIT = 140;
const INTERACTIVE_CHOICE_PATTERN =
  /\bshift\+tab(?:\s+to\s+cycle)?\b|\btab(?:\s+to\s+cycle)?\b|\buse arrow keys\b|\bselect an option\b|\bbypass permissions?\b/i;

type TimerHandle = ReturnType<typeof setTimeout>;
type SupervisionListener = (event: AgentSupervisionEvent) => void;
let agentSupervisionStateVersion = 0;

function bumpAgentSupervisionStateVersion(): number {
  agentSupervisionStateVersion += 1;
  return agentSupervisionStateVersion;
}

interface AgentTracker {
  quietTimer: TimerHandle | null;
  rawTail: string;
  snapshot: AgentSupervisionSnapshot;
}

export interface CreateAgentSupervisionControllerOptions {
  clearTimer?: (timer: TimerHandle) => void;
  now?: () => number;
  quietAfterMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
}

export interface AgentSpawnMetadata {
  agentId: string;
  isShell: boolean;
  taskId: string;
}

interface AgentExitMetadata {
  exitCode: number | null;
  lastOutput: string[];
  signal: string | null | undefined;
}

export interface AgentSupervisionController {
  cleanup: () => void;
  getSnapshot: (agentId: string) => AgentSupervisionSnapshot | null;
  getSnapshots: () => AgentSupervisionSnapshot[];
  recordExit: (agentId: string, metadata: AgentExitMetadata) => void;
  recordOutput: (agentId: string, data: string) => void;
  recordPauseState: (agentId: string, reason: PauseReason | null) => void;
  recordSpawn: (metadata: AgentSpawnMetadata) => void;
  removeAgent: (agentId: string) => void;
  removeTask: (taskId: string) => void;
  subscribe: (listener: SupervisionListener) => () => void;
}

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, PREVIEW_LIMIT - 1)}…`;
}

function getRecentVisibleLines(text: string): string[] {
  return text
    .slice(-500)
    .split(/\r?\n/)
    .map((line) => normalizeForComparison(line))
    .filter((line) => line.length > 0);
}

function isMeaningfulPreviewLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (INTERACTIVE_CHOICE_PATTERN.test(trimmed)) {
    return true;
  }

  const visibleChars = Array.from(trimmed).filter((character) => !/\s/u.test(character)).length;
  if (visibleChars === 0) {
    return false;
  }

  const wordChars = (trimmed.match(/[A-Za-z0-9]/g) ?? []).length;
  if (wordChars === 0 && /^[^\p{L}\p{N}]+$/u.test(trimmed)) {
    return false;
  }

  return wordChars / visibleChars >= 0.25 || /[A-Za-z]{3,}/.test(trimmed);
}

function getMeaningfulPreviewLine(text: string): string {
  const lines = getRecentVisibleLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && isMeaningfulPreviewLine(line)) {
      return line;
    }
  }

  return '';
}

function getLastVisibleLine(text: string): string {
  const lines = getRecentVisibleLines(text);
  return lines[lines.length - 1] ?? '';
}

function getQuestionPreview(text: string): string {
  if (INTERACTIVE_CHOICE_PATTERN.test(text)) {
    return 'Select an option';
  }

  const lines = getRecentVisibleLines(text);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && /[?]$|\[Y\/n\]$|\[y\/N\]$|\(y(?:es)?\/n(?:o)?\)$/i.test(line)) {
      return truncatePreview(line);
    }
  }

  return truncatePreview(lines[lines.length - 1] ?? 'Waiting for input');
}

function getPromptPreview(rawTail: string): string {
  const strippedTail = stripAnsi(rawTail);
  const lastVisibleLine = getMeaningfulPreviewLine(strippedTail);
  if (lastVisibleLine) {
    return truncatePreview(lastVisibleLine);
  }

  if (hasHydraPromptInTail(rawTail)) {
    return 'hydra>';
  }

  return 'Ready for next input';
}

function getActivePreview(rawTail: string): string {
  const preview = getMeaningfulPreviewLine(stripAnsi(rawTail));
  return preview ? truncatePreview(preview) : '';
}

function getExitPreview(lastOutput: string[]): string {
  const joined = lastOutput
    .map((line) => normalizeForComparison(line))
    .filter((line) => line.length > 0);
  return truncatePreview(joined[joined.length - 1] ?? '');
}

function getAttentionReasonForState(state: AgentSupervisionState): TaskAttentionReason | null {
  switch (state) {
    case 'awaiting-input':
      return 'waiting-input';
    case 'idle-at-prompt':
      return 'ready-for-next-step';
    case 'quiet':
      return 'quiet-too-long';
    case 'paused':
      return 'paused';
    case 'flow-controlled':
      return 'flow-controlled';
    case 'restoring':
      return 'restoring';
    case 'exited-error':
      return 'failed';
    case 'active':
    case 'exited-clean':
      return null;
    default:
      return null;
  }
}

function getPausedSupervisionState(reason: PauseReason | null): AgentSupervisionState | null {
  switch (reason) {
    case 'manual':
      return 'paused';
    case 'flow-control':
      return 'flow-controlled';
    case 'restore':
      return 'restoring';
    case null:
      return null;
    default:
      return null;
  }
}

function shouldEmitSnapshotChange(
  current: AgentSupervisionSnapshot | undefined,
  next: AgentSupervisionSnapshot,
): boolean {
  if (!current) {
    return true;
  }

  if (
    current.state !== next.state ||
    current.attentionReason !== next.attentionReason ||
    current.taskId !== next.taskId ||
    current.isShell !== next.isShell
  ) {
    return true;
  }

  if (
    next.state === 'awaiting-input' ||
    next.state === 'idle-at-prompt' ||
    next.state === 'exited-clean' ||
    next.state === 'exited-error'
  ) {
    return current.preview !== next.preview;
  }

  return false;
}

function classifyOutputState(rawTail: string): {
  preview: string;
  state: 'active' | 'awaiting-input' | 'idle-at-prompt';
} {
  const strippedTail = stripAnsi(rawTail);
  const lastVisibleLine = getLastVisibleLine(strippedTail);

  if (looksLikeQuestionInVisibleTail(strippedTail)) {
    return {
      preview: getQuestionPreview(strippedTail),
      state: 'awaiting-input',
    };
  }

  if (looksLikePromptLine(lastVisibleLine) || hasHydraPromptInTail(rawTail)) {
    return {
      preview: getPromptPreview(rawTail),
      state: 'idle-at-prompt',
    };
  }

  return {
    preview: getActivePreview(rawTail),
    state: 'active',
  };
}

export function createAgentSupervisionController(
  options: CreateAgentSupervisionControllerOptions = {},
): AgentSupervisionController {
  const listeners = new Set<SupervisionListener>();
  const now = options.now ?? (() => Date.now());
  const quietAfterMs = options.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS;
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const trackers = new Map<string, AgentTracker>();

  function emit(event: AgentSupervisionEvent): void {
    bumpAgentSupervisionStateVersion();
    for (const listener of listeners) {
      listener(event);
    }
  }

  function clearQuietTimer(tracker: AgentTracker): void {
    if (!tracker.quietTimer) {
      return;
    }

    clearTimer(tracker.quietTimer);
    tracker.quietTimer = null;
  }

  function getTracker(agentId: string): AgentTracker | null {
    return trackers.get(agentId) ?? null;
  }

  function commitSnapshot(agentId: string, nextSnapshot: AgentSupervisionSnapshot): void {
    const tracker = getTracker(agentId);
    if (!tracker) {
      return;
    }

    const currentSnapshot = tracker.snapshot;
    tracker.snapshot = nextSnapshot;
    if (shouldEmitSnapshotChange(currentSnapshot, nextSnapshot)) {
      emit(nextSnapshot);
    }
  }

  function scheduleQuietTimer(agentId: string): void {
    const tracker = getTracker(agentId);
    if (!tracker) {
      return;
    }

    clearQuietTimer(tracker);
    tracker.quietTimer = setTimer(() => {
      const current = getTracker(agentId);
      if (!current) {
        return;
      }

      if (
        current.snapshot.state === 'paused' ||
        current.snapshot.state === 'flow-controlled' ||
        current.snapshot.state === 'restoring' ||
        current.snapshot.state === 'exited-clean' ||
        current.snapshot.state === 'exited-error'
      ) {
        return;
      }

      commitSnapshot(agentId, {
        ...current.snapshot,
        attentionReason: 'quiet-too-long',
        preview: current.snapshot.preview || 'No recent output',
        state: 'quiet',
        updatedAt: now(),
      });
    }, quietAfterMs);
  }

  function applySnapshot(agentId: string, nextSnapshot: AgentSupervisionSnapshot): void {
    const tracker = getTracker(agentId);
    if (!tracker) {
      return;
    }

    commitSnapshot(agentId, nextSnapshot);

    if (
      nextSnapshot.state === 'active' ||
      nextSnapshot.state === 'awaiting-input' ||
      nextSnapshot.state === 'idle-at-prompt' ||
      nextSnapshot.state === 'quiet'
    ) {
      scheduleQuietTimer(agentId);
      return;
    }

    clearQuietTimer(tracker);
  }

  function recordSpawn(metadata: AgentSpawnMetadata): void {
    const timestamp = now();
    const existing = getTracker(metadata.agentId);
    if (existing) {
      clearQuietTimer(existing);
    }

    trackers.set(metadata.agentId, {
      quietTimer: null,
      rawTail: '',
      snapshot: {
        agentId: metadata.agentId,
        attentionReason: null,
        isShell: metadata.isShell,
        lastOutputAt: timestamp,
        preview: '',
        state: 'active',
        taskId: metadata.taskId,
        updatedAt: timestamp,
      },
    });

    const tracker = getTracker(metadata.agentId);
    if (!tracker) {
      return;
    }

    applySnapshot(metadata.agentId, tracker.snapshot);
  }

  function recordOutput(agentId: string, data: string): void {
    const tracker = getTracker(agentId);
    if (!tracker || data.length === 0) {
      return;
    }

    tracker.rawTail = (tracker.rawTail + data).slice(-TAIL_LIMIT);
    const timestamp = now();
    const classification = classifyOutputState(tracker.rawTail);
    applySnapshot(agentId, {
      ...tracker.snapshot,
      attentionReason: getAttentionReasonForState(classification.state),
      lastOutputAt: timestamp,
      preview: classification.preview,
      state: classification.state,
      updatedAt: timestamp,
    });
  }

  function recordPauseState(agentId: string, reason: PauseReason | null): void {
    const tracker = getTracker(agentId);
    if (!tracker) {
      return;
    }

    const pausedState = getPausedSupervisionState(reason);
    if (pausedState) {
      applySnapshot(agentId, {
        ...tracker.snapshot,
        attentionReason: getAttentionReasonForState(pausedState),
        state: pausedState,
        updatedAt: now(),
      });
      return;
    }

    applySnapshot(agentId, {
      ...tracker.snapshot,
      attentionReason: null,
      preview: tracker.snapshot.preview,
      state: 'active',
      updatedAt: now(),
    });
  }

  function recordExit(agentId: string, metadata: AgentExitMetadata): void {
    const tracker = getTracker(agentId);
    if (!tracker) {
      return;
    }

    const exitedWithError = metadata.exitCode !== 0 || metadata.signal !== null;
    const state: AgentSupervisionState = exitedWithError ? 'exited-error' : 'exited-clean';
    applySnapshot(agentId, {
      ...tracker.snapshot,
      attentionReason: getAttentionReasonForState(state),
      preview: getExitPreview(metadata.lastOutput),
      state,
      updatedAt: now(),
    });
  }

  function removeAgent(agentId: string): void {
    const tracker = getTracker(agentId);
    if (!tracker) {
      return;
    }

    clearQuietTimer(tracker);
    trackers.delete(agentId);
    emit({
      agentId,
      removed: true,
      taskId: tracker.snapshot.taskId,
    });
  }

  function removeTask(taskId: string): void {
    for (const snapshot of getSnapshots()) {
      if (snapshot.taskId === taskId) {
        removeAgent(snapshot.agentId);
      }
    }
  }

  function getSnapshot(agentId: string): AgentSupervisionSnapshot | null {
    return getTracker(agentId)?.snapshot ?? null;
  }

  function getSnapshots(): AgentSupervisionSnapshot[] {
    return Array.from(trackers.values(), (tracker) => tracker.snapshot);
  }

  function subscribe(listener: SupervisionListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function cleanup(): void {
    for (const tracker of trackers.values()) {
      clearQuietTimer(tracker);
    }
    trackers.clear();
    listeners.clear();
  }

  return {
    cleanup,
    getSnapshot,
    getSnapshots,
    recordExit,
    recordOutput,
    recordPauseState,
    recordSpawn,
    removeAgent,
    removeTask,
    subscribe,
  };
}

const agentSupervisionController = createAgentSupervisionController();

export function subscribeAgentSupervision(listener: SupervisionListener): () => void {
  return agentSupervisionController.subscribe(listener);
}

export function getAgentSupervisionSnapshot(agentId: string): AgentSupervisionSnapshot | null {
  return agentSupervisionController.getSnapshot(agentId);
}

export function listAgentSupervisionSnapshots(): AgentSupervisionSnapshot[] {
  return agentSupervisionController.getSnapshots();
}

export function getAgentSupervisionStateVersion(): number {
  return agentSupervisionStateVersion;
}

export function recordAgentSpawn(metadata: AgentSpawnMetadata): void {
  agentSupervisionController.recordSpawn(metadata);
}

export function recordAgentOutput(agentId: string, data: string): void {
  agentSupervisionController.recordOutput(agentId, data);
}

export function recordAgentPauseState(agentId: string, reason: PauseReason | null): void {
  agentSupervisionController.recordPauseState(agentId, reason);
}

export function recordAgentExit(agentId: string, metadata: AgentExitMetadata): void {
  agentSupervisionController.recordExit(agentId, metadata);
}

export function removeAgentSupervision(agentId: string): void {
  agentSupervisionController.removeAgent(agentId);
}

export function removeTaskSupervision(taskId: string): void {
  agentSupervisionController.removeTask(taskId);
}
