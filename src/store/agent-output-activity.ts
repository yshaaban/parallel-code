import {
  clearsQuestionState,
  getVisibleTerminalTextForDetection,
  hasPromptAdjacentInteractiveChoiceInVisibleTail,
  hasTrustExclusionKeywords,
  looksLikePromptLine,
  looksLikeQuestionInVisibleTail,
  looksLikeTrustDialogInVisibleTail,
} from '../lib/prompt-detection';
import {
  recordAgentOutputAnalysis,
  recordAgentOutputAnalysisBackgroundCheck,
  recordAgentOutputAnalysisRuntime,
  recordAgentOutputAnalysisSchedule,
} from '../app/runtime-diagnostics';
import {
  clearTerminalFocusedInputAgent,
  isTerminalFocusedInputPromptSuppressionActive,
} from '../app/terminal-focused-input';
import { isExitedRemoteAgentStatus } from '../domain/server-state';
import { clearAgentReadyCallback, maybeFireAgentReadyCallback } from './agent-ready-callbacks';
import { isAgentAskingQuestion, setAgentQuestionState } from './agent-question-state';
import { createAutoTrustController } from './auto-trust';
import { setStore, store } from './core';

const lastIdleResetAt = new Map<string, number>();
const activeAgentIds = new Set<string>();

const IDLE_TIMEOUT_MS = 15_000;
const THROTTLE_MS = 1_000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastOutputAtByAgent = new Map<string, number>();

const TAIL_BUFFER_MAX = 65_536;
const VISIBLE_ANALYSIS_TAIL_MAX = 500;
const outputTailBuffers = new Map<string, string>();
const strippedTailBuffers = new Map<string, string>();
const outputTailHasAnsi = new Map<string, boolean>();
const latestOutputChunks = new Map<string, string>();
const agentDecoders = new Map<string, TextDecoder>();

const lastAnalysisAt = new Map<string, number>();
const pendingAnalysis = new Map<string, ReturnType<typeof setTimeout>>();
const ANALYSIS_INTERVAL_MS = 200;
const BACKGROUND_ANALYSIS_INTERVAL_MS = 2000;
const BACKGROUND_OUTPUT_SAMPLE_INTERVAL_MS = 250;
const lastBackgroundOutputSampleAt = new Map<string, number>();

export type AgentOutputProcessingMode = 'full' | 'shell';

function appendTailBuffer(previousTail: string, addition: string): string {
  if (addition.length === 0) {
    return previousTail;
  }

  if (addition.length >= TAIL_BUFFER_MAX) {
    return addition.slice(-TAIL_BUFFER_MAX);
  }

  if (previousTail.length === 0) {
    return addition;
  }

  const totalLength = previousTail.length + addition.length;
  if (totalLength <= TAIL_BUFFER_MAX) {
    return previousTail + addition;
  }

  return previousTail.slice(previousTail.length - (TAIL_BUFFER_MAX - addition.length)) + addition;
}

function setAgentTailBuffer(agentId: string, rawTail: string, strippedTail: string): void {
  outputTailBuffers.set(agentId, rawTail);
  strippedTailBuffers.set(agentId, strippedTail);
  outputTailHasAnsi.set(agentId, rawTail.includes('\u001b'));
}

function buildNextAgentTails(
  agentId: string,
  text: string,
): {
  rawTail: string;
  strippedTail: string;
} {
  const previousRawTail = outputTailBuffers.get(agentId) ?? '';
  const nextRawTail = appendTailBuffer(previousRawTail, text);
  const previousStrippedTail = strippedTailBuffers.get(agentId) ?? '';
  const previousTailHasAnsi = outputTailHasAnsi.get(agentId) ?? false;
  const chunkHasAnsi = text.includes('\u001b');

  if (chunkHasAnsi || previousTailHasAnsi) {
    return {
      rawTail: nextRawTail,
      strippedTail: getVisibleTerminalTextForDetection(nextRawTail),
    };
  }

  return {
    rawTail: nextRawTail,
    strippedTail: appendTailBuffer(previousStrippedTail, text),
  };
}

function clearAgentTailBuffer(agentId: string): void {
  outputTailBuffers.delete(agentId);
  strippedTailBuffers.delete(agentId);
  outputTailHasAnsi.delete(agentId);
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
  recordAgentOutputAnalysisRuntime({
    activeAgents: activeAgentIds.size,
    pendingTimers: pendingAnalysis.size,
  });
}

function addToActive(agentId: string): void {
  if (activeAgentIds.has(agentId)) {
    return;
  }

  activeAgentIds.add(agentId);
  setStore('agentActive', agentId, true);
  recordAgentOutputAnalysisRuntime({
    activeAgents: activeAgentIds.size,
    pendingTimers: pendingAnalysis.size,
  });
}

function removeFromActive(agentId: string): void {
  if (!activeAgentIds.delete(agentId)) {
    return;
  }

  setStore('agentActive', agentId, false);
  recordAgentOutputAnalysisRuntime({
    activeAgents: activeAgentIds.size,
    pendingTimers: pendingAnalysis.size,
  });
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
  replaceTail: (agentId, tail) =>
    setAgentTailBuffer(agentId, tail, getVisibleTerminalTextForDetection(tail)),
});

export function isAutoTrustSettling(agentId: string): boolean {
  return autoTrust.isSettling(agentId);
}

export function markAgentSpawned(agentId: string): void {
  clearTerminalFocusedInputAgent(agentId);
  clearAgentTailBuffer(agentId);
  lastOutputAtByAgent.delete(agentId);
  latestOutputChunks.delete(agentId);
  autoTrust.clearState(agentId);
  lastAnalysisAt.delete(agentId);
  lastBackgroundOutputSampleAt.delete(agentId);
  clearPendingAnalysisTimer(agentId);
  addToActive(agentId);
  resetIdleTimer(agentId);
}

function analyzeAgentOutput(agentId: string): void {
  const startedAtMs = performance.now();
  const suppressPromptSignals = isTerminalFocusedInputPromptSuppressionActive(agentId);
  const latestChunk = latestOutputChunks.get(agentId) ?? '';
  if (
    isAgentAskingQuestion(agentId) &&
    latestChunk.length > 0 &&
    clearsQuestionState(latestChunk)
  ) {
    const latestTail =
      latestChunk.length > TAIL_BUFFER_MAX ? latestChunk.slice(-TAIL_BUFFER_MAX) : latestChunk;
    setAgentTailBuffer(agentId, latestTail, getVisibleTerminalTextForDetection(latestTail));
  }

  const strippedTail = getStrippedTailBuffer(agentId);
  const visibleTail = strippedTail.slice(-VISIBLE_ANALYSIS_TAIL_MAX);

  if (suppressPromptSignals) {
    setAgentQuestionState(agentId, false);
    recordAgentOutputAnalysis(performance.now() - startedAtMs);
    return;
  }

  let hasQuestion = looksLikeQuestionInVisibleTail(visibleTail);

  if (hasQuestion && store.autoTrustFolders) {
    if (looksLikeTrustDialogInVisibleTail(visibleTail) && !hasTrustExclusionKeywords(visibleTail)) {
      autoTrust.tryAutoTrust(agentId);
      hasQuestion = false;
    }
  }

  setAgentQuestionState(agentId, hasQuestion);
  if (!hasQuestion && !autoTrust.hasScheduledSubmit(agentId)) {
    maybeFireAgentReadyCallback(agentId, strippedTail);
  }

  recordAgentOutputAnalysis(performance.now() - startedAtMs);
}

function getLastVisibleLine(visibleTail: string): string {
  let searchEnd = visibleTail.length;
  while (searchEnd > 0) {
    const newlineIndex = visibleTail.lastIndexOf('\n', searchEnd - 1);
    const candidateLine = visibleTail.slice(newlineIndex + 1, searchEnd).trim();
    if (candidateLine.length > 0) {
      return candidateLine;
    }
    searchEnd = newlineIndex >= 0 ? newlineIndex : 0;
  }

  return '';
}

function handlePromptLine(
  agentId: string,
  strippedTail: string,
  processingMode: AgentOutputProcessingMode,
): void {
  if (processingMode === 'full') {
    clearPendingAnalysisTimer(agentId);

    if (
      !looksLikeQuestionInVisibleTail(strippedTail) &&
      !hasPromptAdjacentInteractiveChoiceInVisibleTail(strippedTail)
    ) {
      setAgentQuestionState(agentId, false);
    }
    maybeFireAgentReadyCallback(agentId, strippedTail);
  }

  const timer = idleTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(agentId);
  }
  removeFromActive(agentId);
}

function reviveExitedAgentFromOutput(
  agentId: string,
  processingMode: AgentOutputProcessingMode,
  expectedGeneration?: number,
): void {
  if (processingMode !== 'full') {
    return;
  }

  const agent = store.agents?.[agentId];
  if (!agent || !isExitedRemoteAgentStatus(agent.status)) {
    return;
  }
  if (expectedGeneration === undefined || agent.generation !== expectedGeneration) {
    return;
  }

  setStore('agents', agentId, 'status', 'running');
  setStore('agents', agentId, 'exitCode', null);
  setStore('agents', agentId, 'signal', null);
  setStore('agents', agentId, 'lastOutput', []);
}

function matchesExpectedGeneration(agentId: string, expectedGeneration?: number): boolean {
  if (expectedGeneration === undefined) {
    return true;
  }

  const agent = store.agents?.[agentId];
  return agent?.generation === expectedGeneration;
}

export function markAgentOutput(
  agentId: string,
  data: Uint8Array,
  taskId?: string,
  processingMode: AgentOutputProcessingMode = 'full',
  expectedGeneration?: number,
): void {
  if (!matchesExpectedGeneration(agentId, expectedGeneration)) {
    return;
  }

  const now = Date.now();
  const isActiveTask = !taskId || taskId === store.activeTaskId;
  reviveExitedAgentFromOutput(agentId, processingMode, expectedGeneration);

  let decoder = agentDecoders.get(agentId);
  if (!decoder) {
    decoder = new TextDecoder();
    agentDecoders.set(agentId, decoder);
  }

  const text = decoder.decode(data, { stream: true });
  lastOutputAtByAgent.set(agentId, now);
  const nextTails = buildNextAgentTails(agentId, text);
  if (processingMode === 'full') {
    latestOutputChunks.set(agentId, text);
  }
  setAgentTailBuffer(agentId, nextTails.rawTail, nextTails.strippedTail);

  const visibleTail = nextTails.strippedTail.slice(-200);
  const lastLine = getLastVisibleLine(visibleTail);
  const suppressPromptSignals =
    processingMode === 'full' && isTerminalFocusedInputPromptSuppressionActive(agentId);
  if (looksLikePromptLine(lastLine) && !suppressPromptSignals) {
    const visibleQuestionTail = nextTails.strippedTail.slice(-VISIBLE_ANALYSIS_TAIL_MAX);
    const hasVisibleQuestion =
      looksLikeQuestionInVisibleTail(visibleQuestionTail) ||
      hasPromptAdjacentInteractiveChoiceInVisibleTail(visibleQuestionTail);
    if (hasVisibleQuestion) {
      setAgentQuestionState(agentId, true);
      return;
    }

    handlePromptLine(agentId, nextTails.strippedTail, processingMode);
    return;
  }

  if (processingMode === 'full') {
    const shouldRunBackgroundAnalysis = shouldRunBackgroundOutputAnalysis(
      agentId,
      now,
      isActiveTask,
    );
    if (shouldRunBackgroundAnalysis) {
      autoTrust.maybeTryInBackground(agentId, now, isActiveTask);
    }
    scheduleAgentOutputAnalysis(agentId, now, isActiveTask);
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
    recordAgentOutputAnalysisBackgroundCheck(true);
    return true;
  }

  const lastSampleAt = lastBackgroundOutputSampleAt.get(agentId) ?? 0;
  if (now - lastSampleAt < BACKGROUND_OUTPUT_SAMPLE_INTERVAL_MS) {
    recordAgentOutputAnalysisBackgroundCheck(false);
    return false;
  }

  lastBackgroundOutputSampleAt.set(agentId, now);
  recordAgentOutputAnalysisBackgroundCheck(true);
  return true;
}

function scheduleAgentOutputAnalysis(agentId: string, now: number, isActiveTask: boolean): void {
  const interval = isActiveTask ? ANALYSIS_INTERVAL_MS : BACKGROUND_ANALYSIS_INTERVAL_MS;
  const lastAnalysis = lastAnalysisAt.get(agentId) ?? 0;
  if (now - lastAnalysis >= interval) {
    lastAnalysisAt.set(agentId, now);
    clearPendingAnalysisTimer(agentId);
    recordAgentOutputAnalysisSchedule(true);
    analyzeAgentOutput(agentId);
    return;
  }

  if (pendingAnalysis.has(agentId)) {
    return;
  }

  recordAgentOutputAnalysisSchedule(false);
  const delay = Math.max(0, interval - (now - lastAnalysis));
  pendingAnalysis.set(
    agentId,
    setTimeout(() => {
      pendingAnalysis.delete(agentId);
      recordAgentOutputAnalysisRuntime({
        activeAgents: activeAgentIds.size,
        pendingTimers: pendingAnalysis.size,
      });
      lastAnalysisAt.set(agentId, Date.now());
      analyzeAgentOutput(agentId);
    }, delay),
  );
  recordAgentOutputAnalysisRuntime({
    activeAgents: activeAgentIds.size,
    pendingTimers: pendingAnalysis.size,
  });
}

export function getAgentOutputTail(agentId: string): string {
  return outputTailBuffers.get(agentId) ?? '';
}

export function isAgentIdle(agentId: string): boolean {
  return !store.agentActive[agentId];
}

export function getAgentLastOutputAt(agentId: string): number | null {
  return lastOutputAtByAgent.get(agentId) ?? null;
}

export function markAgentBusy(agentId: string): void {
  addToActive(agentId);
  resetIdleTimer(agentId);
}

export function clearAgentBusyState(agentId: string): void {
  lastIdleResetAt.delete(agentId);

  const timer = idleTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(agentId);
  }

  removeFromActive(agentId);
}

export function clearAgentActivity(agentId: string): void {
  clearTerminalFocusedInputAgent(agentId);
  lastOutputAtByAgent.delete(agentId);
  lastBackgroundOutputSampleAt.delete(agentId);
  clearAgentTailBuffer(agentId);
  latestOutputChunks.delete(agentId);
  agentDecoders.delete(agentId);
  clearAgentReadyCallback(agentId);
  autoTrust.clearState(agentId);
  lastAnalysisAt.delete(agentId);
  clearPendingAnalysisTimer(agentId);
  clearAgentBusyState(agentId);
  setAgentQuestionState(agentId, false);
}

export function resetAgentOutputActivityRuntimeState(): void {
  for (const agentId of Array.from(lastIdleResetAt.keys())) {
    clearAgentActivity(agentId);
  }

  outputTailBuffers.clear();
  strippedTailBuffers.clear();
  lastOutputAtByAgent.clear();
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
  recordAgentOutputAnalysisRuntime({
    activeAgents: activeAgentIds.size,
    pendingTimers: pendingAnalysis.size,
  });
}

export function resetAgentOutputActivityStateForTests(): void {
  resetAgentOutputActivityRuntimeState();
}
