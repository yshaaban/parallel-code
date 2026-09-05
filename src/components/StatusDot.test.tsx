import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  afterEach(cleanup);

  it.each(['busy', 'restoring'] as const)('pairs the %s pulse with a static ring', (status) => {
    const result = render(() => <StatusDot status={status} />);
    const dot = result.container.firstElementChild;
    expect(dot?.classList.contains('status-dot-pulse')).toBe(true);
    expect(dot?.classList.contains('status-dot-ring')).toBe(true);
    expect((dot as HTMLElement | null)?.style.color).toBe(
      (dot as HTMLElement | null)?.style.background,
    );
  });

  it('leaves non-pulsing states unclassified', () => {
    const result = render(() => <StatusDot status="ready" />);
    const dot = result.container.firstElementChild;
    expect(dot?.classList.contains('status-dot-pulse')).toBe(false);
    expect(dot?.classList.contains('status-dot-ring')).toBe(false);
  });
});
