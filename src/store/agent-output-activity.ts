import {
  clearsQuestionState,
  hasTrustExclusionKeywords,
  looksLikePromptLine,
  looksLikeQuestionInVisibleTail,
  looksLikeTrustDialogInVisibleTail,
  stripAnsi,
} from '../lib/prompt-detection';
import { clearAgentReadyCallback, maybeFireAgentReadyCallback } from './agent-ready-callbacks';
import { isAgentAskingQuestion, setAgentQuestionState } from './agent-question-state';
import { createAutoTrustController } from './auto-trust';
import { setStore, store } from './core';

const lastIdleResetAt = new Map<string, number>();
const activeAgentIds = new Set<string>();

const IDLE_TIMEOUT_MS = 15_000;
const THROTTLE_MS = 1_000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

const TAIL_BUFFER_MAX = 4096;
const outputTailBuffers = new Map<string, string>();
const strippedTailBuffers = new Map<string, string>();
const latestOutputChunks = new Map<string, string>();
const agentDecoders = new Map<string, TextDecoder>();

const lastAnalysisAt = new Map<string, number>();
const pendingAnalysis = new Map<string, ReturnType<typeof setTimeout>>();
const ANALYSIS_INTERVAL_MS = 200;
const BACKGROUND_ANALYSIS_INTERVAL_MS = 2000;
const BACKGROUND_OUTPUT_SAMPLE_INTERVAL_MS = 250;
const lastBackgroundOutputSampleAt = new Map<string, number>();

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
  if (!pending) {
    return;
  }

  clearTimeout(pending);
  pendingAnalysis.delete(agentId);
}

function addToActive(agentId: string): void {
  if (activeAgentIds.has(agentId)) {
    return;
  }

  activeAgentIds.add(agentId);
  setStore('agentActive', agentId, true);
}

function removeFromActive(agentId: string): void {
  if (!activeAgentIds.delete(agentId)) {
    return;
  }

  setStore('agentActive', agentId, false);
}

function resetIdleTimer(agentId: string): void {
  lastIdleResetAt.set(agentId, Date.now());
  const existingTimer = idleTimers.get(agentId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

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

export function markAgentSpawned(agentId: string): void {
  clearAgentTailBuffer(agentId);
  latestOutputChunks.delete(agentId);
  autoTrust.clearState(agentId);
  lastAnalysisAt.delete(agentId);
  lastBackgroundOutputSampleAt.delete(agentId);
  clearPendingAnalysisTimer(agentId);
  addToActive(agentId);
  resetIdleTimer(agentId);
}

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

  setAgentQuestionState(agentId, hasQuestion);
  if (!hasQuestion && !autoTrust.hasScheduledSubmit(agentId)) {
    maybeFireAgentReadyCallback(agentId, strippedTail);
  }
}

export function markAgentOutput(agentId: string, data: Uint8Array, taskId?: string): void {
  const now = Date.now();
  const isActiveTask = !taskId || taskId === store.activeTaskId;
  const shouldRunBackgroundAnalysis = shouldRunBackgroundOutputAnalysis(agentId, now, isActiveTask);

  let decoder = agentDecoders.get(agentId);
  if (!decoder) {
    decoder = new TextDecoder();
    agentDecoders.set(agentId, decoder);
  }

  const text = decoder.decode(data, { stream: true });
  latestOutputChunks.set(agentId, text);
  const previousTail = outputTailBuffers.get(agentId) ?? '';
  const combinedTail = previousTail + text;
  setAgentTailBuffer(
    agentId,
    combinedTail.length > TAIL_BUFFER_MAX
      ? combinedTail.slice(combinedTail.length - TAIL_BUFFER_MAX)
      : combinedTail,
  );

  if (shouldRunBackgroundAnalysis) {
    autoTrust.maybeTryInBackground(agentId, now, isActiveTask);
  }
  scheduleAgentOutputAnalysis(agentId, now, isActiveTask);

  const visibleTail = combinedTail.slice(-200);
  let lastLine = '';
  let searchEnd = visibleTail.length;
  while (searchEnd > 0) {
    const newlineIndex = visibleTail.lastIndexOf('\n', searchEnd - 1);
    const candidateLine = visibleTail.slice(newlineIndex + 1, searchEnd).trim();
    if (candidateLine.length > 0) {
      lastLine = candidateLine;
      break;
    }
    searchEnd = newlineIndex >= 0 ? newlineIndex : 0;
  }

  if (looksLikePromptLine(lastLine)) {
    clearPendingAnalysisTimer(agentId);

    if (!looksLikeQuestionInVisibleTail(getStrippedTailBuffer(agentId))) {
      setAgentQuestionState(agentId, false);
    }
    maybeFireAgentReadyCallback(agentId, getStrippedTailBuffer(agentId));

    const timer = idleTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(agentId);
    }
    removeFromActive(agentId);
    return;
  }

  if (activeAgentIds.has(agentId)) {
    const lastReset = lastIdleResetAt.get(agentId) ?? 0;
    if (now - lastReset < THROTTLE_MS) {
      return;
    }

    resetIdleTimer(agentId);
    return;
  }

  addToActive(agentId);
  resetIdleTimer(agentId);
}

function shouldRunBackgroundOutputAnalysis(
  agentId: string,
  now: number,
  isActiveTask: boolean,
): boolean {
  if (isActiveTask) {
    return true;
  }

  const lastSampleAt = lastBackgroundOutputSampleAt.get(agentId) ?? 0;
  if (now - lastSampleAt < BACKGROUND_OUTPUT_SAMPLE_INTERVAL_MS) {
    return false;
  }

  lastBackgroundOutputSampleAt.set(agentId, now);
  return true;
}

function scheduleAgentOutputAnalysis(agentId: string, now: number, isActiveTask: boolean): void {
  const interval = isActiveTask ? ANALYSIS_INTERVAL_MS : BACKGROUND_ANALYSIS_INTERVAL_MS;
  const lastAnalysis = lastAnalysisAt.get(agentId) ?? 0;
  if (now - lastAnalysis >= interval) {
    lastAnalysisAt.set(agentId, now);
    clearPendingAnalysisTimer(agentId);
    analyzeAgentOutput(agentId);
    return;
  }

  if (pendingAnalysis.has(agentId)) {
    return;
  }

  pendingAnalysis.set(
    agentId,
    setTimeout(() => {
      pendingAnalysis.delete(agentId);
      lastAnalysisAt.set(agentId, Date.now());
      analyzeAgentOutput(agentId);
    }, interval),
  );
}

export function getAgentOutputTail(agentId: string): string {
  return outputTailBuffers.get(agentId) ?? '';
}

export function isAgentIdle(agentId: string): boolean {
  return !store.agentActive[agentId];
}

export function markAgentBusy(agentId: string): void {
  addToActive(agentId);
  resetIdleTimer(agentId);
}

export function clearAgentActivity(agentId: string): void {
  lastIdleResetAt.delete(agentId);
  lastBackgroundOutputSampleAt.delete(agentId);
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
  setAgentQuestionState(agentId, false);
}

export function resetAgentOutputActivityRuntimeState(): void {
  for (const agentId of Array.from(lastIdleResetAt.keys())) {
    clearAgentActivity(agentId);
  }

  outputTailBuffers.clear();
  strippedTailBuffers.clear();
  latestOutputChunks.clear();
  agentDecoders.clear();
  lastAnalysisAt.clear();
  lastBackgroundOutputSampleAt.clear();

  for (const timeout of pendingAnalysis.values()) {
    clearTimeout(timeout);
  }
  pendingAnalysis.clear();

  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();
}

export function resetAgentOutputActivityStateForTests(): void {
  resetAgentOutputActivityRuntimeState();
}
