import { createSignal } from 'solid-js';
import type { WorktreeStatus } from '../ipc/types';
import {
  chunkContainsAgentPrompt,
  clearsQuestionState,
  hasHydraPromptInTail,
  hasReadyPromptInTail,
  hasTrustExclusionKeywords,
  isTrustQuestionAutoHandled as isTrustQuestionAutoHandledWithSetting,
  looksLikePromptLine,
  looksLikeQuestion,
  looksLikeQuestionInVisibleTail,
  looksLikeTrustDialogInVisibleTail,
  normalizeForComparison,
  stripAnsi,
} from '../lib/prompt-detection';
import { createAutoTrustController } from './auto-trust';
import { store, setStore } from './core';
import { createGitStatusPollingController } from './git-status-polling';

export type TaskDotStatus =
  | 'busy'
  | 'waiting'
  | 'ready'
  | 'paused'
  | 'flow-controlled'
  | 'restoring';
export {
  hasHydraPromptInTail,
  hasReadyPromptInTail,
  looksLikeQuestion,
  normalizeForComparison,
  stripAnsi,
};

// --- Agent ready event callbacks ---
// Fired from markAgentOutput when a main prompt is detected in a PTY chunk.
const agentReadyCallbacks = new Map<string, () => void>();

/** Register a callback that fires once when the agent's main prompt is detected. */
export function onAgentReady(agentId: string, callback: () => void): void {
  agentReadyCallbacks.set(agentId, callback);
}

/** Remove a pending agent-ready callback. */
export function offAgentReady(agentId: string): void {
  agentReadyCallbacks.delete(agentId);
}

function clearAgentReadyCallback(agentId: string): void {
  agentReadyCallbacks.delete(agentId);
}

/** Fire the one-shot agentReady callback if the tail buffer shows a known agent prompt. */
function tryFireAgentReadyCallback(agentId: string): void {
  if (!agentReadyCallbacks.has(agentId)) return;
  const tailStripped = (strippedTailBuffers.get(agentId) ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (chunkContainsAgentPrompt(tailStripped)) {
    const cb = agentReadyCallbacks.get(agentId);
    agentReadyCallbacks.delete(agentId);
    if (cb) cb();
  }
}

export function isTrustQuestionAutoHandled(tail: string): boolean {
  return isTrustQuestionAutoHandledWithSetting(tail, store.autoTrustFolders);
}

// --- Agent question tracking ---
// Reactive set of agent IDs that currently have a question/dialog in their terminal.
const [questionAgents, setQuestionAgents] = createSignal<Set<string>>(new Set());

/** True when the agent's terminal is showing a question or confirmation dialog. */
export function isAgentAskingQuestion(agentId: string): boolean {
  return questionAgents().has(agentId);
}

function updateQuestionState(agentId: string, hasQuestion: boolean): void {
  setQuestionAgents((prev) => {
    if (hasQuestion === prev.has(agentId)) return prev;
    const next = new Set(prev);
    if (hasQuestion) next.add(agentId);
    else next.delete(agentId);
    return next;
  });
}

// --- Agent activity tracking ---
// Last time we refreshed each agent's idle timeout.
const lastIdleResetAt = new Map<string, number>();
// Internal activity set for non-reactive logic. The UI reads store.agentActive
// per agent for fine-grained reactivity.
const activeAgentIds = new Set<string>();

// How long after the last data event before transitioning back to idle.
// AI agents routinely go silent for 10-30s during normal work (thinking,
// API calls, tool use), so this needs to be long enough to cover those pauses.
const IDLE_TIMEOUT_MS = 15_000;
// Throttle reactive updates while already active.
const THROTTLE_MS = 1_000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Tail buffer per agent — keeps the last N chars of PTY output for prompt matching.
// Must be large enough to hold a full TUI dialog render (with ANSI codes) so that
// question text at the top of the dialog isn't truncated away.
const TAIL_BUFFER_MAX = 4096;
const outputTailBuffers = new Map<string, string>();
const strippedTailBuffers = new Map<string, string>();
const latestOutputChunks = new Map<string, string>();
// Per-agent UTF-8 decoders to correctly handle multi-byte characters split across chunks.
const agentDecoders = new Map<string, TextDecoder>();

// Per-agent timestamp of last expensive analysis (question/prompt detection).
const lastAnalysisAt = new Map<string, number>();
const pendingAnalysis = new Map<string, ReturnType<typeof setTimeout>>();
const ANALYSIS_INTERVAL_MS = 200;
const BACKGROUND_ANALYSIS_INTERVAL_MS = 2000;

function setAgentTailBuffer(agentId: string, rawTail: string): void {
  outputTailBuffers.set(agentId, rawTail);
  strippedTailBuffers.set(agentId, stripAnsi(rawTail));
}

function clearAgentTailBuffer(agentId: string): void {
  outputTailBuffers.delete(agentId);
  strippedTailBuffers.delete(agentId);
}

function getStrippedTailBuffer(agentId: string): string {
  return strippedTailBuffers.get(agentId) ?? '';
}

function clearPendingAnalysisTimer(agentId: string): void {
  const pending = pendingAnalysis.get(agentId);
  if (!pending) return;

  clearTimeout(pending);
  pendingAnalysis.delete(agentId);
}

function addToActive(agentId: string): void {
  if (activeAgentIds.has(agentId)) return;
  activeAgentIds.add(agentId);
  setStore('agentActive', agentId, true);
}

function removeFromActive(agentId: string): void {
  if (!activeAgentIds.delete(agentId)) return;
  setStore('agentActive', agentId, false);
}

function resetIdleTimer(agentId: string): void {
  lastIdleResetAt.set(agentId, Date.now());
  const existing = idleTimers.get(agentId);
  if (existing) clearTimeout(existing);
  idleTimers.set(
    agentId,
    setTimeout(() => {
      removeFromActive(agentId);
      idleTimers.delete(agentId);
    }, IDLE_TIMEOUT_MS),
  );
}

const autoTrust = createAutoTrustController({
  clearAgentReadyCallback,
  getVisibleTail: getStrippedTailBuffer,
  replaceTail: setAgentTailBuffer,
});

export function isAutoTrustSettling(agentId: string): boolean {
  return autoTrust.isSettling(agentId);
}

/** Mark an agent as active when it is first spawned.
 *  Ensures agents start as "busy" before any PTY data arrives. */
export function markAgentSpawned(agentId: string): void {
  clearAgentTailBuffer(agentId);
  latestOutputChunks.delete(agentId);
  autoTrust.clearState(agentId);
  lastAnalysisAt.delete(agentId);
  clearPendingAnalysisTimer(agentId);
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Run expensive prompt/question/agent-ready detection on the tail buffer.
 *  Called at most every ANALYSIS_INTERVAL_MS (200ms) per agent. */
function analyzeAgentOutput(agentId: string): void {
  const latestChunk = latestOutputChunks.get(agentId) ?? '';
  if (
    isAgentAskingQuestion(agentId) &&
    latestChunk.length > 0 &&
    clearsQuestionState(latestChunk)
  ) {
    setAgentTailBuffer(
      agentId,
      latestChunk.length > TAIL_BUFFER_MAX ? latestChunk.slice(-TAIL_BUFFER_MAX) : latestChunk,
    );
  }

  const strippedTail = getStrippedTailBuffer(agentId);
  let hasQuestion = looksLikeQuestionInVisibleTail(strippedTail);

  if (hasQuestion && store.autoTrustFolders) {
    if (
      looksLikeTrustDialogInVisibleTail(strippedTail) &&
      !hasTrustExclusionKeywords(strippedTail)
    ) {
      autoTrust.tryAutoTrust(agentId);
      hasQuestion = false;
    }
  }

  updateQuestionState(agentId, hasQuestion);
  if (!hasQuestion && !autoTrust.hasScheduledSubmit(agentId)) {
    tryFireAgentReadyCallback(agentId);
  }
}

/** Call this from the TerminalView Data handler with the raw PTY bytes.
 *  Detects prompt patterns to immediately mark agents idle instead of
 *  waiting for the full idle timeout. */
export function markAgentOutput(agentId: string, data: Uint8Array, taskId?: string): void {
  const now = Date.now();

  let decoder = agentDecoders.get(agentId);
  if (!decoder) {
    decoder = new TextDecoder();
    agentDecoders.set(agentId, decoder);
  }
  const text = decoder.decode(data, { stream: true });
  latestOutputChunks.set(agentId, text);
  const prev = outputTailBuffers.get(agentId) ?? '';
  const combined = prev + text;
  setAgentTailBuffer(
    agentId,
    combined.length > TAIL_BUFFER_MAX
      ? combined.slice(combined.length - TAIL_BUFFER_MAX)
      : combined,
  );

  // Expensive analysis runs frequently for the active task and at a slower
  // cadence for background tasks.
  const isActiveTask = !taskId || taskId === store.activeTaskId;

  autoTrust.maybeTryInBackground(agentId, now, isActiveTask);
  {
    const interval = isActiveTask ? ANALYSIS_INTERVAL_MS : BACKGROUND_ANALYSIS_INTERVAL_MS;
    const lastAnalysis = lastAnalysisAt.get(agentId) ?? 0;
    if (now - lastAnalysis >= interval) {
      lastAnalysisAt.set(agentId, now);
      clearPendingAnalysisTimer(agentId);
      analyzeAgentOutput(agentId);
    } else if (!pendingAnalysis.has(agentId)) {
      pendingAnalysis.set(
        agentId,
        setTimeout(() => {
          pendingAnalysis.delete(agentId);
          lastAnalysisAt.set(agentId, Date.now());
          analyzeAgentOutput(agentId);
        }, interval),
      );
    }
  }

  const tail = combined.slice(-200);
  let lastLine = '';
  let searchEnd = tail.length;
  while (searchEnd > 0) {
    const nlIdx = tail.lastIndexOf('\n', searchEnd - 1);
    const candidate = tail.slice(nlIdx + 1, searchEnd).trim();
    if (candidate.length > 0) {
      lastLine = candidate;
      break;
    }
    searchEnd = nlIdx >= 0 ? nlIdx : 0;
  }

  const promptDetected = looksLikePromptLine(lastLine);

  if (promptDetected) {
    clearPendingAnalysisTimer(agentId);

    if (!looksLikeQuestionInVisibleTail(getStrippedTailBuffer(agentId))) {
      updateQuestionState(agentId, false);
    }
    tryFireAgentReadyCallback(agentId);

    const timer = idleTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(agentId);
    }
    removeFromActive(agentId);
    return;
  }

  // Non-prompt output — agent is producing real work.
  if (activeAgentIds.has(agentId)) {
    const lastReset = lastIdleResetAt.get(agentId) ?? 0;
    if (now - lastReset < THROTTLE_MS) return;
    resetIdleTimer(agentId);
    return;
  }

  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Return the last ~4096 chars of raw PTY output for `agentId`. */
export function getAgentOutputTail(agentId: string): string {
  return outputTailBuffers.get(agentId) ?? '';
}

/** True when the agent is NOT producing output (e.g. sitting at a prompt). */
export function isAgentIdle(agentId: string): boolean {
  return !store.agentActive[agentId];
}

/** Lightweight busy marker — adds to active set + resets idle timer.
 *  Unlike markAgentSpawned this preserves the output tail buffer. */
export function markAgentBusy(agentId: string): void {
  addToActive(agentId);
  resetIdleTimer(agentId);
}

/** Clean up timers when an agent exits. */
export function clearAgentActivity(agentId: string): void {
  lastIdleResetAt.delete(agentId);
  clearAgentTailBuffer(agentId);
  latestOutputChunks.delete(agentId);
  agentDecoders.delete(agentId);
  clearAgentReadyCallback(agentId);
  autoTrust.clearState(agentId);
  lastAnalysisAt.delete(agentId);
  clearPendingAnalysisTimer(agentId);
  const timer = idleTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(agentId);
  }
  removeFromActive(agentId);
  updateQuestionState(agentId, false);
}

// --- Derived status ---

export function getTaskDotStatus(taskId: string): TaskDotStatus {
  const task = store.tasks[taskId];
  if (!task) return 'waiting';
  const primaryAgent = task.agentIds[0] ? store.agents[task.agentIds[0]] : undefined;
  if (primaryAgent?.status === 'paused') return 'paused';
  if (primaryAgent?.status === 'flow-controlled') return 'flow-controlled';
  if (primaryAgent?.status === 'restoring') return 'restoring';
  const hasActive = task.agentIds.some((id) => {
    const a = store.agents[id];
    return a?.status === 'running' && !!store.agentActive[id];
  });
  if (hasActive) return 'busy';

  const git = store.taskGitStatus[taskId];
  if (git?.has_committed_changes && !git?.has_uncommitted_changes) return 'ready';
  return 'waiting';
}

const gitStatusPolling = createGitStatusPollingController({
  isAgentActive(agentId: string): boolean {
    return activeAgentIds.has(agentId);
  },
});

const USES_SERVER_AUTHORITATIVE_GIT_STATUS = true;

export function getRecentTaskGitStatusPollAge(worktreePath: string): number | null {
  return gitStatusPolling.getRecentTaskGitStatusPollAge(worktreePath);
}

export function refreshAllTaskGitStatus(): Promise<void> {
  return gitStatusPolling.refreshAllTaskGitStatus();
}

export function refreshTaskStatus(taskId: string): void {
  gitStatusPolling.refreshTaskStatus(taskId);
}

export function applyGitStatusFromPush(worktreePath: string, status: WorktreeStatus): void {
  gitStatusPolling.applyGitStatusFromPush(worktreePath, status);
}

export function startTaskStatusPolling(): void {
  if (USES_SERVER_AUTHORITATIVE_GIT_STATUS) {
    return;
  }

  gitStatusPolling.startTaskStatusPolling();
}

export function rescheduleTaskStatusPolling(): void {
  if (USES_SERVER_AUTHORITATIVE_GIT_STATUS) {
    return;
  }

  gitStatusPolling.rescheduleTaskStatusPolling();
}

export function stopTaskStatusPolling(): void {
  gitStatusPolling.stopTaskStatusPolling();
}
