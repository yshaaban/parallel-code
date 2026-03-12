import { theme } from '../../lib/theme';
import type { AgentStatus, Task } from '../../store/types';

export function getPromptStatusText(task: Task): string {
  if (task.lastPrompt) return `> ${task.lastPrompt}`;
  if (task.initialPrompt) return 'Waiting to send prompt...';
  return 'No prompts sent';
}

export function getAgentStatusBadgeText(status: AgentStatus): string | null {
  switch (status) {
    case 'paused':
      return 'Paused';
    case 'flow-controlled':
      return 'Flow controlled';
    case 'restoring':
      return 'Restoring';
    default:
      return null;
  }
}

export function getAgentStatusBadgeColor(status: AgentStatus): string {
  switch (status) {
    case 'paused':
      return theme.warning;
    case 'restoring':
      return theme.accent;
    default:
      return theme.fgMuted;
  }
}

export function getShellCommand(): string {
  return '';
}
