// Shared failed-exit semantics for process exits. `server_unavailable` is a
// synthetic signal minted when the backend connection is lost, not a real
// process failure, so it stays exempt across every consumer.
export function isFailedProcessExit(
  exitCode: number | null | undefined,
  signal: string | null | undefined,
): boolean {
  return (
    (exitCode ?? 0) !== 0 ||
    (signal !== null && signal !== undefined && signal !== 'server_unavailable')
  );
}
