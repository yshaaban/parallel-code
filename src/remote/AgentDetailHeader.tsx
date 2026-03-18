import { Show, type JSX } from 'solid-js';
import type { RemoteAgentStatus } from '../domain/server-state';
import { formatRemoteAgentActivity, getRemoteAgentStatusPresentation } from './agent-presentation';
import {
  getConnectionBadgeLabel,
  getConnectionBannerText,
  getConnectionBannerTone,
  getConnectionTone,
} from './status-helpers';
import type { ConnectionStatus } from './ws';

interface AgentDetailHeaderProps {
  agentStatus?: RemoteAgentStatus;
  connectionStatus: ConnectionStatus;
  lastActivityAt: number | null;
  onBack: () => void;
  onKill: () => void;
  onTakeOver: () => void;
  ownerLabel: string | null;
  ownerIsSelf: boolean;
  ownershipNotice: string | null;
  preview: string;
  showTakeOver: boolean;
  statusFlashClass: string;
  takeOverBusy: boolean;
  takeOverLabel: string;
  taskName: string;
}

function getToneColors(tone: 'danger' | 'success' | 'warning'): {
  background: string;
  border: string;
  text: string;
} {
  switch (tone) {
    case 'success':
      return {
        background: 'rgba(47, 209, 152, 0.12)',
        border: 'rgba(47, 209, 152, 0.24)',
        text: 'var(--success)',
      };
    case 'warning':
      return {
        background: 'rgba(255, 197, 105, 0.12)',
        border: 'rgba(255, 197, 105, 0.24)',
        text: 'var(--warning)',
      };
    case 'danger':
      return {
        background: 'rgba(255, 95, 115, 0.12)',
        border: 'rgba(255, 95, 115, 0.24)',
        text: 'var(--danger)',
      };
  }
}

function getOwnerToneColors(isSelf: boolean): { background: string; border: string; text: string } {
  if (isSelf) {
    return {
      background: 'rgba(46, 200, 255, 0.12)',
      border: 'rgba(46, 200, 255, 0.26)',
      text: 'var(--accent)',
    };
  }

  return {
    background: 'rgba(255, 197, 105, 0.12)',
    border: 'rgba(255, 197, 105, 0.22)',
    text: 'var(--warning)',
  };
}

export function AgentDetailHeader(props: AgentDetailHeaderProps): JSX.Element {
  const agentStatus = () => props.agentStatus ?? 'restoring';
  const statusPresentation = () => getRemoteAgentStatusPresentation(agentStatus());
  const connectionBannerText = () => getConnectionBannerText(props.connectionStatus);
  const connectionBannerTone = () => getConnectionBannerTone(props.connectionStatus);
  const connectionTone = () => getToneColors(getConnectionTone(props.connectionStatus));
  const ownerTone = () => getOwnerToneColors(props.ownerIsSelf);
  const activityLabel = () =>
    formatRemoteAgentActivity(agentStatus(), props.lastActivityAt, Date.now());

  return (
    <>
      <div
        style={{
          display: 'grid',
          gap: '10px',
          padding: '10px 14px 12px',
          'border-bottom': '1px solid var(--border)',
          'flex-shrink': '0',
          position: 'relative',
          'z-index': '10',
          background:
            'linear-gradient(180deg, rgba(18, 24, 31, 0.98) 0%, rgba(11, 15, 20, 0.98) 100%)',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
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

          <Show when={props.agentStatus === 'running'}>
            <button
              type="button"
              class="outline-danger-btn tap-feedback"
              aria-label="Kill running agent"
              onClick={() => props.onKill()}
              style={{
                background: 'none',
                border: '1px solid rgba(255, 95, 115, 0.3)',
                'border-radius': '8px',
                padding: '6px 10px',
                color: 'var(--danger)',
                'font-size': '11px',
                'font-weight': '600',
                cursor: 'pointer',
                'touch-action': 'manipulation',
              }}
            >
              Kill
            </button>
          </Show>
        </div>

        <div
          style={{
            padding: '12px 14px',
            'border-radius': '18px',
            background:
              'linear-gradient(180deg, rgba(18, 24, 31, 0.94) 0%, rgba(14, 20, 27, 0.98) 100%)',
            border: '1px solid rgba(46, 200, 255, 0.12)',
            display: 'grid',
            gap: '10px',
            'box-shadow': '0 16px 34px rgba(0, 0, 0, 0.24)',
          }}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: '10px',
              'flex-wrap': 'wrap',
            }}
          >
            <div
              style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '8px',
                  padding: '6px 10px',
                  'border-radius': '999px',
                  background: statusPresentation().badgeBackground,
                  border: `1px solid ${statusPresentation().badgeBorder}`,
                  color: statusPresentation().accent,
                  'font-size': '11px',
                  'font-weight': '600',
                }}
              >
                <span
                  aria-hidden="true"
                  class={`status-indicator ${props.statusFlashClass}`}
                  style={{
                    width: '8px',
                    height: '8px',
                    'border-radius': '50%',
                    background: statusPresentation().accent,
                    'box-shadow': `0 0 8px ${statusPresentation().accent}`,
                  }}
                />
                {statusPresentation().badgeLabel}
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  padding: '6px 10px',
                  'border-radius': '999px',
                  background: connectionTone().background,
                  border: `1px solid ${connectionTone().border}`,
                  color: connectionTone().text,
                  'font-size': '11px',
                  'font-weight': '600',
                }}
              >
                {getConnectionBadgeLabel(props.connectionStatus)}
              </span>
              <Show when={props.ownerLabel}>
                <span
                  style={{
                    display: 'inline-flex',
                    'align-items': 'center',
                    padding: '6px 10px',
                    'border-radius': '999px',
                    background: ownerTone().background,
                    border: `1px solid ${ownerTone().border}`,
                    color: ownerTone().text,
                    'font-size': '11px',
                    'font-weight': '600',
                  }}
                >
                  {props.ownerLabel}
                </span>
              </Show>
            </div>

            <div
              style={{
                'font-size': '11px',
                color: 'var(--text-muted)',
                'font-weight': '600',
              }}
            >
              {activityLabel()}
            </div>
          </div>

          <div style={{ display: 'grid', gap: '6px' }}>
            <div
              style={{ 'font-size': '15px', 'font-weight': '700', color: 'var(--text-primary)' }}
            >
              {props.taskName}
            </div>
            <p
              style={{
                'font-size': '13px',
                color: 'var(--text-secondary)',
                'line-height': '1.5',
                margin: '0',
              }}
            >
              {props.preview}
            </p>
            <Show when={props.ownershipNotice}>
              <div
                role="status"
                aria-live="polite"
                style={{
                  'font-size': '12px',
                  color: props.ownerIsSelf ? 'var(--accent)' : 'var(--warning)',
                }}
              >
                {props.ownershipNotice}
              </div>
            </Show>
          </div>

          <Show when={props.showTakeOver}>
            <button
              type="button"
              class="accent-btn tap-feedback"
              disabled={props.takeOverBusy}
              onClick={() => props.onTakeOver()}
              style={{
                width: '100%',
                border: 'none',
                'border-radius': '12px',
                padding: '10px 12px',
                background:
                  props.takeOverLabel === 'Force Take Over' ? 'var(--warning)' : 'var(--accent)',
                color: '#031018',
                'font-size': '13px',
                'font-weight': '700',
                cursor: props.takeOverBusy ? 'default' : 'pointer',
                opacity: props.takeOverBusy ? '0.7' : '1',
              }}
            >
              {props.takeOverBusy ? 'Working…' : props.takeOverLabel}
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
            background: connectionBannerTone().background,
            color: connectionBannerTone().color,
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
