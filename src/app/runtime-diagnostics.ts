import {
  SERVER_STATE_BOOTSTRAP_CATEGORIES,
  type ServerStateBootstrapCategory,
} from '../domain/server-state-bootstrap';

interface CategoryCounters {
  [category: string]: number;
}

export interface RendererRuntimeDiagnosticsSnapshot {
  bootstrap: {
    bufferedEvents: CategoryCounters;
    bufferedSnapshots: CategoryCounters;
    completions: number;
    lastDurationMs: number | null;
  };
  browserSync: {
    completed: number;
    failed: number;
    lastDurationMs: number | null;
    scheduled: number;
    started: number;
    superseded: number;
  };
}

function createCategoryCounters(): CategoryCounters {
  return Object.fromEntries(SERVER_STATE_BOOTSTRAP_CATEGORIES.map((category) => [category, 0]));
}

let rendererRuntimeDiagnostics: RendererRuntimeDiagnosticsSnapshot = createInitialSnapshot();

function createInitialSnapshot(): RendererRuntimeDiagnosticsSnapshot {
  return {
    bootstrap: {
      bufferedEvents: createCategoryCounters(),
      bufferedSnapshots: createCategoryCounters(),
      completions: 0,
      lastDurationMs: null,
    },
    browserSync: {
      completed: 0,
      failed: 0,
      lastDurationMs: null,
      scheduled: 0,
      started: 0,
      superseded: 0,
    },
  };
}

function cloneDiagnostics(): RendererRuntimeDiagnosticsSnapshot {
  return {
    bootstrap: {
      bufferedEvents: { ...rendererRuntimeDiagnostics.bootstrap.bufferedEvents },
      bufferedSnapshots: { ...rendererRuntimeDiagnostics.bootstrap.bufferedSnapshots },
      completions: rendererRuntimeDiagnostics.bootstrap.completions,
      lastDurationMs: rendererRuntimeDiagnostics.bootstrap.lastDurationMs,
    },
    browserSync: { ...rendererRuntimeDiagnostics.browserSync },
  };
}

function incrementCategoryCounter(
  counters: CategoryCounters,
  category: ServerStateBootstrapCategory,
): void {
  counters[category] = (counters[category] ?? 0) + 1;
}

export function resetRendererRuntimeDiagnostics(): void {
  rendererRuntimeDiagnostics = createInitialSnapshot();
}

export function getRendererRuntimeDiagnosticsSnapshot(): RendererRuntimeDiagnosticsSnapshot {
  return cloneDiagnostics();
}

export function recordBufferedBootstrapEvent(category: ServerStateBootstrapCategory): void {
  incrementCategoryCounter(rendererRuntimeDiagnostics.bootstrap.bufferedEvents, category);
}

export function recordBufferedBootstrapSnapshot(category: ServerStateBootstrapCategory): void {
  incrementCategoryCounter(rendererRuntimeDiagnostics.bootstrap.bufferedSnapshots, category);
}

export function recordBootstrapCompletion(durationMs: number): void {
  rendererRuntimeDiagnostics.bootstrap.completions += 1;
  rendererRuntimeDiagnostics.bootstrap.lastDurationMs = durationMs;
}

export function recordBrowserSyncScheduled(): void {
  rendererRuntimeDiagnostics.browserSync.scheduled += 1;
}

export function recordBrowserSyncStarted(): void {
  rendererRuntimeDiagnostics.browserSync.started += 1;
}

export function recordBrowserSyncCompleted(durationMs: number): void {
  rendererRuntimeDiagnostics.browserSync.completed += 1;
  rendererRuntimeDiagnostics.browserSync.lastDurationMs = durationMs;
}

export function recordBrowserSyncFailed(durationMs: number): void {
  rendererRuntimeDiagnostics.browserSync.failed += 1;
  rendererRuntimeDiagnostics.browserSync.lastDurationMs = durationMs;
}

export function recordBrowserSyncSuperseded(): void {
  rendererRuntimeDiagnostics.browserSync.superseded += 1;
}
