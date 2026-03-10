import { Show } from 'solid-js';
import { theme } from '../lib/theme';
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
        'border-radius': '4px',
        padding: '8px 10px',
        margin: '4px 6px',
        'font-family': "'JetBrains Mono', monospace",
        'font-size': '11px',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
          'margin-bottom': '4px',
        }}
      >
        <span
          style={{
            background: toolColor() + '20',
            color: toolColor(),
            padding: '1px 6px',
            'border-radius': '3px',
            'font-size': '10px',
            'font-weight': 'bold',
          }}
        >
          {props.request.tool}
        </span>
        <span style={{ color: theme.fgMuted, 'font-size': '10px' }}>Permission requested</span>
      </div>

      <Show when={props.request.arguments}>
        <div
          style={{
            color: theme.fg,
            'font-size': '10px',
            padding: '3px 6px',
            background: theme.taskPanelBg,
            'border-radius': '3px',
            'margin-bottom': '6px',
            'word-break': 'break-all',
            'max-height': '60px',
            overflow: 'auto',
          }}
        >
          {props.request.arguments}
        </div>
      </Show>

      <Show when={props.request.status === 'pending'}>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => props.onApprove(props.request.id)}
            style={{
              background: '#4ec94e20',
              color: '#4ec94e',
              border: '1px solid #4ec94e50',
              'border-radius': '3px',
              padding: '3px 12px',
              cursor: 'pointer',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '10px',
              'font-weight': 'bold',
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
              'border-radius': '3px',
              padding: '3px 12px',
              cursor: 'pointer',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '10px',
              'font-weight': 'bold',
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
            'font-size': '10px',
            'font-weight': 'bold',
          }}
        >
          {props.request.status === 'approved' ? '✓ Approved' : '✕ Denied'}
        </span>
      </Show>
    </div>
  );
}
