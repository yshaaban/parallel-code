import { getVisibleTerminalTextForDetection } from '../lib/prompt-detection';
import { getAgentLastOutputAt, getAgentOutputTail } from './agent-output-activity';
import { store } from './core';
import { getSelectedTaskAgentId } from './task-agent-selection';

export interface TaskTerminalSlateSnapshot {
  agentId: string;
  lastLine: string;
  lastOutputAt: number | null;
  stale: boolean;
}

const TASK_TERMINAL_SLATE_LAST_LINE_MAX = 96;
const TASK_TERMINAL_SLATE_STALE_AFTER_MS = 30_000;
const TASK_TERMINAL_SLATE_CACHE_MAX_ENTRIES = 256;
const TASK_TERMINAL_SLATE_CACHE_KEY_TAIL_MAX = 512;
const TASK_TERMINAL_PLACEHOLDER_MAX_LINES = 24;
const TASK_TERMINAL_PLACEHOLDER_LINE_MAX = 200;
const taskTerminalSlateCache = new Map<string, { lastLine: string; outputTailKey: string }>();
const taskTerminalPlaceholderCache = new Map<
  string,
  { outputTailKey: string; placeholder: string | null }
>();

function getOutputTailCacheKey(outputTail: string): string {
  return `${outputTail.length}:${outputTail.slice(-TASK_TERMINAL_SLATE_CACHE_KEY_TAIL_MAX)}`;
}

function cacheTaskTerminalSlate(agentId: string, lastLine: string, outputTail: string): void {
  if (taskTerminalSlateCache.has(agentId)) {
    taskTerminalSlateCache.delete(agentId);
  } else {
    const oldestAgentId = taskTerminalSlateCache.keys().next().value as string | undefined;
    if (
      oldestAgentId !== undefined &&
      taskTerminalSlateCache.size >= TASK_TERMINAL_SLATE_CACHE_MAX_ENTRIES
    ) {
      taskTerminalSlateCache.delete(oldestAgentId);
    }
  }

  taskTerminalSlateCache.set(agentId, {
    lastLine,
    outputTailKey: getOutputTailCacheKey(outputTail),
  });
}

export function clearTaskTerminalSlateCacheForAgent(agentId: string): void {
  taskTerminalSlateCache.delete(agentId);
  taskTerminalPlaceholderCache.delete(agentId);
}

export function getTaskTerminalSlateCacheSizeForTests(): number {
  return taskTerminalSlateCache.size;
}

export function hasTaskTerminalSlateCacheForAgentForTests(agentId: string): boolean {
  return taskTerminalSlateCache.has(agentId);
}

export function resetTaskTerminalSlateCache(): void {
  taskTerminalSlateCache.clear();
  taskTerminalPlaceholderCache.clear();
}

export function resetTaskTerminalSlateCacheForTests(): void {
  resetTaskTerminalSlateCache();
}

function getLastVisibleLine(outputTail: string): string {
  const visibleLines = getVisibleTerminalTextForDetection(outputTail)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const visibleTail = visibleLines[visibleLines.length - 1];

  if (!visibleTail) {
    return '';
  }

  if (visibleTail.length <= TASK_TERMINAL_SLATE_LAST_LINE_MAX) {
    return visibleTail;
  }

  return `...${visibleTail.slice(-TASK_TERMINAL_SLATE_LAST_LINE_MAX)}`;
}

function computeTaskTerminalPlaceholderTail(agentId: string, outputTail: string): string | null {
  if (outputTail.length > 0) {
    // Visible-text detection turns redraw/SGR boundaries into newlines, so a
    // blank line here is presentation noise rather than real screen shape;
    // keep only content lines, like the prompt-detection helpers do.
    const visibleLines = getVisibleTerminalTextForDetection(outputTail)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) =>
        line.length > TASK_TERMINAL_PLACEHOLDER_LINE_MAX
          ? line.slice(-TASK_TERMINAL_PLACEHOLDER_LINE_MAX)
          : line,
      );
    if (visibleLines.length > 0) {
      return visibleLines.slice(-TASK_TERMINAL_PLACEHOLDER_MAX_LINES).join('\n');
    }
  }

  const preview = store.agentSupervision[agentId]?.preview?.trim();
  return preview ? preview : null;
}

// Static "last known screen" projection for the terminal loading placeholder:
// the last visible lines of the local output tail, falling back to the
// backend supervision preview when no local tail exists yet (cold start).
export function getTaskTerminalPlaceholderTail(agentId: string): string | null {
  const outputTail = getAgentOutputTail(agentId);
  const outputTailKey = getOutputTailCacheKey(outputTail);
  const cached = taskTerminalPlaceholderCache.get(agentId);
  if (cached?.outputTailKey === outputTailKey && (outputTail.length > 0 || cached.placeholder)) {
    return cached.placeholder;
  }

  const placeholder = computeTaskTerminalPlaceholderTail(agentId, outputTail);
  taskTerminalPlaceholderCache.set(agentId, { outputTailKey, placeholder });
  if (taskTerminalPlaceholderCache.size > TASK_TERMINAL_SLATE_CACHE_MAX_ENTRIES) {
    const oldestAgentId = taskTerminalPlaceholderCache.keys().next().value as string | undefined;
    if (oldestAgentId !== undefined) {
      taskTerminalPlaceholderCache.delete(oldestAgentId);
    }
  }

  return placeholder;
}

export function getTaskTerminalSlateSnapshot(
  taskId: string,
  nowMs = Date.now(),
): TaskTerminalSlateSnapshot | null {
  const task = store.tasks[taskId];
  if (!task) {
    return null;
  }

  const agentId = getSelectedTaskAgentId(task) ?? task.agentIds[0];
  if (!agentId) {
    return null;
  }

  const lastOutputAt = getAgentLastOutputAt(agentId);
  const outputTail = getAgentOutputTail(agentId);
  const outputTailKey = getOutputTailCacheKey(outputTail);
  const cachedSlate = taskTerminalSlateCache.get(agentId);
  const hasCachedLastLine = cachedSlate?.outputTailKey === outputTailKey;
  const lastLine = hasCachedLastLine ? cachedSlate.lastLine : getLastVisibleLine(outputTail);
  if (!hasCachedLastLine) {
    cacheTaskTerminalSlate(agentId, lastLine, outputTail);
  }
  if (!lastLine && lastOutputAt === null) {
    return null;
  }

  const stale =
    lastOutputAt === null ? true : nowMs - lastOutputAt > TASK_TERMINAL_SLATE_STALE_AFTER_MS;

  return {
    agentId,
    lastLine,
    lastOutputAt,
    stale,
  };
}
