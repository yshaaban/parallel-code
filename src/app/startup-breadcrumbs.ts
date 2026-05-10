declare global {
  interface Window {
    __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    __parallelCodeStartupBreadcrumbs?: StartupBreadcrumb[];
  }
}

export interface StartupBreadcrumb {
  atEpochMs: number;
  atMs: number;
  label: string;
}

function isStartupBreadcrumbLoggingEnabled(): boolean {
  return (
    typeof window !== 'undefined' && window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ === true
  );
}

function getStartupBreadcrumbAtMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }

  return Date.now();
}

export function emitStartupBreadcrumb(label: string): void {
  if (!isStartupBreadcrumbLoggingEnabled()) {
    return;
  }

  window.__parallelCodeStartupBreadcrumbs ??= [];
  window.__parallelCodeStartupBreadcrumbs.push({
    atEpochMs: Date.now(),
    atMs: getStartupBreadcrumbAtMs(),
    label,
  });
  console.warn(`[startup] ${label}`);
}
