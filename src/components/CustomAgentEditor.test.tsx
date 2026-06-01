import { render, screen, waitFor } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '../store/store';
import { resetStoreForTest } from '../test/store-test-helpers';
import { CustomAgentEditor } from './CustomAgentEditor';

vi.mock('../lib/random-id', () => ({
  createRandomId: vi.fn(() => '12345678-1234-4567-89ab-123456789abc'),
}));

describe('CustomAgentEditor', () => {
  beforeEach(() => {
    resetStoreForTest();
  });

  it('creates a removable custom agent id when the display name has no slug characters', async () => {
    const user = userEvent.setup();

    render(() => <CustomAgentEditor />);

    await user.click(screen.getByRole('button', { name: '+ Add custom agent' }));
    await user.type(screen.getByPlaceholderText('Name (e.g. OpenCode)'), '!!!');
    await user.type(screen.getByPlaceholderText('Command (e.g. opencode)'), 'codex "manual mode"');
    await user.click(screen.getByRole('button', { name: 'Add Agent' }));

    await waitFor(() => {
      expect(store.customAgents).toHaveLength(1);
    });
    expect(store.customAgents[0]).toMatchObject({
      args: ['manual mode'],
      command: 'codex',
      id: 'custom-agent-12345678',
      name: '!!!',
    });
  });

  it('clears command parse errors as the user fixes the input', async () => {
    const user = userEvent.setup();

    render(() => <CustomAgentEditor />);

    await user.click(screen.getByRole('button', { name: '+ Add custom agent' }));
    await user.type(screen.getByPlaceholderText('Name (e.g. OpenCode)'), 'Codex Manual');
    const commandInput = screen.getByPlaceholderText('Command (e.g. opencode)');
    await user.type(commandInput, 'codex "unfinished');
    await user.click(screen.getByRole('button', { name: 'Add Agent' }));

    expect(screen.getByText('Command has an unterminated quote or escape.')).toBeDefined();

    await user.type(commandInput, '"');

    expect(screen.queryByText('Command has an unterminated quote or escape.')).toBeNull();
  });
});
