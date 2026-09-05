/**
 * WebGL context pool for xterm.js terminals.
 *
 * Browsers limit the number of active WebGL contexts (typically 8-16).
 * This pool manages WebglAddon instances with LRU eviction to prevent
 * context exhaustion and the resulting fallback flicker.
 */

import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';
import {
  recordTerminalRendererAcquire,
  recordTerminalRendererAtlasRepair,
  recordTerminalRendererEviction,
  recordTerminalRendererFallbackActivation,
  recordTerminalRendererPoolSnapshot,
  recordTerminalRendererRelease,
  type TerminalRendererPoolSnapshot,
  type TerminalWebglRepairReason,
} from '../app/runtime-diagnostics';
import { isMac } from './platform';
import type { TerminalWebglPriority } from './terminal-output-priority';

export type { TerminalWebglRepairReason } from '../app/runtime-diagnostics';

const MAX_WEBGL_CONTEXTS = 6;
type WebglAddonConstructor = new () => WebglAddon;

interface PoolEntry {
  addon: WebglAddon;
  generation: number;
  lastTouchedAt: number;
  priority: TerminalWebglPriority;
  term: Terminal;
  onRendererLost?: () => void;
}

interface AcquireWebglAddonOptions {
  visibleContextLimit?: number;
}

interface PendingWebglRepair {
  generation: number;
  id: string;
  reason: TerminalWebglRepairReason;
  requestedAt: number;
}

const activeContexts = new Map<string, PoolEntry>();
const contextOrder: string[] = []; // LRU order, most recent at end
const fallbackAgents = new Set<string>();
const WEBGL_PRIORITY_METADATA = {
  focused: { order: 0, visible: true },
  visible: { order: 1, visible: true },
  background: { order: 2, visible: false },
  hidden: { order: 3, visible: false },
} as const satisfies Record<TerminalWebglPriority, { order: number; visible: boolean }>;
let webglAddonConstructor: WebglAddonConstructor | null = null;
let webglAddonLoadPromise: Promise<WebglAddonConstructor> | null = null;
const pendingRepairs = new Map<string, PendingWebglRepair>();
let entryGeneration = 0;
let foregroundListenersInstalled = false;
let foregroundState = false;
let repairAnimationFrame: number | null = null;
let touchSequence = 0;

function getRepairNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function requestRepairAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }

  return setTimeout(() => callback(getRepairNow()), 16) as unknown as number;
}

function cancelRepairAnimationFrame(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(frame);
    return;
  }

  clearTimeout(frame);
}

function isDocumentVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState !== 'hidden';
}

function isDocumentForeground(): boolean {
  return isDocumentVisible() && document.hasFocus();
}

function getRepairKey(id: string, generation: number): string {
  return `${id}:${generation}`;
}

function isRepairablePriority(priority: TerminalWebglPriority): boolean {
  return priority === 'focused' || priority === 'visible';
}

function cancelRepairDrain(): void {
  if (repairAnimationFrame === null) {
    return;
  }

  cancelRepairAnimationFrame(repairAnimationFrame);
  repairAnimationFrame = null;
}

function removePendingRepair(id: string, generation: number): void {
  pendingRepairs.delete(getRepairKey(id, generation));
  if (pendingRepairs.size === 0) {
    cancelRepairDrain();
  }
}

function selectNextPendingRepair(): PendingWebglRepair | null {
  const repairs = [...pendingRepairs.values()];
  repairs.sort((left, right) => {
    const leftEntry = activeContexts.get(left.id);
    const rightEntry = activeContexts.get(right.id);
    const leftPriority = leftEntry?.priority === 'focused' ? 0 : 1;
    const rightPriority = rightEntry?.priority === 'focused' ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const touchDelta = (rightEntry?.lastTouchedAt ?? -1) - (leftEntry?.lastTouchedAt ?? -1);
    if (touchDelta !== 0) {
      return touchDelta;
    }

    return left.requestedAt - right.requestedAt;
  });
  return repairs[0] ?? null;
}

function scheduleRepairDrain(): void {
  if (repairAnimationFrame !== null || pendingRepairs.size === 0) {
    return;
  }

  repairAnimationFrame = requestRepairAnimationFrame(() => {
    repairAnimationFrame = null;
    const repair = selectNextPendingRepair();
    if (!repair) {
      return;
    }

    pendingRepairs.delete(getRepairKey(repair.id, repair.generation));
    const entry = activeContexts.get(repair.id);
    if (!entry) {
      recordTerminalRendererAtlasRepair({ type: 'skipped', reason: 'disposed' });
    } else if (entry.generation !== repair.generation) {
      recordTerminalRendererAtlasRepair({ type: 'skipped', reason: 'generation' });
    } else if (!isRepairablePriority(entry.priority) || !isDocumentVisible()) {
      recordTerminalRendererAtlasRepair({ type: 'skipped', reason: 'hidden' });
    } else if (entry.term.rows <= 0) {
      recordTerminalRendererAtlasRepair({ type: 'skipped', reason: 'ineligible' });
    } else {
      try {
        entry.addon.clearTextureAtlas();
        entry.term.refresh(0, entry.term.rows - 1);
        recordTerminalRendererAtlasRepair({
          delayMs: Math.max(0, getRepairNow() - repair.requestedAt),
          type: 'applied',
        });
      } catch {
        recordTerminalRendererAtlasRepair({ type: 'failed' });
      }
    }

    scheduleRepairDrain();
  });
}

function queueEntryRepair(
  id: string,
  entry: PoolEntry,
  reason: TerminalWebglRepairReason,
): boolean {
  if (!isRepairablePriority(entry.priority) || entry.term.rows <= 0) {
    return false;
  }

  const key = getRepairKey(id, entry.generation);
  const existing = pendingRepairs.get(key);
  if (existing) {
    if (reason === 'manual' && existing.reason !== 'manual') {
      pendingRepairs.set(key, { ...existing, reason });
    }
    return false;
  }

  pendingRepairs.set(key, {
    generation: entry.generation,
    id,
    reason,
    requestedAt: getRepairNow(),
  });
  recordTerminalRendererAtlasRepair({ queueDepth: pendingRepairs.size, type: 'queued' });
  scheduleRepairDrain();
  return true;
}

export function requestVisibleWebglAtlasRepair(reason: TerminalWebglRepairReason): number {
  recordTerminalRendererAtlasRepair({ reason, type: 'intent' });
  let queued = 0;
  for (const [id, entry] of activeContexts) {
    if (queueEntryRepair(id, entry, reason)) {
      queued += 1;
    }
  }
  return queued;
}

function reconcileForeground(): void {
  const nextForeground = isDocumentForeground();
  const becameForeground = !foregroundState && nextForeground;
  foregroundState = nextForeground;
  if (becameForeground && isMac) {
    requestVisibleWebglAtlasRepair('foreground');
  }
}

function handleForegroundEvent(): void {
  reconcileForeground();
}

function installForegroundListeners(): void {
  if (
    foregroundListenersInstalled ||
    typeof window === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return;
  }

  foregroundState = isDocumentForeground();
  window.addEventListener('focus', handleForegroundEvent);
  window.addEventListener('blur', handleForegroundEvent);
  document.addEventListener('visibilitychange', handleForegroundEvent);
  foregroundListenersInstalled = true;
}

function removeForegroundListeners(): void {
  if (!foregroundListenersInstalled) {
    return;
  }

  window.removeEventListener('focus', handleForegroundEvent);
  window.removeEventListener('blur', handleForegroundEvent);
  document.removeEventListener('visibilitychange', handleForegroundEvent);
  foregroundListenersInstalled = false;
  foregroundState = false;
}

function reconcilePoolLifecycle(): void {
  if (activeContexts.size > 0) {
    installForegroundListeners();
    return;
  }

  pendingRepairs.clear();
  cancelRepairDrain();
  removeForegroundListeners();
}

function loadWebglAddonConstructor(): Promise<WebglAddonConstructor> {
  if (webglAddonConstructor) {
    return Promise.resolve(webglAddonConstructor);
  }

  webglAddonLoadPromise ??= import('@xterm/addon-webgl')
    .then((module) => {
      webglAddonConstructor = module.WebglAddon;
      return module.WebglAddon;
    })
    .catch((error: unknown) => {
      webglAddonLoadPromise = null;
      throw error;
    });

  return webglAddonLoadPromise;
}

export function isWebglAddonRuntimeReady(): boolean {
  return webglAddonConstructor !== null;
}

export async function preloadWebglAddon(): Promise<void> {
  await loadWebglAddonConstructor();
}

function createWebglAddon(): WebglAddon | null {
  if (!webglAddonConstructor) {
    void preloadWebglAddon().catch(() => {});
    return null;
  }

  return new webglAddonConstructor();
}

function getWebglPoolSnapshot(): TerminalRendererPoolSnapshot {
  let visibleContextsCurrent = 0;
  for (const entry of activeContexts.values()) {
    if (entry.priority === 'focused' || entry.priority === 'visible') {
      visibleContextsCurrent += 1;
    }
  }

  return {
    activeContextsCurrent: activeContexts.size,
    visibleContextsCurrent,
  };
}

export function getWebglPoolRuntimeSnapshot(): TerminalRendererPoolSnapshot {
  return getWebglPoolSnapshot();
}

function setRendererLostCallback(entry: PoolEntry, onRendererLost: (() => void) | undefined): void {
  if (onRendererLost) {
    entry.onRendererLost = onRendererLost;
    return;
  }

  delete entry.onRendererLost;
}

function removeFromOrder(id: string): void {
  const idx = contextOrder.indexOf(id);
  if (idx >= 0) {
    contextOrder.splice(idx, 1);
  }
}

function promoteEntry(id: string): void {
  removeFromOrder(id);
  contextOrder.push(id);
  const entry = activeContexts.get(id);
  if (entry) {
    touchSequence += 1;
    entry.lastTouchedAt = touchSequence;
  }
}

function getPriorityOrder(priority: TerminalWebglPriority): number {
  return WEBGL_PRIORITY_METADATA[priority].order;
}

function isVisibleWebglPriority(priority: TerminalWebglPriority): boolean {
  return WEBGL_PRIORITY_METADATA[priority].visible;
}

function shouldEvictEntryForAcquire(
  entryPriority: TerminalWebglPriority,
  requestedPriority: TerminalWebglPriority,
): boolean {
  const entryOrder = getPriorityOrder(entryPriority);
  const requestedOrder = getPriorityOrder(requestedPriority);
  if (entryOrder > requestedOrder) {
    return true;
  }

  if (entryOrder === requestedOrder && !isVisibleWebglPriority(requestedPriority)) {
    return true;
  }

  return false;
}

function findEvictionCandidateId(requestedPriority: TerminalWebglPriority): string | null {
  let candidateId: string | null = null;
  let candidatePriority = Number.POSITIVE_INFINITY;
  let candidateTouchedAt = Number.POSITIVE_INFINITY;

  for (const [id, entry] of activeContexts) {
    if (!shouldEvictEntryForAcquire(entry.priority, requestedPriority)) {
      continue;
    }

    const priority = getPriorityOrder(entry.priority);
    if (candidateId === null) {
      candidateId = id;
      candidatePriority = priority;
      candidateTouchedAt = entry.lastTouchedAt;
      continue;
    }

    if (priority > candidatePriority) {
      candidateId = id;
      candidatePriority = priority;
      candidateTouchedAt = entry.lastTouchedAt;
      continue;
    }

    if (priority < candidatePriority) {
      continue;
    }

    if (entry.lastTouchedAt < candidateTouchedAt) {
      candidateId = id;
      candidateTouchedAt = entry.lastTouchedAt;
    }
  }

  return candidateId;
}

function getVisibleContextLimit(options: AcquireWebglAddonOptions | undefined): number | null {
  const limit = options?.visibleContextLimit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return null;
  }

  return limit;
}

function isVisibleContextLimitReached(
  agentId: string,
  requestedPriority: TerminalWebglPriority,
  options: AcquireWebglAddonOptions | undefined,
): boolean {
  const visibleContextLimit = getVisibleContextLimit(options);
  if (visibleContextLimit === null || !isVisibleWebglPriority(requestedPriority)) {
    return false;
  }

  const existing = activeContexts.get(agentId);
  const existingVisibleContextCount = existing && isVisibleWebglPriority(existing.priority) ? 1 : 0;
  return (
    getWebglPoolSnapshot().visibleContextsCurrent - existingVisibleContextCount >=
    visibleContextLimit
  );
}

function updateEntryPriority(id: string, entry: PoolEntry, priority: TerminalWebglPriority): void {
  if (entry.priority === priority) {
    return;
  }

  const wasVisible = isVisibleWebglPriority(entry.priority);
  entry.priority = priority;
  if (isVisibleWebglPriority(priority)) {
    promoteEntry(id);
  }
  recordTerminalRendererPoolSnapshot(getWebglPoolSnapshot());
  if (
    isMac &&
    !wasVisible &&
    isVisibleWebglPriority(priority) &&
    foregroundState &&
    isDocumentForeground()
  ) {
    recordTerminalRendererAtlasRepair({ reason: 'newly-visible', type: 'intent' });
    queueEntryRepair(id, entry, 'newly-visible');
  }
}

/**
 * Evict a WebGL context from the pool.
 * @param notifyLost If true, fire `onRendererLost` so the terminal restores
 *   scrollback. Set to false for LRU eviction where the DOM fallback renderer
 *   already has the content and a full scrollback replay would be wasteful.
 */
function evictEntry(id: string, notifyLost: boolean): void {
  const entry = activeContexts.get(id);
  if (!entry) {
    return;
  }

  const { addon, term, onRendererLost } = entry;
  removePendingRepair(id, entry.generation);
  activeContexts.delete(id);
  removeFromOrder(id);
  fallbackAgents.add(id);
  const snapshot = getWebglPoolSnapshot();
  reconcilePoolLifecycle();

  try {
    addon.dispose();
  } catch {
    // Already disposed or context lost
  }

  // Force a full repaint so the DOM fallback renderer fills the canvas.
  try {
    term.refresh(0, term.rows - 1);
  } catch {
    // Terminal may already be disposed
  }

  if (notifyLost) {
    queueMicrotask(() => onRendererLost?.());
  }

  recordTerminalRendererEviction(snapshot);
  recordTerminalRendererFallbackActivation(snapshot);
}

function disposeUnpublishedAddon(addon: WebglAddon): void {
  try {
    addon.dispose();
  } catch {
    // A failed activation may have partially disposed the addon already.
  }
}

/**
 * Acquire a WebGL addon for a terminal. Returns null if WebGL is unavailable.
 * Evicts the least-recently-used context if the pool is full.
 *
 * @param onRendererLost Called when this terminal's WebGL context is evicted
 *   or lost. The terminal falls back to the DOM renderer but the caller
 *   should restore scrollback to repaint the viewport.
 */
export function acquireWebglAddon(
  agentId: string,
  term: Terminal,
  onRendererLost?: () => void,
  requestedPriority: TerminalWebglPriority = 'background',
  options?: AcquireWebglAddonOptions,
): WebglAddon | null {
  // Already has one — promote in LRU and update callback
  const existing = activeContexts.get(agentId);
  if (existing) {
    if (isVisibleContextLimitReached(agentId, requestedPriority, options)) {
      evictEntry(agentId, false);
      recordTerminalRendererAcquire({
        hit: false,
        snapshot: getWebglPoolSnapshot(),
      });
      return null;
    }

    setRendererLostCallback(existing, onRendererLost);
    updateEntryPriority(agentId, existing, requestedPriority);
    promoteEntry(agentId);
    recordTerminalRendererAcquire({
      hit: true,
      snapshot: getWebglPoolSnapshot(),
    });
    return existing.addon;
  }

  if (isVisibleContextLimitReached(agentId, requestedPriority, options)) {
    recordTerminalRendererAcquire({
      hit: false,
      snapshot: getWebglPoolSnapshot(),
    });
    return null;
  }

  // Evict oldest if at capacity — DOM fallback renderer takes over without
  // needing a scrollback replay (notifyLost: false).
  if (activeContexts.size >= MAX_WEBGL_CONTEXTS && contextOrder.length > 0) {
    const evictId = findEvictionCandidateId(requestedPriority);
    if (evictId) {
      evictEntry(evictId, false);
    } else {
      recordTerminalRendererAcquire({
        hit: false,
        snapshot: getWebglPoolSnapshot(),
      });
      return null;
    }
  }

  let addon: WebglAddon | null = null;
  try {
    addon = createWebglAddon();
  } catch {
    // WebGL2 not supported — DOM renderer used automatically
    recordTerminalRendererAcquire({
      hit: false,
      snapshot: getWebglPoolSnapshot(),
    });
    return null;
  }
  if (!addon) {
    return null;
  }

  const generation = ++entryGeneration;
  let contextLostBeforePublish = false;
  let published = false;
  try {
    addon.onContextLoss(() => {
      if (!published) {
        contextLostBeforePublish = true;
        return;
      }

      const currentEntry = activeContexts.get(agentId);
      if (currentEntry?.addon !== addon || currentEntry.generation !== generation) {
        return;
      }

      // Browser-initiated context loss — viewport is truly blank, so the
      // terminal needs a scrollback restore (notifyLost: true).
      evictEntry(agentId, true);
    });
    term.loadAddon(addon);
  } catch {
    disposeUnpublishedAddon(addon);
    recordTerminalRendererAcquire({
      hit: false,
      snapshot: getWebglPoolSnapshot(),
    });
    return null;
  }

  if (contextLostBeforePublish) {
    disposeUnpublishedAddon(addon);
    recordTerminalRendererAcquire({
      hit: false,
      snapshot: getWebglPoolSnapshot(),
    });
    return null;
  }

  const entry: PoolEntry = {
    addon,
    generation,
    lastTouchedAt: 0,
    priority: requestedPriority,
    term,
  };
  setRendererLostCallback(entry, onRendererLost);
  activeContexts.set(agentId, entry);
  published = true;
  promoteEntry(agentId);
  reconcilePoolLifecycle();
  const recoveredFromFallback = fallbackAgents.delete(agentId);
  recordTerminalRendererAcquire({
    hit: true,
    recoveredFromFallback,
    snapshot: getWebglPoolSnapshot(),
  });
  return addon;
}

/** Promote an entry when the terminal becomes active again. */
export function touchWebglAddon(agentId: string): void {
  if (!activeContexts.has(agentId)) {
    return;
  }

  promoteEntry(agentId);
}

export function setWebglAddonPriority(
  agentId: string,
  priority: TerminalWebglPriority,
  options?: AcquireWebglAddonOptions,
): boolean {
  const entry = activeContexts.get(agentId);
  if (!entry) {
    return false;
  }

  if (isVisibleContextLimitReached(agentId, priority, options)) {
    // Focused terminals may acquire above the visible-set experiment limit.
    // When they demote back to visible, evict this context instead of retaining
    // more visible WebGL surfaces than the experiment allows.
    evictEntry(agentId, false);
    return false;
  }

  updateEntryPriority(agentId, entry, priority);
  return true;
}

/** Release a WebGL addon, returning the context to the pool. */
export function releaseWebglAddon(agentId: string): void {
  const entry = activeContexts.get(agentId);
  if (entry) {
    removePendingRepair(agentId, entry.generation);
    activeContexts.delete(agentId);
    removeFromOrder(agentId);
    fallbackAgents.delete(agentId);
    delete entry.onRendererLost;
    try {
      entry.addon.dispose();
    } catch {
      // Already disposed
    }
    recordTerminalRendererRelease(getWebglPoolSnapshot());
    reconcilePoolLifecycle();
    return;
  }
  fallbackAgents.delete(agentId);
  removeFromOrder(agentId);
  reconcilePoolLifecycle();
}
