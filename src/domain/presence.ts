import type { PeerPresenceVisibility } from './server-state.js';

export type PresenceConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting';

export interface PresencePayload {
  activeTaskId: string | null;
  controllingAgentIds: string[];
  controllingTaskIds: string[];
  displayName: string;
  focusedSurface: string | null;
  type: 'update-presence';
  visibility: PeerPresenceVisibility;
}
