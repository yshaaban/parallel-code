export type AppUpdateUnsupportedReason = 'browser' | 'not-configured';

export interface AppUpdateStatus {
  checkedAt: number | null;
  reason?: AppUpdateUnsupportedReason;
  status: 'unsupported';
  supported: false;
}

export function createUnsupportedAppUpdateStatus(
  reason: AppUpdateUnsupportedReason,
): AppUpdateStatus {
  return {
    checkedAt: null,
    reason,
    status: 'unsupported',
    supported: false,
  };
}
