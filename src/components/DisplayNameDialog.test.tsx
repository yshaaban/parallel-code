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

  it('keeps the startup detail line mounted even when detail is absent', () => {
    render(() => (
      <DisplayNameDialog
        open
        allowClose={false}
        onSave={() => {}}
        startupSummary={{
          detail: null,
          label: 'Restoring your workspace…',
        }}
      />
    ));

    const status = screen.getByText('Restoring your workspace…').closest('[role="status"]');
    const detailLines = status?.querySelectorAll('span') ?? [];
    const detailLine = detailLines[detailLines.length - 1] as HTMLSpanElement | undefined;
    expect(detailLine).toBeTruthy();
    expect(detailLine?.style.visibility).toBe('hidden');
  });
});
