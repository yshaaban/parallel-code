/**
 * WebGL context pool for xterm.js terminals.
 *
 * Browsers limit the number of active WebGL contexts (typically 8-16).
 * This pool manages WebglAddon instances with LRU eviction to prevent
 * context exhaustion and the resulting fallback flicker.
 */

import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

const MAX_WEBGL_CONTEXTS = 6;

interface PoolEntry {
  addon: WebglAddon;
  term: Terminal;
  onRendererLost?: () => void;
}

const activeContexts = new Map<string, PoolEntry>();
const contextOrder: string[] = []; // LRU order, most recent at end

function setRendererLostCallback(entry: PoolEntry, onRendererLost: (() => void) | undefined): void {
  if (onRendererLost) {
    entry.onRendererLost = onRendererLost;
    return;
  }

  delete entry.onRendererLost;
}

function removeFromOrder(id: string): void {
  const idx = contextOrder.indexOf(id);
  if (idx >= 0) contextOrder.splice(idx, 1);
}

function promoteEntry(id: string): void {
  removeFromOrder(id);
  contextOrder.push(id);
}

/**
 * Evict a WebGL context from the pool.
 * @param notifyLost If true, fire `onRendererLost` so the terminal restores
 *   scrollback. Set to false for LRU eviction where the DOM fallback renderer
 *   already has the content and a full scrollback replay would be wasteful.
 */
function evictEntry(id: string, notifyLost: boolean): void {
  const entry = activeContexts.get(id);
  if (!entry) return;

  const { addon, term, onRendererLost } = entry;
  activeContexts.delete(id);
  removeFromOrder(id);

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
): WebglAddon | null {
  // Already has one — promote in LRU and update callback
  const existing = activeContexts.get(agentId);
  if (existing) {
    setRendererLostCallback(existing, onRendererLost);
    promoteEntry(agentId);
    return existing.addon;
  }

  // Evict oldest if at capacity — DOM fallback renderer takes over without
  // needing a scrollback replay (notifyLost: false).
  if (activeContexts.size >= MAX_WEBGL_CONTEXTS && contextOrder.length > 0) {
    const evictId = contextOrder[0];
    if (evictId !== undefined) {
      evictEntry(evictId, false);
    }
  }

  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      // Browser-initiated context loss — viewport is truly blank, so the
      // terminal needs a scrollback restore (notifyLost: true).
      evictEntry(agentId, true);
    });
    term.loadAddon(addon);
    const entry: PoolEntry = { addon, term };
    setRendererLostCallback(entry, onRendererLost);
    activeContexts.set(agentId, entry);
    promoteEntry(agentId);
    return addon;
  } catch {
    // WebGL2 not supported — DOM renderer used automatically
    return null;
  }
}

/** Promote an entry when the terminal becomes active again. */
export function touchWebglAddon(agentId: string): void {
  if (!activeContexts.has(agentId)) return;
  promoteEntry(agentId);
}

/** Release a WebGL addon, returning the context to the pool. */
export function releaseWebglAddon(agentId: string): void {
  const entry = activeContexts.get(agentId);
  if (entry) {
    activeContexts.delete(agentId);
    removeFromOrder(agentId);
    delete entry.onRendererLost;
    try {
      entry.addon.dispose();
    } catch {
      // Already disposed
    }
    return;
  }
  removeFromOrder(agentId);
}
