import { IPC } from '../../electron/ipc/channels';
import type { DiscoveredProject } from '../ipc/types';
import { invoke } from '../lib/ipc';
import { normalizeProjectPathKey } from '../lib/project-path-key';
import { setDiscoveredProjects } from '../store/projects';
import { store } from '../store/state';

interface RefreshDiscoveredProjectsOptions {
  force?: boolean;
}

let latestDiscoveredProjectsRefreshId = 0;

function nextDiscoveredProjectsRefreshId(): number {
  latestDiscoveredProjectsRefreshId += 1;
  return latestDiscoveredProjectsRefreshId;
}

function isLatestDiscoveredProjectsRefresh(refreshId: number): boolean {
  return refreshId === latestDiscoveredProjectsRefreshId;
}

/**
 * Fetch the backend-discovered project proposals (Claude/Codex activity + git repos) into the
 * store. Backed by a cached, startup-warmed backend scan, so this is cheap to call eagerly and
 * keeps the add-project dialog instant. Failures are non-fatal; the dialog falls back to Browse.
 */
export async function refreshDiscoveredProjects(
  options: RefreshDiscoveredProjectsOptions = {},
): Promise<void> {
  const refreshId = nextDiscoveredProjectsRefreshId();

  try {
    const request = options.force ? { force: true } : undefined;
    const discovered = await invoke(IPC.GetDiscoveredProjects, request);
    if (!isLatestDiscoveredProjectsRefresh(refreshId)) {
      return;
    }

    setDiscoveredProjects(discovered);
  } catch (error) {
    if (isLatestDiscoveredProjectsRefresh(refreshId)) {
      console.warn('[projects] Failed to refresh discovered projects:', error);
    }
  }
}

export function resetDiscoveredProjectsRefreshForTests(): void {
  latestDiscoveredProjectsRefreshId = 0;
}

/** Discovered projects that are not already added to the workspace. */
export function getUnaddedDiscoveredProjects(): DiscoveredProject[] {
  const addedPaths = new Set(
    store.projects.map((project) => normalizeProjectPathKey(project.path)),
  );
  return store.discoveredProjects.filter(
    (discovered) => !addedPaths.has(normalizeProjectPathKey(discovered.path)),
  );
}
