const TERMINAL_CREATE_DEBOUNCE_BUFFER_MS = 350;
const TERMINAL_CREATE_FALLBACK_TIMEOUT_MS = 15_000;
const TERMINAL_CREATE_RETRY_TIMEOUT_MS = 5_000;

interface WaitForShellTerminalCreationOptions {
  clickCreateTerminal: () => Promise<void>;
  waitForCreationSignal: (timeoutMs: number) => Promise<boolean>;
}

export async function waitForShellTerminalCreation(
  options: WaitForShellTerminalCreationOptions,
): Promise<void> {
  await options.clickCreateTerminal();

  if (await options.waitForCreationSignal(TERMINAL_CREATE_DEBOUNCE_BUFFER_MS)) {
    return;
  }

  if (await options.waitForCreationSignal(TERMINAL_CREATE_FALLBACK_TIMEOUT_MS)) {
    return;
  }

  await options.clickCreateTerminal();

  if (await options.waitForCreationSignal(TERMINAL_CREATE_RETRY_TIMEOUT_MS)) {
    return;
  }

  throw new Error('Timed out waiting for shell terminal creation');
}
