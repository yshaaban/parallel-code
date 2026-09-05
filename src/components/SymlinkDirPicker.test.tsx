import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SymlinkDirPicker } from './SymlinkDirPicker';

describe('SymlinkDirPicker', () => {
  it('renders a bounded, accessible candidate list with the safety disclosure', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { container } = render(() => (
      <SymlinkDirPicker
        dirs={['.claude', '.env']}
        error={null}
        onRetry={() => {}}
        onToggle={onToggle}
        selectedDirs={new Set(['.claude'])}
        status="ready"
        truncated
      />
    ));

    expect(
      screen.getByRole('group', { name: 'Share ignored files with this worktree' }),
    ).toBeDefined();
    expect(container.textContent).toContain(
      "Selected entries are linked from the project root. Their names are added to the repo's shared .git/info/exclude and remain ignored for all worktrees.",
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Showing 128 eligible entries; additional entries were not loaded.',
    );

    const defaultCandidate = screen.getByRole('checkbox', { name: '.claude' });
    const optionalCandidate = screen.getByRole('checkbox', { name: '.env' });
    expect((defaultCandidate as HTMLInputElement).checked).toBe(true);
    expect((optionalCandidate as HTMLInputElement).checked).toBe(false);
    expect(defaultCandidate.parentElement?.textContent).toBe('.claude');
    expect(optionalCandidate.parentElement?.textContent).toBe('.env');
    expect(defaultCandidate.closest('div')?.style.boxSizing).toBe('border-box');
    expect(defaultCandidate.closest('div')?.style.maxHeight).toBe('160px');
    expect(defaultCandidate.closest('div')?.style.overflowY).toBe('auto');

    await user.click(optionalCandidate);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledWith('.env');
  });

  it('shows a polite unavailable state and exposes one manual retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(() => (
      <SymlinkDirPicker
        dirs={[]}
        error="candidate query timed out"
        onRetry={onRetry}
        onToggle={() => {}}
        selectedDirs={new Set()}
        status="unavailable"
        truncated={false}
      />
    ));

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain(
      'Ignored file suggestions unavailable: candidate query timed out',
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows stable loading and empty-ready statuses without stealing focus', () => {
    const { unmount } = render(() => (
      <SymlinkDirPicker
        dirs={[]}
        error={null}
        onRetry={() => {}}
        onToggle={() => {}}
        selectedDirs={new Set()}
        status="loading"
        truncated={false}
      />
    ));

    expect(screen.getByRole('status').textContent).toBe('Checking ignored files…');
    unmount();

    render(() => (
      <SymlinkDirPicker
        dirs={[]}
        error={null}
        onRetry={() => {}}
        onToggle={() => {}}
        selectedDirs={new Set()}
        status="ready"
        truncated={false}
      />
    ));
    expect(screen.getByRole('status').textContent).toBe('No eligible ignored files found.');
  });
});
