export type TerminalOutputPriority = 'focused' | 'active-visible' | 'visible-background' | 'hidden';

export type TerminalWebglPriority = 'focused' | 'visible' | 'background' | 'hidden';

export interface TerminalOutputPriorityContext {
  isActiveTask: boolean;
  isFocused: boolean;
  isRestoring: boolean;
  isVisible: boolean;
}

export function getTerminalOutputPriority(
  context: TerminalOutputPriorityContext,
): TerminalOutputPriority {
  if (context.isFocused) {
    return 'focused';
  }

  if (context.isVisible && (context.isActiveTask || context.isRestoring)) {
    return 'active-visible';
  }

  if (context.isVisible) {
    return 'visible-background';
  }

  return 'hidden';
}

export function getTerminalOutputPriorityOrder(priority: TerminalOutputPriority): number {
  switch (priority) {
    case 'focused':
      return 0;
    case 'active-visible':
      return 1;
    case 'visible-background':
      return 2;
    case 'hidden':
      return 3;
  }
}

export function getTerminalOutputDrainBudget(priority: TerminalOutputPriority): number {
  switch (priority) {
    case 'focused':
      return 96 * 1024;
    case 'active-visible':
      return 48 * 1024;
    case 'visible-background':
      return 16 * 1024;
    case 'hidden':
      return 8 * 1024;
  }
}

export function getTerminalStatusFlushDelayMs(priority: TerminalOutputPriority): number {
  switch (priority) {
    case 'focused':
      return 0;
    case 'active-visible':
      return 120;
    case 'visible-background':
      return 400;
    case 'hidden':
      return 1_200;
  }
}

export function getTerminalWebglPriority(priority: TerminalOutputPriority): TerminalWebglPriority {
  switch (priority) {
    case 'focused':
      return 'focused';
    case 'active-visible':
      return 'visible';
    case 'visible-background':
      return 'background';
    case 'hidden':
      return 'hidden';
  }
}
