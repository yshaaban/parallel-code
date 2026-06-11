import { createEffect, createRoot } from 'solid-js';
import { store } from '../store/state';
import { isAppStartupPresentationPending } from './app-startup-status';
import { createDebouncedWorkspaceShapePersist } from './workspace-shape-cache';

// Keeps the presentation-only workspace-shape cache fresh while the session is
// alive: any change to the project count, open task order, or task names
// schedules one debounced snapshot write. The returned cleanup disposes both
// the reactive subscription and any pending debounce timer.
export function startWorkspaceShapeCachePersistence(): () => void {
  const persist = createDebouncedWorkspaceShapePersist();

  const disposeRoot = createRoot((dispose) => {
    createEffect(() => {
      // The subscription registers before the awaited cold bootstrap, so the
      // store is still empty here. Never schedule a write while startup
      // presentation is pending or a slow (>1s) bootstrap would clobber the
      // returning user's cached shape with an empty one. The pending signal is
      // read reactively: when startup completes (or fails), the effect reruns
      // and persists the hydrated shape.
      if (isAppStartupPresentationPending()) {
        return;
      }

      void store.projects.length;
      for (const taskId of store.taskOrder) {
        void store.tasks[taskId]?.name;
      }

      persist.schedule();
    });

    return dispose;
  });

  return () => {
    disposeRoot();
    persist.dispose();
  };
}
