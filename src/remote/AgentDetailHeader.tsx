import { Show, type JSX } from 'solid-js';
import type { RemoteAgentStatus } from '../domain/server-state';
import { typography } from '../lib/typography';
import {
  formatRemoteAgentActivity,
  getRemoteAgentStatusPresentation,
  getRemoteAgentViewTransitionName,
} from './agent-presentation';
import { getConnectionBannerText, getConnectionBannerTone } from './status-helpers';
import type { ConnectionStatus } from './ws';

interface AgentDetailHeaderProps {
  agentId: string;
  agentStatus?: RemoteAgentStatus;
  connectionStatus: ConnectionStatus;
  contextLine: string | null;
  lastActivityAt: number | null;
  onBack: () => void;
  onKill: () => void;
  onTakeOver: () => void;
  ownerLabel: string | null;
  ownerIsSelf: boolean;
  ownershipNotice: string | null;
  showTakeOver: boolean;
  statusFlashClass: string;
  takeOverBusy: boolean;
  takeOverLabel: string;
  taskName: string;
}

function getOwnerToneColors(): { background: string; border: string; text: string } {
  return {
    background: 'rgba(255, 197, 105, 0.12)',
    border: 'rgba(255, 197, 105, 0.22)',
    text: 'var(--warning)',
  };
}

function getOwnershipSummary(
  ownerLabel: string | null,
  ownerIsSelf: boolean,
  showTakeOver: boolean,
): string | null {
  if (ownerIsSelf) {
    return null;
  }

  if (ownerLabel) {
    return ownerLabel;
  }

  if (showTakeOver) {
    return 'Controlled elsewhere';
  }

  return null;
}

export function AgentDetailHeader(props: AgentDetailHeaderProps): JSX.Element {
  const agentStatus = () => props.agentStatus ?? 'restoring';
  const statusPresentation = () => getRemoteAgentStatusPresentation(agentStatus());
  const connectionBannerText = () => getConnectionBannerText(props.connectionStatus);
  const connectionBannerTone = () => getConnectionBannerTone(props.connectionStatus);
  const ownerTone = () => getOwnerToneColors();
  const ownershipSummary = () =>
    getOwnershipSummary(props.ownerLabel, props.ownerIsSelf, props.showTakeOver);
  const activityLabel = () =>
    formatRemoteAgentActivity(agentStatus(), props.lastActivityAt, Date.now());

  return (
    <>
      <div
        data-testid="remote-agent-detail-header"
        style={{
          display: 'grid',
          gap: 'var(--space-xs)',
          padding: 'var(--space-sm)',
          'padding-bottom': '0',
          'flex-shrink': '0',
          position: 'relative',
          'z-index': '10',
        }}
      >
        <div
          class="remote-panel remote-detail-toolbar"
          style={{
            padding: 'var(--space-xs) var(--space-sm)',
            'view-transition-name': getRemoteAgentViewTransitionName(props.agentId),
          }}
        >
          <button
            type="button"
            class="ghost-btn tap-feedback remote-detail-back-button"
            aria-label="Back to agent list"
            onClick={() => props.onBack()}
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
            <span class="remote-detail-back-label" style={typography.metaStrong}>
              Agents
            </span>
          </button>

          <div class="remote-detail-summary">
            <div class="remote-detail-title-row">
              <div
                class="remote-detail-task-name"
                style={{
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                  ...typography.uiStrong,
                }}
              >
                {props.taskName}
              </div>
              <span
                class="remote-chip remote-detail-status-chip"
                style={{
                  background: statusPresentation().badgeBackground,
                  border: `1px solid ${statusPresentation().badgeBorder}`,
                  color: statusPresentation().accent,
                }}
              >
                <span
                  aria-hidden="true"
                  class={`status-indicator ${props.statusFlashClass}`}
                  style={{
                    width: '0.42rem',
                    height: '0.42rem',
                    'border-radius': '50%',
                    background: statusPresentation().accent,
                    'box-shadow': `0 0 8px ${statusPresentation().accent}`,
                  }}
                />
                <span style={typography.metaStrong}>{statusPresentation().badgeLabel}</span>
              </span>
            </div>

            <div class="remote-detail-meta-row">
              <Show when={props.contextLine}>
                <span class="remote-detail-context" style={typography.metaStrong}>
                  {props.contextLine}
                </span>
              </Show>
              <Show when={ownershipSummary()}>
                <span
                  class="remote-detail-meta-pill"
                  style={{
                    color: ownerTone().text,
                    background: ownerTone().background,
                    border: `1px solid ${ownerTone().border}`,
                    ...typography.metaStrong,
                  }}
                >
                  {ownershipSummary()}
                </span>
              </Show>
              <span class="remote-detail-activity" style={typography.metaStrong}>
                {activityLabel()}
              </span>
            </div>
          </div>

          <div class="remote-detail-actions">
            <Show when={props.showTakeOver}>
              <button
                type="button"
                class="accent-btn tap-feedback remote-detail-takeover-button"
                disabled={props.takeOverBusy}
                onClick={() => props.onTakeOver()}
              >
                {props.takeOverBusy ? 'Working…' : props.takeOverLabel}
              </button>
            </Show>

            <Show when={props.agentStatus === 'running'}>
              <button
                type="button"
                class="outline-danger-btn tap-feedback remote-detail-kill-button"
                aria-label="Kill running agent"
                onClick={() => props.onKill()}
              >
                <span style={typography.metaStrong}>Kill</span>
              </button>
            </Show>
          </div>
        </div>

        <Show when={props.ownershipNotice}>
          <div
            role="status"
            aria-live="polite"
            class="remote-detail-inline-notice"
            style={{
              background: props.ownerIsSelf
                ? 'rgba(46, 200, 255, 0.08)'
                : 'rgba(255, 197, 105, 0.1)',
              border: `1px solid ${props.ownerIsSelf ? 'rgba(46, 200, 255, 0.2)' : 'rgba(255, 197, 105, 0.18)'}`,
              color: props.ownerIsSelf ? 'var(--accent)' : 'var(--warning)',
              ...typography.metaStrong,
            }}
          >
            {props.ownershipNotice}
          </div>
        </Show>
      </div>

      <Show when={connectionBannerText()}>
        <div
          role="status"
          aria-live="polite"
          style={{
            margin: 'var(--space-sm)',
            'margin-top': 'var(--space-xs)',
            padding: '0.75rem 1rem',
            background: connectionBannerTone().background,
            color: connectionBannerTone().color,
            'border-radius': '1rem',
            'flex-shrink': '0',
            animation: 'slideUp 0.2s ease-out',
            ...typography.metaStrong,
          }}
        >
          {connectionBannerText()}
        </div>
      </Show>
    </>
  );
}
