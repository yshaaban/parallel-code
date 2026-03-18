export function isTypingTaskCommandFocusedSurface(focusedSurface: string | null): boolean {
  if (
    focusedSurface === 'ai-terminal' ||
    focusedSurface === 'remote-terminal' ||
    focusedSurface === 'terminal'
  ) {
    return true;
  }

  return focusedSurface?.startsWith('shell:') === true;
}

export function getTaskCommandActionForFocusedSurface(
  focusedSurface: string | null,
  fallbackAction: string,
): string {
  if (focusedSurface === 'prompt') {
    return 'send a prompt';
  }

  if (isTypingTaskCommandFocusedSurface(focusedSurface)) {
    return 'type in the terminal';
  }

  return fallbackAction;
}
