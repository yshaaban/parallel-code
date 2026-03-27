import {
  getTerminalExperimentDrainBudgetOverride,
  getTerminalExperimentDrainCandidateLimitOverride,
  getTerminalPerformanceExperimentConfig,
} from './terminal-performance-experiments';

export type TerminalOutputPriority =
  | 'focused'
  | 'switch-target-visible'
  | 'active-visible'
  | 'visible-background'
  | 'hidden';

export type TerminalWebglPriority = 'focused' | 'visible' | 'background' | 'hidden';

export interface TerminalOutputPriorityContext {
  isActiveTask: boolean;
  isFocused: boolean;
  isRestoring: boolean;
  isSwitchTarget: boolean;
  isVisible: boolean;
}

const TERMINAL_OUTPUT_PRIORITY_ORDER = {
  focused: 0,
  'switch-target-visible': 1,
  'active-visible': 2,
  'visible-background': 3,
  hidden: 4,
} satisfies Record<TerminalOutputPriority, number>;

const DEFAULT_TERMINAL_OUTPUT_DRAIN_BUDGET_BYTES = {
  focused: 96 * 1024,
  'switch-target-visible': 64 * 1024,
  'active-visible': 48 * 1024,
  'visible-background': 16 * 1024,
  hidden: 8 * 1024,
} satisfies Record<TerminalOutputPriority, number>;

const DEFAULT_TERMINAL_STATUS_FLUSH_DELAY_MS = {
  focused: 0,
  'switch-target-visible': 40,
  'active-visible': 120,
  'visible-background': 400,
  hidden: 1_200,
} satisfies Record<TerminalOutputPriority, number>;

const TERMINAL_WEBGL_PRIORITY_BY_OUTPUT_PRIORITY = {
  focused: 'focused',
  'switch-target-visible': 'visible',
  'active-visible': 'visible',
  'visible-background': 'background',
  hidden: 'hidden',
} satisfies Record<TerminalOutputPriority, TerminalWebglPriority>;

export function getTerminalOutputPriority(
  context: TerminalOutputPriorityContext,
): TerminalOutputPriority {
  if (context.isFocused) {
    return 'focused';
  }

  if (context.isVisible && context.isSwitchTarget) {
    return 'switch-target-visible';
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
  return TERMINAL_OUTPUT_PRIORITY_ORDER[priority];
}

export function getTerminalOutputDrainBudget(
  priority: TerminalOutputPriority,
  visibleTerminalCount = 0,
): number {
  const override = getTerminalExperimentDrainBudgetOverride(priority, visibleTerminalCount);
  if (override !== null) {
    return override;
  }

  return DEFAULT_TERMINAL_OUTPUT_DRAIN_BUDGET_BYTES[priority];
}

export function getTerminalOutputDrainCandidateLimit(
  priority: TerminalOutputPriority,
  visibleTerminalCount = 0,
): number | null {
  return getTerminalExperimentDrainCandidateLimitOverride(priority, visibleTerminalCount);
}

export function getTerminalStatusFlushDelayMs(priority: TerminalOutputPriority): number {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const override = experimentConfig.statusFlushDelayOverridesMs[priority];
  if (override !== undefined) {
    return override;
  }

  return DEFAULT_TERMINAL_STATUS_FLUSH_DELAY_MS[priority];
}

export function getTerminalWebglPriority(priority: TerminalOutputPriority): TerminalWebglPriority {
  return TERMINAL_WEBGL_PRIORITY_BY_OUTPUT_PRIORITY[priority];
}
