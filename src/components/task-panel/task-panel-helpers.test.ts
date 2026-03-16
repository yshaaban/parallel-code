import { describe, expect, it } from 'vitest';
import {
  getAgentStatusBadgeColor,
  getAgentStatusBadgeText,
  shouldShowAgentStatusBadge,
} from './task-panel-helpers';

describe('task panel status badges', () => {
  it('maps agent statuses exhaustively', () => {
    expect(getAgentStatusBadgeText('running')).toBeNull();
    expect(getAgentStatusBadgeText('paused')).toBe('Paused');
    expect(getAgentStatusBadgeText('flow-controlled')).toBe('Flow controlled');
    expect(getAgentStatusBadgeText('restoring')).toBe('Restoring');
    expect(getAgentStatusBadgeText('exited')).toBeNull();

    expect(shouldShowAgentStatusBadge('running')).toBe(false);
    expect(shouldShowAgentStatusBadge('paused')).toBe(true);
    expect(shouldShowAgentStatusBadge('flow-controlled')).toBe(true);
    expect(shouldShowAgentStatusBadge('restoring')).toBe(true);
    expect(shouldShowAgentStatusBadge('exited')).toBe(false);

    expect(getAgentStatusBadgeColor('paused')).not.toBe(getAgentStatusBadgeColor('running'));
    expect(getAgentStatusBadgeColor('restoring')).not.toBe(getAgentStatusBadgeColor('running'));
  });
});
