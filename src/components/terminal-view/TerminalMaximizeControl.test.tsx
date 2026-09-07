import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../Dialog';
import { TerminalSearchOverlay } from '../TerminalSearchOverlay';
import { TerminalMaximizeControl } from './TerminalMaximizeControl';

afterEach(cleanup);

function pane(label: string, lifecycle = { mount: vi.fn(), dispose: vi.fn() }) {
  let surface: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  onMount(lifecycle.mount);
  onCleanup(lifecycle.dispose);
  return (
    <div ref={surface} data-testid={label} style={{ height: '150px', overflow: 'hidden' }}>
      <textarea aria-label={label} ref={input} />
      <TerminalMaximizeControl
        surface={() => surface}
        searchOpen={false}
        focusTerminal={() => input?.focus()}
      />
    </div>
  );
}

describe('terminal maximize presentation', () => {
  it('retains exact DOM, draft, selection, scroll and lifetime over repeated maximize/restore', () => {
    const lifecycle = { mount: vi.fn(), dispose: vi.fn() };
    const result = render(() => (
      <div style={{ transform: 'translateX(0)', contain: 'paint', overflow: 'hidden' }}>
        {pane('Shell input', lifecycle)}
      </div>
    ));
    const surface = screen.getByTestId('Shell input');
    const parent = surface.parentElement;
    const originalStyle = parent?.getAttribute('style');
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Shell input' });
    input.value = 'unfinished command';
    input.focus();
    input.setSelectionRange(2, 7);
    input.scrollTop = 123;
    const blur = vi.fn();
    input.addEventListener('blur', blur);

    for (let cycle = 0; cycle < 3; cycle++) {
      fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));
      expect(surface.getAttribute('data-terminal-maximized')).toBe('true');
      expect(parent?.hasAttribute('data-terminal-maximize-ancestor')).toBe(true);
      expect(
        screen.getByRole('button', { name: 'Restore terminal' }).getAttribute('aria-pressed'),
      ).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Restore terminal' }));
      expect(surface.hasAttribute('data-terminal-maximized')).toBe(false);
      expect(parent?.hasAttribute('data-terminal-maximize-ancestor')).toBe(false);
      expect(parent?.getAttribute('style')).toBe(originalStyle);
      expect(screen.getByRole('textbox', { name: 'Shell input' })).toBe(input);
      expect(input.value).toBe('unfinished command');
      expect([input.selectionStart, input.selectionEnd, input.scrollTop]).toEqual([2, 7, 123]);
      expect(document.activeElement).toBe(input);
    }
    expect(blur).not.toHaveBeenCalled();
    expect(lifecycle.mount).toHaveBeenCalledOnce();
    expect(lifecycle.dispose).not.toHaveBeenCalled();
    result.unmount();
    expect(lifecycle.dispose).toHaveBeenCalledOnce();
  });

  it('switches exact targets and cleans up when the active pane is removed', () => {
    const [visible, setVisible] = createSignal(true);
    const result = render(() => (
      <div>
        <Show when={visible()}>{pane('First')}</Show>
        {pane('Second')}
      </div>
    ));
    const first = screen.getByTestId('First');
    const second = screen.getByTestId('Second');
    fireEvent.click(first.querySelector('button') as HTMLButtonElement);
    fireEvent.click(second.querySelector('button') as HTMLButtonElement);
    expect(first.hasAttribute('data-terminal-maximized')).toBe(false);
    expect(second.hasAttribute('data-terminal-maximized')).toBe(true);
    fireEvent.click(first.querySelector('button') as HTMLButtonElement);
    expect(second.hasAttribute('data-terminal-maximized')).toBe(false);
    setVisible(false);
    expect(document.querySelector('[data-terminal-maximized]')).toBeNull();
    expect(document.querySelector('[data-terminal-maximize-ancestor]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));
    expect(second.hasAttribute('data-terminal-maximized')).toBe(true);
    result.unmount();
    expect(document.querySelector('[data-terminal-maximize-ancestor]')).toBeNull();
  });

  it('consumes only an unmodified non-composing Escape before terminal input handlers', () => {
    render(() => pane('Terminal'));
    const input = screen.getByRole('textbox');
    const receiveTerminalKey = vi.fn();
    input.addEventListener('keydown', receiveTerminalKey);
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));
    for (const options of [
      { isComposing: true },
      { keyCode: 229 },
      { repeat: true },
      { altKey: true },
    ]) {
      fireEvent.keyDown(input, { key: 'Escape', ...options });
      expect(screen.getByRole('button', { name: 'Restore terminal' })).toBeDefined();
    }
    receiveTerminalKey.mockClear();
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(receiveTerminalKey).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Maximize terminal' })).toBeDefined();
    expect(document.activeElement).toBe(input);
  });

  it('lets a nested dialog own Escape before restoring the terminal', async () => {
    const [open, setOpen] = createSignal(false);
    render(() => (
      <>
        {pane('Terminal')}
        <Dialog open={open()} onClose={() => setOpen(false)}>
          <input aria-label="Dialog input" />
        </Dialog>
      </>
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));
    setOpen(true);
    const dialogInput = screen.getByRole('textbox', { name: 'Dialog input' });
    dialogInput.focus();
    fireEvent.keyDown(dialogInput, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore terminal' })).toBeDefined();
    const terminal = screen.getByRole('textbox', { name: 'Terminal' });
    await waitFor(() => expect(document.activeElement).toBe(terminal));
    fireEvent.keyDown(terminal, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Maximize terminal' })).toBeDefined();
  });

  it('lets search own the first Escape without restoring or sending it to the terminal', () => {
    let surface: HTMLDivElement | undefined;
    let input: HTMLTextAreaElement | undefined;
    const [search, setSearch] = createSignal(false);
    render(() => (
      <div ref={surface}>
        <textarea aria-label="Terminal" ref={input} />
        <TerminalMaximizeControl
          surface={() => surface}
          searchOpen={search()}
          focusTerminal={() => input?.focus()}
        />
        <Show when={search()}>
          <TerminalSearchOverlay
            focusVersion={0}
            loading={false}
            query="kept query"
            result={{ count: 0, index: -1 }}
            unavailable={false}
            onClose={() => {
              setSearch(false);
              input?.focus();
            }}
            onNavigate={() => {}}
            onQueryChange={() => {}}
          />
        </Show>
      </div>
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));
    setSearch(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find in terminal' }), { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore terminal' })).toBeDefined();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Terminal' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Maximize terminal' })).toBeDefined();
  });

  it('restores when keyboard navigation chooses another pane without stealing its focus', () => {
    render(() => (
      <>
        {pane('Terminal')}
        <input aria-label="Prompt draft" />
      </>
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal' }));
    const prompt = screen.getByRole('textbox', { name: 'Prompt draft' });
    prompt.focus();
    expect(screen.getByRole('button', { name: 'Maximize terminal' })).toBeDefined();
    expect(document.activeElement).toBe(prompt);
  });
});
