import { Show } from 'solid-js';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { PermissionRequest } from '../store/types';

interface PermissionCardProps {
  request: PermissionRequest;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

export function PermissionCard(props: PermissionCardProps) {
  const toolColors: Record<string, string> = {
    Edit: '#e8a838',
    Write: '#e8a838',
    Bash: '#e55',
    Read: '#4ec94e',
    Glob: '#4ec94e',
    Grep: '#4ec94e',
  };

  const toolColor = () => toolColors[props.request.tool] ?? theme.accent;

  return (
    <div
      style={{
        background: theme.bg,
        border: `1px solid ${toolColor()}50`,
        'border-left': `3px solid ${toolColor()}`,
        'border-radius': '8px',
        padding: 'var(--space-xs) var(--space-sm)',
        margin: 'var(--space-2xs) var(--space-sm) 0',
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--space-2xs)',
        ...typography.monoMeta,
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: 'var(--space-2xs)',
          'flex-wrap': 'wrap',
        }}
      >
        <span
          style={{
            background: toolColor() + '20',
            color: toolColor(),
            padding: '1px var(--space-xs)',
            'border-radius': '999px',
            ...typography.label,
          }}
        >
          {props.request.tool}
        </span>
        <span style={{ color: theme.fgMuted, ...typography.meta }}>Permission requested</span>
      </div>

      <Show when={props.request.arguments}>
        <div
          style={{
            color: theme.fg,
            padding: '2px var(--space-xs)',
            background: theme.taskPanelBg,
            'border-radius': '6px',
            'word-break': 'break-all',
            'max-height': '60px',
            overflow: 'auto',
            ...typography.meta,
          }}
        >
          {props.request.arguments}
        </div>
      </Show>

      <Show when={props.request.status === 'pending'}>
        <div style={{ display: 'flex', gap: 'var(--space-2xs)' }}>
          <button
            onClick={() => props.onApprove(props.request.id)}
            style={{
              background: '#4ec94e20',
              color: '#4ec94e',
              border: '1px solid #4ec94e50',
              'border-radius': '6px',
              padding: '2px var(--space-xs)',
              cursor: 'pointer',
              ...typography.metaStrong,
            }}
          >
            Approve
          </button>
          <button
            onClick={() => props.onDeny(props.request.id)}
            style={{
              background: '#e5555520',
              color: '#e55',
              border: '1px solid #e5555550',
              'border-radius': '6px',
              padding: '2px var(--space-xs)',
              cursor: 'pointer',
              ...typography.metaStrong,
            }}
          >
            Deny
          </button>
        </div>
      </Show>

      <Show when={props.request.status !== 'pending'}>
        <span
          style={{
            color: props.request.status === 'approved' ? '#4ec94e' : '#e55',
            ...typography.metaStrong,
          }}
        >
          {props.request.status === 'approved' ? '✓ Approved' : '✕ Denied'}
        </span>
      </Show>
    </div>
  );
}
