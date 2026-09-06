import type { JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

interface ContextBadgeProps {
  label: string;
  title: string;
  tone: string;
}

function ContextBadge(props: ContextBadgeProps): JSX.Element {
  return (
    <span
      aria-label={props.title}
      title={props.title}
      style={{
        ...typography.metaStrong,
        display: 'inline-flex',
        'align-items': 'center',
        padding: '1px 6px',
        'border-radius': '4px',
        background: `color-mix(in srgb, ${props.tone} 10%, transparent)`,
        color: props.tone,
        border: `1px solid color-mix(in srgb, ${props.tone} 20%, transparent)`,
        'flex-shrink': '0',
        'white-space': 'nowrap',
        'line-height': '1.45',
      }}
    >
      {props.label}
    </span>
  );
}

export function ProjectRootBadge(): JSX.Element {
  return (
    <ContextBadge
      label="root"
      title="Works directly in the project root; shares files and Git state with other project-root tasks"
      tone={theme.warning}
    />
  );
}

export function TerminalTaskBadge(): JSX.Element {
  return (
    <ContextBadge
      label="terminal"
      title="Terminal-only task with no AI agent"
      tone={theme.fgMuted}
    />
  );
}
