import { describe, expect, it, vi } from 'vitest';

import { waitForShellTerminalTileInsertion } from '../browser/harness/terminal-creation.js';

describe('waitForShellTerminalTileInsertion', () => {
  it('waits longer without clicking twice when terminal creation is slow', async () => {
    const clickCreateTerminal = vi.fn(async () => undefined);
    const waitForCreationSignal = vi
      .fn<(_: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await waitForShellTerminalTileInsertion({
      clickCreateTerminal,
      waitForCreationSignal,
    });

    expect(clickCreateTerminal).toHaveBeenCalledTimes(1);
    expect(waitForCreationSignal).toHaveBeenCalledTimes(2);
    expect(waitForCreationSignal).toHaveBeenNthCalledWith(1, 350);
    expect(waitForCreationSignal).toHaveBeenNthCalledWith(2, 25_000);
  });

  it('throws when terminal creation never completes', async () => {
    const clickCreateTerminal = vi.fn(async () => undefined);
    const waitForCreationSignal = vi.fn<(_: number) => Promise<boolean>>().mockResolvedValue(false);

    await expect(
      waitForShellTerminalTileInsertion({
        clickCreateTerminal,
        waitForCreationSignal,
      }),
    ).rejects.toThrow('Timed out waiting for shell terminal tile insertion');

    expect(clickCreateTerminal).toHaveBeenCalledTimes(2);
    expect(waitForCreationSignal).toHaveBeenCalledTimes(3);
    expect(waitForCreationSignal).toHaveBeenNthCalledWith(1, 350);
    expect(waitForCreationSignal).toHaveBeenNthCalledWith(2, 25_000);
    expect(waitForCreationSignal).toHaveBeenNthCalledWith(3, 10_000);
  });

  it('retries once after a full missed creation signal and succeeds on the second click', async () => {
    const clickCreateTerminal = vi.fn(async () => undefined);
    const waitForCreationSignal = vi
      .fn<(_: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await waitForShellTerminalTileInsertion({
      clickCreateTerminal,
      waitForCreationSignal,
    });

    expect(clickCreateTerminal).toHaveBeenCalledTimes(2);
    expect(waitForCreationSignal).toHaveBeenCalledTimes(3);
  });
});
