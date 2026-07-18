export const DEFAULT_GIT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

export function withDefaultGitExecTimeout<TOptions extends object>(
  options: TOptions & { timeout?: number | undefined },
): TOptions & { timeout: number } {
  return {
    ...options,
    // Keep unavoidable synchronous Git calls on one timeout policy. Buffered and streamed calls
    // use the stronger bounded-process owner because Node's timeout signal alone is not a
    // completion deadline. Callers can still opt out explicitly with `timeout: 0`.
    timeout: options.timeout ?? DEFAULT_GIT_EXEC_TIMEOUT_MS,
  };
}
