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

/** Track which bookmark opened which shell: key = `${taskId}:${bookmarkId}`, value = shellId */
const bookmarkShells = new Map<string, string>();

function bookmarkKey(taskId: string, bookmarkId: string): string {
  return `${taskId}:${bookmarkId}`;
}

export function getBookmarkShell(taskId: string, bookmarkId: string): string | undefined {
  return bookmarkShells.get(bookmarkKey(taskId, bookmarkId));
}

export function setBookmarkShell(taskId: string, bookmarkId: string, shellId: string): void {
  bookmarkShells.set(bookmarkKey(taskId, bookmarkId), shellId);
}

export function clearBookmarkShellByShellId(shellId: string): void {
  // Each shell is associated with at most one bookmark, so we stop at the first match.
  for (const [key, value] of bookmarkShells) {
    if (value === shellId) {
      bookmarkShells.delete(key);
      return;
    }
  }
}
