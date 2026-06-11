import {
  getServerStateBootstrap,
  getServerStateBootstrapVersions,
} from '../electron/ipc/server-state-bootstrap.js';
import { getServerInstanceId } from '../electron/ipc/server-instance.js';
import { removeGitStatusSnapshot } from '../electron/ipc/git-status-state.js';
import type { StateBootstrapMessage } from '../electron/remote/protocol.js';
import type {
  ResyncVersionMap,
  ServerStateBootstrapCategory,
} from '../src/domain/server-state-bootstrap.js';
import type { PeerPresenceSnapshot, RemotePresence } from '../src/domain/server-state.js';
import {
  createBrowserServerInfo,
  type BrowserRemoteStatus,
  type BrowserServerInfo,
} from './browser-server-info.js';

export interface CreateStateBootstrapMessageOptions {
  categories?: ReadonlyArray<ServerStateBootstrapCategory>;
}

export interface BrowserControlState {
  createStateBootstrapMessage: (
    options?: CreateStateBootstrapMessageOptions,
  ) => StateBootstrapMessage;
  getServerStateVersions: () => ResyncVersionMap;
  getRemoteStatus: () => BrowserRemoteStatus;
  getRemoteStatusVersion: () => number;
  getServerInfo: () => BrowserServerInfo;
  nextRemotePresence: () => RemotePresence;
  removeGitStatus: (worktreePath: string) => void;
  setServerPort: (port: number) => void;
}

export interface CreateBrowserControlStateOptions {
  getPeerPresenceSnapshots: () => PeerPresenceSnapshot[];
  getPeerPresenceVersion: () => number;
  getAuthenticatedClientCount: () => number;
  port: number;
  token: string;
}

export function createBrowserControlState(
  options: CreateBrowserControlStateOptions,
): BrowserControlState {
  let serverPort = options.port;
  const serverInfo = createBrowserServerInfo({
    getAuthenticatedClientCount: options.getAuthenticatedClientCount,
    getPort: () => serverPort,
    token: options.token,
  });
  let remoteStatusVersion = 0;

  function getBootstrapContext(): Parameters<typeof getServerStateBootstrap>[0] {
    return {
      getPeerPresenceSnapshots: options.getPeerPresenceSnapshots,
      getPeerPresenceVersion: options.getPeerPresenceVersion,
      getRemoteStatus: serverInfo.getRemoteStatus,
      getRemoteStatusVersion: () => remoteStatusVersion,
    };
  }

  return {
    createStateBootstrapMessage: (messageOptions = {}) => ({
      type: 'state-bootstrap',
      snapshots: getServerStateBootstrap(
        getBootstrapContext(),
        messageOptions.categories === undefined ? {} : { categories: messageOptions.categories },
      ),
      serverInstanceId: getServerInstanceId(),
    }),
    getServerStateVersions: () => getServerStateBootstrapVersions(getBootstrapContext()),
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
    setServerPort: (port) => {
      serverPort = port;
    },
  };
}
