import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
