import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { DisplayNameDialog } from './DisplayNameDialog';

describe('DisplayNameDialog', () => {
  it('renders startup progress while background startup is still active', () => {
    render(() => (
      <DisplayNameDialog
        open
        allowClose={false}
        onSave={() => {}}
        startupSummary={{
          detail: 'Loading workspace state · 1 attaching',
          label: 'Restoring your workspace…',
        }}
      />
    ));

    expect(screen.getByText('Restoring your workspace…')).toBeDefined();
    expect(screen.getByText('Loading workspace state · 1 attaching')).toBeDefined();
  });
});
