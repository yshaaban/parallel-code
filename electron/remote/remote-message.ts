import type { ServerMessage } from './protocol.js';
import { isRemoteBaseServerMessage } from './remote-base-message.js';
import { isTaskCreationOperationServerMessage } from './task-creation-message.js';

export { isTaskCatalogDeltaMessage } from './remote-base-message.js';

/** Remote-only extensions stay out of the desktop/browser control guard and bundle. */
export function isRemoteServerMessage(value: unknown): value is ServerMessage {
  return isRemoteBaseServerMessage(value) || isTaskCreationOperationServerMessage(value);
}
