import {
  getChangedFileStatusCategory,
  type ChangedFileStatus,
  type ChangedFileStatusCategory,
} from '../domain/git-status';
import { theme } from './theme';

const STATUS_COLORS: Record<ChangedFileStatusCategory, string> = {
  added: theme.success,
  deleted: theme.error,
  modified: theme.warning,
};

export function getStatusColor(status: ChangedFileStatus): string {
  return STATUS_COLORS[getChangedFileStatusCategory(status)];
}
