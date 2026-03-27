import { describe, expect, it, vi } from 'vitest';

import { waitForShellTerminalCreation } from '../browser/harness/terminal-creation.js';

describe('waitForShellTerminalCreation', () => {
  it('waits longer without clicking twice when terminal creation is slow', async () => {
    const clickCreateTerminal = vi.fn(async () => undefined);
    const waitForTerminalCount = vi
      .fn<(_: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await waitForShellTerminalCreation({
      clickCreateTerminal,
      waitForTerminalCount,
    });

    expect(clickCreateTerminal).toHaveBeenCalledTimes(1);
    expect(waitForTerminalCount).toHaveBeenCalledTimes(2);
    expect(waitForTerminalCount).toHaveBeenNthCalledWith(1, 350);
    expect(waitForTerminalCount).toHaveBeenNthCalledWith(2, 15_000);
  });

  it('throws when terminal creation never completes', async () => {
    const clickCreateTerminal = vi.fn(async () => undefined);
    const waitForTerminalCount = vi.fn<(_: number) => Promise<boolean>>().mockResolvedValue(false);

    await expect(
      waitForShellTerminalCreation({
        clickCreateTerminal,
        waitForTerminalCount,
      }),
    ).rejects.toThrow('Timed out waiting for shell terminal creation');

    expect(clickCreateTerminal).toHaveBeenCalledTimes(1);
  });
});
