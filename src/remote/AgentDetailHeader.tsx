import { Show, type JSX } from 'solid-js';
import type { RemoteAgentStatus } from '../domain/server-state';
import { isRunningRemoteAgentStatus } from '../domain/server-state';
import type { ConnectionStatus } from './ws';
import { getConnectionBannerText, isRecoveringConnectionStatus } from './status-helpers';

interface AgentDetailHeaderProps {
  agentStatus?: RemoteAgentStatus;
  connectionStatus: ConnectionStatus;
  onBack: () => void;
  onKill: () => void;
  statusFlashClass: string;
  taskName: string;
}

export function AgentDetailHeader(props: AgentDetailHeaderProps): JSX.Element {
  const running = () => (props.agentStatus ? isRunningRemoteAgentStatus(props.agentStatus) : false);
  const connectionBannerText = () => getConnectionBannerText(props.connectionStatus);

  return (
    <>
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '10px 14px',
          'border-bottom': '1px solid var(--border)',
          'flex-shrink': '0',
          position: 'relative',
          'z-index': '10',
          background: 'var(--bg-surface)',
        }}
      >
        <button
          type="button"
          class="ghost-btn tap-feedback"
          aria-label="Back to agent list"
          onClick={() => props.onBack()}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            'font-size': '14px',
            cursor: 'pointer',
            padding: '8px 6px',
            'touch-action': 'manipulation',
            display: 'flex',
            'align-items': 'center',
            gap: '4px',
            'border-radius': '10px',
          }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 3L5 8l5 5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Back
        </button>

        <div style={{ flex: '1', 'min-width': '0', 'text-align': 'center' }}>
          <span
            style={{
              'font-size': '14px',
              'font-weight': '600',
              color: 'var(--text-primary)',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
              display: 'block',
            }}
          >
            {props.taskName}
          </span>
        </div>

        <div
          role="status"
          aria-live="polite"
          aria-label={`Agent status ${props.agentStatus ?? 'unavailable'}.`}
          style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}
        >
          <div
            aria-hidden="true"
            class={`status-indicator ${props.statusFlashClass}`}
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background: running() ? 'var(--success)' : 'var(--text-muted)',
              'box-shadow': running()
                ? '0 0 8px rgba(47, 209, 152, 0.42)'
                : '0 0 0 rgba(47, 209, 152, 0)',
              transform: running() ? 'scale(1)' : 'scale(0.82)',
              opacity: running() ? '1' : '0.8',
            }}
          />
          <Show when={running()}>
            <button
              type="button"
              class="outline-danger-btn tap-feedback"
              aria-label="Kill running agent"
              onClick={() => props.onKill()}
              style={{
                background: 'none',
                border: '1px solid rgba(255, 95, 115, 0.3)',
                'border-radius': '6px',
                padding: '4px 8px',
                color: 'var(--danger)',
                'font-size': '11px',
                cursor: 'pointer',
                'touch-action': 'manipulation',
              }}
            >
              Kill
            </button>
          </Show>
        </div>
      </div>

      <Show when={connectionBannerText()}>
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: '6px 16px',
            background: isRecoveringConnectionStatus(props.connectionStatus)
              ? '#78350f'
              : '#7f1d1d',
            color: isRecoveringConnectionStatus(props.connectionStatus) ? '#fde68a' : '#fca5a5',
            'font-size': '12px',
            'text-align': 'center',
            'flex-shrink': '0',
            animation: 'slideUp 0.2s ease-out',
          }}
        >
          {connectionBannerText()}
        </div>
      </Show>
    </>
  );
}
