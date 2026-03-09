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

function evictEntry(id: string): void {
  const entry = activeContexts.get(id);
  if (!entry) return;

  const { addon, term, onRendererLost } = entry;
  activeContexts.delete(id);
  const idx = contextOrder.indexOf(id);
  if (idx >= 0) contextOrder.splice(idx, 1);

  try {
    addon.dispose();
  } catch {
    // Already disposed or context lost
  }

  // Force a full repaint so the DOM fallback renderer fills the canvas.
  // Then notify the view so it can restore scrollback if needed.
  try {
    term.refresh(0, term.rows - 1);
  } catch {
    // Terminal may already be disposed
  }

  queueMicrotask(() => onRendererLost?.());
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

  // Evict oldest if at capacity
  if (activeContexts.size >= MAX_WEBGL_CONTEXTS && contextOrder.length > 0) {
    const evictId = contextOrder[0];
    evictEntry(evictId);
  }

  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      evictEntry(agentId);
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
  const idx = contextOrder.indexOf(agentId);
  if (idx >= 0) contextOrder.splice(idx, 1);
}
