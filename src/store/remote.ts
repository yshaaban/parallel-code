import { setStore } from './core';
export { refreshRemoteStatus, startRemoteAccess, stopRemoteAccess } from '../app/remote-access';

export function updateRemotePeerStatus(connectedClients: number, peerClients: number): void {
  setStore('remoteAccess', 'connectedClients', connectedClients);
  setStore('remoteAccess', 'peerClients', peerClients);
}
