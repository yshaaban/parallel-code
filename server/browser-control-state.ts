import { getServerStateBootstrap } from '../electron/ipc/server-state-bootstrap.js';
import { removeGitStatusSnapshot } from '../electron/ipc/git-status-state.js';
import type { StateBootstrapMessage } from '../electron/remote/protocol.js';
import type { RemotePresence } from '../src/domain/server-state.js';
import {
  createBrowserServerInfo,
  type BrowserRemoteStatus,
  type BrowserServerInfo,
} from './browser-server-info.js';

export interface BrowserControlState {
  createStateBootstrapMessage: () => StateBootstrapMessage;
  getRemoteStatus: () => BrowserRemoteStatus;
  getRemoteStatusVersion: () => number;
  getServerInfo: () => BrowserServerInfo;
  nextRemotePresence: () => RemotePresence;
  removeGitStatus: (worktreePath: string) => void;
}

export interface CreateBrowserControlStateOptions {
  getAuthenticatedClientCount: () => number;
  port: number;
  token: string;
}

export function createBrowserControlState(
  options: CreateBrowserControlStateOptions,
): BrowserControlState {
  const serverInfo = createBrowserServerInfo({
    getAuthenticatedClientCount: options.getAuthenticatedClientCount,
    port: options.port,
    token: options.token,
  });
  let remoteStatusVersion = 0;

  return {
    createStateBootstrapMessage: () => ({
      type: 'state-bootstrap',
      snapshots: getServerStateBootstrap({
        getRemoteStatus: serverInfo.getRemoteStatus,
        getRemoteStatusVersion: () => remoteStatusVersion,
      }),
    }),
    getRemoteStatus: serverInfo.getRemoteStatus,
    getRemoteStatusVersion: () => remoteStatusVersion,
    getServerInfo: serverInfo.getServerInfo,
    nextRemotePresence: () => {
      remoteStatusVersion += 1;
      return serverInfo.getRemoteStatus();
    },
    removeGitStatus: (worktreePath) => {
      removeGitStatusSnapshot(worktreePath);
    },
  };
}
