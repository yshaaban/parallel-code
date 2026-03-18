import { getPersistentClientId } from '../lib/client-id';

const REMOTE_CLIENT_ID_KEY = 'parallel-code-remote-client-id';

export function getRemoteClientId(): string {
  return getPersistentClientId(REMOTE_CLIENT_ID_KEY, 'remote-client');
}
