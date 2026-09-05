import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { AppNotificationToast } from './AppNotificationToast';

describe('AppNotificationToast', () => {
  it('announces a transient warning without a persistent-notice dismiss control', () => {
    const { container } = render(() => (
      <AppNotificationToast
        notification={{ kind: 'warning', message: 'Restore this task before merging it.' }}
        onDismiss={vi.fn()}
      />
    ));

    expect(screen.getByRole('status').textContent).toContain(
      'Restore this task before merging it.',
    );
    expect(container.querySelector('[data-app-notification-kind="warning"]')).not.toBeNull();
    expect(screen.queryByLabelText('Dismiss notification')).toBeNull();
  });

  it('renders a persistent warning as warning status with an explicit dismiss control', () => {
    const onDismiss = vi.fn();
    const { container } = render(() => (
      <AppNotificationToast
        notification={{
          kind: 'warning',
          message: 'A local workspace edit was not applied.',
          persistent: true,
        }}
        onDismiss={onDismiss}
      />
    ));

    expect(screen.getByRole('status').textContent).toContain(
      'A local workspace edit was not applied.',
    );
    expect(container.querySelector('[data-app-notification-kind="warning"]')).not.toBeNull();
    screen.getByLabelText('Dismiss notification').click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
