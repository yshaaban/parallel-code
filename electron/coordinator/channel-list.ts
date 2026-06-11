import { IPC } from '../ipc/channels.js';

// Import-light list of the IPC channels served by createCoordinatorIpcHandlers
// so handlers.ts can bind lazy wrappers without importing the coordinator
// module graph at boot.

export const COORDINATOR_IPC_CHANNELS: readonly IPC[] = [
  IPC.CoordinatorActivityHint,
  IPC.CoordinatorCreateRun,
  IPC.CoordinatorGetDiagnostics,
  IPC.CoordinatorToolCall,
  IPC.CoordinatorUiToolCall,
];
