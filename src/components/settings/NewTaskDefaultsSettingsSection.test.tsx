import { render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import type { NewTaskDefaultKey, NewTaskDefaults } from '../../domain/new-task-defaults';
import { NewTaskDefaultsSettingsSection } from './NewTaskDefaultsSettingsSection';

describe('NewTaskDefaultsSettingsSection', () => {
  it('renders exact descriptions and exposes both controls programmatically', () => {
    render(() => (
      <NewTaskDefaultsSettingsSection
        defaults={{ skipPermissions: true, stepsTracking: false }}
        onChange={() => {}}
      />
    ));

    const steps = screen.getByRole('checkbox', { name: 'Track task steps' });
    const permissions = screen.getByRole('checkbox', {
      name: 'Dangerously skip all confirms',
    });

    expect((steps as HTMLInputElement).checked).toBe(false);
    expect((permissions as HTMLInputElement).checked).toBe(true);
    const stepsDescriptionId = steps.getAttribute('aria-describedby');
    expect(stepsDescriptionId).not.toBeNull();
    expect(document.getElementById(stepsDescriptionId ?? '')?.textContent).toBe(
      'Watch .claude/steps.json for every new task unless you turn it off in the task dialog.',
    );
    expect(
      screen.getByText(
        'Runs without asking for confirmation. The agent can read, write, delete, and execute commands without your approval. Applies only to supported agent tasks.',
      ),
    ).toBeDefined();
    expect(permissions.getAttribute('aria-describedby')).not.toBeNull();
  });

  it('supports mouse and keyboard changes through one typed callback', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(key: NewTaskDefaultKey, enabled: boolean) => void>();
    const [defaults, setDefaults] = createSignal<NewTaskDefaults>({
      skipPermissions: true,
      stepsTracking: false,
    });
    const handleChange = (key: NewTaskDefaultKey, enabled: boolean): void => {
      onChange(key, enabled);
      setDefaults((current) => ({ ...current, [key]: enabled }));
    };

    render(() => <NewTaskDefaultsSettingsSection defaults={defaults()} onChange={handleChange} />);

    const steps = screen.getByRole('checkbox', { name: 'Track task steps' });
    await user.click(steps);
    expect(onChange).toHaveBeenCalledWith('stepsTracking', true);
    expect((steps as HTMLInputElement).checked).toBe(true);

    const permissions = screen.getByRole('checkbox', {
      name: 'Dangerously skip all confirms',
    });
    permissions.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith('skipPermissions', false);
    expect((permissions as HTMLInputElement).checked).toBe(false);
  });
});
