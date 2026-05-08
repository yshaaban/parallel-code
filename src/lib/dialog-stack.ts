import { createSignal } from 'solid-js';

const [dialogStack, setDialogStack] = createSignal<readonly string[]>([]);

export function pushDialog(id: string): void {
  setDialogStack((currentStack) =>
    currentStack.includes(id) ? currentStack : [...currentStack, id],
  );
}

export function popDialog(id: string): void {
  setDialogStack((currentStack) => currentStack.filter((dialogId) => dialogId !== id));
}

export function topDialog(): string | null {
  const currentStack = dialogStack();
  if (currentStack.length === 0) {
    return null;
  }

  return currentStack[currentStack.length - 1] ?? null;
}

export function isTopmostDialog(id: string): boolean {
  return topDialog() === id;
}

export function resetDialogStackForTests(): void {
  setDialogStack([]);
}
