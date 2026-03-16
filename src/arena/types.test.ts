import { describe, expect, it } from 'vitest';
import { isExitedBattleCompetitorStatus, isRunningBattleCompetitorStatus } from './types';

describe('arena competitor status helpers', () => {
  it('maps running and exited states exhaustively', () => {
    expect(isRunningBattleCompetitorStatus('running')).toBe(true);
    expect(isRunningBattleCompetitorStatus('exited')).toBe(false);
    expect(isExitedBattleCompetitorStatus('running')).toBe(false);
    expect(isExitedBattleCompetitorStatus('exited')).toBe(true);
  });
});
