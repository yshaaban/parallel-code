import { theme } from '../../lib/theme';
import type { AgentStatus, Task } from '../../store/types';

interface AgentStatusBadge {
  color: string;
  text: string | null;
  visible: boolean;
}

const AGENT_STATUS_BADGES: Record<AgentStatus, AgentStatusBadge> = {
  running: {
    color: theme.fgMuted,
    text: null,
    visible: false,
  },
  paused: {
    color: theme.warning,
    text: 'Paused',
    visible: true,
  },
  'flow-controlled': {
    color: theme.fgMuted,
    text: 'Flow controlled',
    visible: true,
  },
  restoring: {
    color: theme.accent,
    text: 'Restoring',
    visible: true,
  },
  exited: {
    color: theme.fgMuted,
    text: null,
    visible: false,
  },
};

export function getPromptStatusText(task: Task): string {
  if (task.lastPrompt) return `> ${task.lastPrompt}`;
  if (task.initialPrompt) return 'Waiting to send prompt...';
  return 'No prompts sent';
}

export function getAgentStatusBadgeText(status: AgentStatus): string | null {
  return AGENT_STATUS_BADGES[status].text;
}

export function getAgentStatusBadgeColor(status: AgentStatus): string {
  return AGENT_STATUS_BADGES[status].color;
}

export function shouldShowAgentStatusBadge(status: AgentStatus): boolean {
  return AGENT_STATUS_BADGES[status].visible;
}

export function getShellCommand(): string {
  return '';
}
