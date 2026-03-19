import type { CleanupFn, DesktopSessionResources } from './desktop-session-types';

export function createDesktopSessionResources(): DesktopSessionResources {
  return {
    cleanupBrowserRuntime: () => {},
    cleanupShortcuts: () => {},
    offPlanContent: () => {},
    unlistenCloseRequested: null,
  };
}

export function disposeCleanup(cleanup: CleanupFn): void {
  cleanup();
}

export function disposeOptionalCleanup(cleanup: CleanupFn | null): void {
  cleanup?.();
}

export function replaceDesktopSessionResource<T>(
  disposed: boolean,
  currentResource: T,
  nextResource: T,
  dispose: (resource: T) => void,
): T {
  if (disposed) {
    dispose(nextResource);
    return currentResource;
  }

  return nextResource;
}

export function disposeDesktopSessionResources(resources: DesktopSessionResources): void {
  disposeOptionalCleanup(resources.unlistenCloseRequested);
  resources.unlistenCloseRequested = null;
  disposeCleanup(resources.cleanupShortcuts);
  resources.cleanupShortcuts = () => {};
  disposeCleanup(resources.offPlanContent);
  resources.offPlanContent = () => {};
  disposeCleanup(resources.cleanupBrowserRuntime);
  resources.cleanupBrowserRuntime = () => {};
}
