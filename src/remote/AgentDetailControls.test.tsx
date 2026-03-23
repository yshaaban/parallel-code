import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDetailControls } from './AgentDetailControls';

function renderControls(options?: {
  disabled?: boolean;
  disabledReason?: string | null;
  onCommandSent?: () => void;
  onQuickAction?: (data: string) => void;
  onSendText?: (text: string) => void;
}): void {
  render(() => (
    <AgentDetailControls
      agentMissing={false}
      disabled={options?.disabled ?? false}
      disabledReason={options?.disabledReason ?? null}
      fontSize={10}
      onCommandSent={options?.onCommandSent ?? vi.fn()}
      onFocusInput={vi.fn()}
      onHaptic={vi.fn()}
      onQuickAction={options?.onQuickAction ?? vi.fn()}
      onSendText={options?.onSendText ?? vi.fn()}
      onSetFontSize={vi.fn()}
    />
  ));
}

describe('AgentDetailControls', () => {
  afterEach(() => {
    cleanup();
  });

  it('submits text, dismisses the keyboard focus, and notifies the terminal to reveal output', () => {
    const onCommandSent = vi.fn();
    const onSendText = vi.fn();

    renderControls({ onCommandSent, onSendText });

    const input = screen.getByLabelText('Type a command for this agent') as HTMLInputElement;
    const blurSpy = vi.spyOn(input, 'blur');

    fireEvent.input(input, { target: { value: 'ls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send command' }));

    expect(onSendText).toHaveBeenCalledWith(`ls${String.fromCharCode(13)}`);
    expect(onCommandSent).toHaveBeenCalledTimes(1);
    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
  });

  it('submits from the mobile keyboard send action and still dismisses focus', () => {
    const onCommandSent = vi.fn();
    const onSendText = vi.fn();

    renderControls({ onCommandSent, onSendText });

    const input = screen.getByLabelText('Type a command for this agent') as HTMLInputElement;
    const blurSpy = vi.spyOn(input, 'blur');

    fireEvent.input(input, { target: { value: 'pwd' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendText).toHaveBeenCalledWith(`pwd${String.fromCharCode(13)}`);
    expect(onCommandSent).toHaveBeenCalledTimes(1);
    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
  });

  it('does not send whitespace-only input from the mobile keyboard submit path', () => {
    const onCommandSent = vi.fn();
    const onSendText = vi.fn();

    renderControls({ onCommandSent, onSendText });

    const input = screen.getByLabelText('Type a command for this agent') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSendText).not.toHaveBeenCalled();
    expect(onCommandSent).not.toHaveBeenCalled();
    expect(input.value).toBe('   ');
  });

  it('disables terminal entry while another session controls the task', () => {
    renderControls({
      disabled: true,
      disabledReason: 'Ivan typing controls this terminal.',
    });

    expect(screen.getByText('Ivan typing controls this terminal.')).toBeDefined();
    expect(
      (screen.getByLabelText('Type a command for this agent') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Send command' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps Shift Tab available as a terminal shortcut', () => {
    const onQuickAction = vi.fn();

    renderControls({ onQuickAction });

    fireEvent.click(screen.getByRole('button', { name: 'Send Shift Tab key' }));

    expect(onQuickAction).toHaveBeenCalledWith(`${String.fromCharCode(27)}[Z`);
  });

  it('keeps the command dock compact and removes filler copy', () => {
    renderControls();

    expect(screen.queryByText('Claude mode')).toBeNull();
    expect(screen.queryByText('Command line')).toBeNull();
    expect(screen.queryByText('Keys')).toBeNull();
    expect(screen.queryByText('Navigation')).toBeNull();
    expect(screen.queryByText('Signals')).toBeNull();
    expect(screen.queryByText('Text size')).toBeNull();
  });
});
