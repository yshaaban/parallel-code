import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/platform', () => ({ isMac: false }));

import { TERMINAL_SEARCH_QUERY_LIMIT } from '../lib/terminal-search';
import { getTerminalSearchResultLabel, TerminalSearchOverlay } from './TerminalSearchOverlay';

function renderOverlay(overrides: Partial<Parameters<typeof TerminalSearchOverlay>[0]> = {}) {
  const props = {
    focusVersion: 0,
    loading: false,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onQueryChange: vi.fn(),
    query: 'needle',
    result: { count: 3, index: 0 },
    unavailable: false,
    ...overrides,
  };
  const rendered = render(() => <TerminalSearchOverlay {...props} />);
  return { ...rendered, props };
}

afterEach(cleanup);

describe('TerminalSearchOverlay', () => {
  it.each([
    ['', { count: 0, index: -1 }, false, false, ''],
    ['x', { count: 0, index: -1 }, true, false, 'Searching…'],
    ['x', { count: 0, index: -1 }, false, true, 'Search unavailable'],
    ['x', { count: 0, index: -1 }, false, false, 'No results'],
    ['x', { count: 1, index: -1 }, false, false, '1 match'],
    ['x', { count: 2, index: -1 }, false, false, '2 matches'],
    ['x', { count: 3, index: 1 }, false, false, '2/3'],
    ['x', { count: 1_000, index: 2 }, false, false, '1,000 matches (display limit)'],
  ])('formats a stable result label', (query, result, loading, unavailable, expected) => {
    expect(getTerminalSearchResultLabel(query, result, { loading, unavailable })).toBe(expected);
  });

  it('renders a labelled search region and focuses/selects its bounded input', async () => {
    const { getByLabelText, getByRole } = renderOverlay();
    const input = getByLabelText('Find in terminal') as HTMLInputElement;
    await Promise.resolve();

    expect(getByRole('search')).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('needle'.length);
    expect(input.maxLength).toBe(TERMINAL_SEARCH_QUERY_LIMIT);
  });

  it('bounds query input and keeps Enter navigation local to the input', () => {
    const { getByLabelText, props } = renderOverlay();
    const input = getByLabelText('Find in terminal') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'x'.repeat(TERMINAL_SEARCH_QUERY_LIMIT + 10) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(getByLabelText('Next terminal match'), { key: 'Enter' });

    expect(props.onQueryChange).toHaveBeenCalledWith('x'.repeat(TERMINAL_SEARCH_QUERY_LIMIT));
    expect(props.onNavigate).toHaveBeenNthCalledWith(1, 'next');
    expect(props.onNavigate).toHaveBeenNthCalledWith(2, 'previous');
    expect(props.onNavigate).toHaveBeenCalledTimes(2);
  });

  it('handles repeated primary Find from any control without reopening', async () => {
    const { getByLabelText, props } = renderOverlay();
    const input = getByLabelText('Find in terminal') as HTMLInputElement;
    const next = getByLabelText('Next terminal match');
    next.focus();
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'f',
    });
    next.dispatchEvent(event);
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('needle'.length);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('isolates Escape from ancestors and keeps close available during failure', () => {
    const parentKeyDown = vi.fn();
    const props = {
      focusVersion: 0,
      loading: false,
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      onQueryChange: vi.fn(),
      query: 'needle',
      result: { count: 0, index: -1 },
      unavailable: true,
    };
    const { getByLabelText, getByText } = render(() => (
      <div onKeyDown={parentKeyDown}>
        <TerminalSearchOverlay {...props} />
      </div>
    ));
    const next = getByLabelText('Next terminal match') as HTMLButtonElement;
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    });
    next.dispatchEvent(event);

    expect(getByText('Search unavailable')).toBeTruthy();
    expect(next.disabled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect((getByLabelText('Close terminal search') as HTMLButtonElement).disabled).toBe(false);
  });

  it('prevents mouse navigation controls from stealing query focus', async () => {
    const { getByLabelText, props } = renderOverlay();
    const input = getByLabelText('Find in terminal') as HTMLInputElement;
    await Promise.resolve();
    const next = getByLabelText('Next terminal match');
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    next.dispatchEvent(mouseDown);
    fireEvent.click(next);

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(props.onNavigate).toHaveBeenCalledWith('next');
  });
});
