declare global {
  interface Window {
    __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    __parallelCodeStartupBreadcrumbs?: string[];
  }
}

function isStartupBreadcrumbLoggingEnabled(): boolean {
  return (
    typeof window !== 'undefined' && window.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ === true
  );
}

export function emitStartupBreadcrumb(label: string): void {
  if (!isStartupBreadcrumbLoggingEnabled()) {
    return;
  }

  window.__parallelCodeStartupBreadcrumbs ??= [];
  window.__parallelCodeStartupBreadcrumbs.push(label);
  console.warn(`[startup] ${label}`);
}
