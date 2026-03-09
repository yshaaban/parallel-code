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

function removeFromOrder(id: string): void {
  const idx = contextOrder.indexOf(id);
  if (idx >= 0) contextOrder.splice(idx, 1);
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
    existing.onRendererLost = onRendererLost;
    const idx = contextOrder.indexOf(agentId);
    if (idx >= 0) contextOrder.splice(idx, 1);
    contextOrder.push(agentId);
    return existing.addon;
  }

  // Evict oldest if at capacity — DOM fallback renderer takes over without
  // needing a scrollback replay (notifyLost: false).
  if (activeContexts.size >= MAX_WEBGL_CONTEXTS && contextOrder.length > 0) {
    const evictId = contextOrder[0];
    evictEntry(evictId, false);
  }

  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      // Browser-initiated context loss — viewport is truly blank, so the
      // terminal needs a scrollback restore (notifyLost: true).
      evictEntry(agentId, true);
    });
    term.loadAddon(addon);
    activeContexts.set(agentId, { addon, term, onRendererLost });
    contextOrder.push(agentId);
    return addon;
  } catch {
    // WebGL2 not supported — DOM renderer used automatically
    return null;
  }
}

/** Release a WebGL addon, returning the context to the pool. */
export function releaseWebglAddon(agentId: string): void {
  const entry = activeContexts.get(agentId);
  if (entry) {
    try {
      entry.addon.dispose();
    } catch {
      // Already disposed
    }
    activeContexts.delete(agentId);
  }
  removeFromOrder(agentId);
}
