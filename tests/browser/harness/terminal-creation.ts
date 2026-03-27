const TERMINAL_CREATE_DEBOUNCE_BUFFER_MS = 350;
const TERMINAL_CREATE_FALLBACK_TIMEOUT_MS = 15_000;

interface WaitForShellTerminalCreationOptions {
  clickCreateTerminal: () => Promise<void>;
  waitForTerminalCount: (timeoutMs: number) => Promise<boolean>;
}

export async function waitForShellTerminalCreation(
  options: WaitForShellTerminalCreationOptions,
): Promise<void> {
  await options.clickCreateTerminal();

  const createdWithinDebounceWindow = await options.waitForTerminalCount(
    TERMINAL_CREATE_DEBOUNCE_BUFFER_MS,
  );
  if (createdWithinDebounceWindow) {
    return;
  }

  const createdWithinFallbackWindow = await options.waitForTerminalCount(
    TERMINAL_CREATE_FALLBACK_TIMEOUT_MS,
  );
  if (createdWithinFallbackWindow) {
    return;
  }

  throw new Error('Timed out waiting for shell terminal creation');
}
