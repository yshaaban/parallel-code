import type { GitStatusSyncEvent } from '../domain/server-state';
import { isElectronRuntime, listenServerMessage } from '../lib/ipc';
import { listenGitStatusChanged } from '../lib/ipc-events';

export function listenForGitStatusChanged(
  listener: (message: GitStatusSyncEvent) => void,
): () => void {
  if (isElectronRuntime()) {
    return listenGitStatusChanged(listener);
  }

  return listenServerMessage('git-status-changed', (message) => {
    listener(message);
  });
}
