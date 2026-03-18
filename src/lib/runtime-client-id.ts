import { getBrowserClientId, isElectronRuntime } from './browser-auth';
import { getStateSyncSourceId } from '../store/persistence';

export function getRuntimeClientId(): string {
  if (isElectronRuntime()) {
    return getStateSyncSourceId();
  }

  return getBrowserClientId();
}

export function getRuntimeLeaseOwnerId(): string {
  return getStateSyncSourceId();
}
