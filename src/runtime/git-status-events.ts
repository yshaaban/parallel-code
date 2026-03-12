import { IPC } from '../../electron/ipc/channels';
import type { GitStatusSyncEvent } from '../app/git-status-sync';
import { isElectronRuntime, listen, listenServerMessage } from '../lib/ipc';

export function listenForGitStatusChanged(
  listener: (message: GitStatusSyncEvent) => void,
): () => void {
  if (isElectronRuntime()) {
    return listen(IPC.GitStatusChanged, (payload: unknown) => {
      listener(payload as GitStatusSyncEvent);
    });
  }

  return listenServerMessage('git-status-changed', (message) => {
    listener(message);
  });
}
