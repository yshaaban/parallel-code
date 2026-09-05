import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskActivityIndicator } from './TaskActivityIndicator';

describe('TaskActivityIndicator', () => {
  afterEach(cleanup);

  it.each(['live', 'restoring', 'starting', 'sending'] as const)(
    'pairs the %s pulse with a reduced-motion static ring',
    (status) => {
      const result = render(() => <TaskActivityIndicator status={status} />);
      const indicator = result.container.firstElementChild;
      expect(indicator?.classList.contains('status-dot-pulse')).toBe(true);
      expect(indicator?.classList.contains('status-dot-ring')).toBe(true);
      expect(indicator?.getAttribute('aria-label')).toBeTruthy();
    },
  );

  it('does not add motion classes to a static status', () => {
    const result = render(() => <TaskActivityIndicator status="idle" />);
    const indicator = result.container.firstElementChild;
    expect(indicator?.classList.contains('status-dot-pulse')).toBe(false);
    expect(indicator?.classList.contains('status-dot-ring')).toBe(false);
  });
});
