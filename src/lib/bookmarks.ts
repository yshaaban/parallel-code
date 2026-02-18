/** Extract a short label from a command string. */
export function extractLabel(command: string): string {
  const words = command.trim().split(/\s+/);
  // Walk backwards, skip flags (words starting with -)
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (w.startsWith("-")) continue;
    // Strip path prefixes and file extensions
    const base = w.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
    if (base) return base;
  }
  return words[0] ?? "cmd";
}

/** Ephemeral map for passing initial commands from spawn to TerminalView. */
const pendingCommands = new Map<string, string>();

export function setPendingShellCommand(shellId: string, command: string): void {
  pendingCommands.set(shellId, command);
}

export function consumePendingShellCommand(shellId: string): string | undefined {
  const cmd = pendingCommands.get(shellId);
  if (cmd !== undefined) pendingCommands.delete(shellId);
  return cmd;
}
