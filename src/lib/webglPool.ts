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
const activeContexts = new Map<string, WebglAddon>();
const contextOrder: string[] = []; // LRU order, most recent at end

/**
 * Acquire a WebGL addon for a terminal. Returns null if WebGL is unavailable.
 * Evicts the least-recently-used context if the pool is full.
 */
export function acquireWebglAddon(agentId: string, term: Terminal): WebglAddon | null {
  // Already has one — promote in LRU
  const existing = activeContexts.get(agentId);
  if (existing) {
    const idx = contextOrder.indexOf(agentId);
    if (idx >= 0) contextOrder.splice(idx, 1);
    contextOrder.push(agentId);
    return existing;
  }

  // Evict oldest if at capacity
  if (activeContexts.size >= MAX_WEBGL_CONTEXTS && contextOrder.length > 0) {
    const evictId = contextOrder.shift() ?? '';
    const evicted = activeContexts.get(evictId);
    if (evicted) {
      try {
        evicted.dispose();
      } catch {
        // Already disposed or context lost
      }
      activeContexts.delete(evictId);
    }
  }

  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      try {
        addon.dispose();
      } catch {
        // Already disposed
      }
      activeContexts.delete(agentId);
      const idx = contextOrder.indexOf(agentId);
      if (idx >= 0) contextOrder.splice(idx, 1);
    });
    term.loadAddon(addon);
    activeContexts.set(agentId, addon);
    contextOrder.push(agentId);
    return addon;
  } catch {
    // WebGL2 not supported — DOM renderer used automatically
    return null;
  }
}

/** Release a WebGL addon, returning the context to the pool. */
export function releaseWebglAddon(agentId: string): void {
  const addon = activeContexts.get(agentId);
  if (addon) {
    try {
      addon.dispose();
    } catch {
      // Already disposed
    }
    activeContexts.delete(agentId);
  }
  const idx = contextOrder.indexOf(agentId);
  if (idx >= 0) contextOrder.splice(idx, 1);
}
