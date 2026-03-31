import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import {
  recordTerminalFitDirtyMark,
  recordTerminalFitExecution,
  recordTerminalFitFlush,
  type TerminalFitDirtyReason,
} from '../app/runtime-diagnostics';

interface TerminalGeometry {
  cols: number;
  rows: number;
}

interface TerminalEntry {
  canProcessDirtyReasons: (dirtyReasons: ReadonlySet<TerminalFitDirtyReason>) => boolean;
  container: HTMLElement;
  dirtyReasons: Set<TerminalFitDirtyReason>;
  fitAddon: FitAddon;
  onResizeObserved: ((geometry: TerminalGeometry) => void) | undefined;
  term: Terminal;
}

const entries = new Map<string, TerminalEntry>();
const entryByContainer = new Map<HTMLElement, TerminalEntry>();
let rafId: number | undefined;
let trailingTimer: number | undefined;
let lastFlushTime = 0;
const THROTTLE_MS = 150;

function markEntryDirty(entry: TerminalEntry, reason: TerminalFitDirtyReason): void {
  entry.dirtyReasons.add(reason);
  recordTerminalFitDirtyMark(reason);
}

function isSameTerminalGeometry(
  left: TerminalGeometry | undefined,
  right: Pick<Terminal, 'cols' | 'rows'>,
): boolean {
  if (!left) {
    return false;
  }

  return left.cols === right.cols && left.rows === right.rows;
}

const resizeObserver = new ResizeObserver((resizeEntries) => {
  let markedDirty = false;
  for (const re of resizeEntries) {
    const entry = entryByContainer.get(re.target as HTMLElement);
    if (!entry) {
      continue;
    }

    markEntryDirty(entry, 'resize');
    markedDirty = true;
  }
  if (markedDirty) {
    scheduleFlush();
  }
});

const intersectionObserver = new IntersectionObserver((ioEntries) => {
  let markedDirty = false;
  for (const ioe of ioEntries) {
    if (!ioe.isIntersecting) {
      continue;
    }

    const entry = entryByContainer.get(ioe.target as HTMLElement);
    if (!entry) {
      continue;
    }

    markEntryDirty(entry, 'intersection');
    markedDirty = true;
  }
  if (markedDirty) {
    scheduleFlush();
  }
});

function flush(): void {
  let didWork = false;
  let needsFollowUpFlush = false;
  for (const [, entry] of entries) {
    if (entry.dirtyReasons.size === 0) {
      continue;
    }

    if (!entry.canProcessDirtyReasons(entry.dirtyReasons)) {
      continue;
    }

    if (entry.dirtyReasons.delete('resize') && entry.onResizeObserved) {
      const proposedGeometry = entry.fitAddon.proposeDimensions();
      if (proposedGeometry && !isSameTerminalGeometry(proposedGeometry, entry.term)) {
        entry.onResizeObserved(proposedGeometry);
      }

      if (entry.dirtyReasons.size > 0) {
        needsFollowUpFlush = true;
      }

      continue;
    }

    if (
      entry.dirtyReasons.size === 1 &&
      entry.dirtyReasons.has('intersection') &&
      typeof entry.fitAddon.proposeDimensions === 'function'
    ) {
      const proposedGeometry = entry.fitAddon.proposeDimensions();
      if (proposedGeometry && isSameTerminalGeometry(proposedGeometry, entry.term)) {
        entry.dirtyReasons.clear();
        continue;
      }
    }

    entry.dirtyReasons.clear();
    const previousCols = entry.term.cols;
    const previousRows = entry.term.rows;
    entry.fitAddon.fit();
    recordTerminalFitExecution({
      geometryChanged: previousCols !== entry.term.cols || previousRows !== entry.term.rows,
      source: 'manager',
    });
    didWork = true;
  }
  recordTerminalFitFlush(didWork);
  // Only update throttle timestamp when we actually fitted something —
  // a no-op flush should not delay the next real fit.
  if (didWork) {
    lastFlushTime = performance.now();
  }
  if (needsFollowUpFlush) {
    scheduleFlush(0, false);
  }
}

function scheduleFlush(delayMs = THROTTLE_MS, allowImmediate = true): void {
  // Leading edge: fit immediately if enough time has passed since last fit
  if (allowImmediate && performance.now() - lastFlushTime >= THROTTLE_MS) {
    if (rafId === undefined) {
      rafId = requestAnimationFrame(() => {
        rafId = undefined;
        flush();
      });
    }
  }

  // Trailing edge: always schedule a delayed fit so the final resize is captured
  if (trailingTimer !== undefined) clearTimeout(trailingTimer);
  trailingTimer = window.setTimeout(() => {
    trailingTimer = undefined;
    if (rafId !== undefined) return;
    rafId = requestAnimationFrame(() => {
      rafId = undefined;
      flush();
    });
  }, delayMs);
}

export function registerTerminal(
  id: string,
  container: HTMLElement,
  fitAddon: FitAddon,
  term: Terminal,
  canProcessDirtyReasons: (dirtyReasons: ReadonlySet<TerminalFitDirtyReason>) => boolean = () =>
    true,
  onResizeObserved?: (geometry: TerminalGeometry) => void,
): void {
  const entry: TerminalEntry = {
    canProcessDirtyReasons,
    container,
    dirtyReasons: new Set(),
    fitAddon,
    onResizeObserved,
    term,
  };
  entries.set(id, entry);
  entryByContainer.set(container, entry);
  resizeObserver.observe(container);
  intersectionObserver.observe(container);
}

export function unregisterTerminal(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  resizeObserver.unobserve(entry.container);
  intersectionObserver.unobserve(entry.container);
  entryByContainer.delete(entry.container);
  entries.delete(id);
}

export function markDirty(id: string, reason: TerminalFitDirtyReason = 'unknown'): void {
  const entry = entries.get(id);
  if (entry) {
    markEntryDirty(entry, reason);
    scheduleFlush();
  }
}

export function scheduleFitIfDirty(id: string): void {
  const entry = entries.get(id);
  if (entry && entry.dirtyReasons.size > 0) {
    scheduleFlush(0, false);
  }
}
