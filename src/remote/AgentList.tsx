import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import type { RemoteAgent } from '../../electron/remote/protocol';
import { isRunningRemoteAgentStatus } from '../domain/server-state';
import {
  deriveRemoteAgentPreview,
  formatRemoteAgentActivity,
  formatRemoteLastPrompt,
  formatRemoteTaskContext,
  getRemoteAgentStatusPresentation,
} from './agent-presentation';
import { RemoteAgentGlyph } from './RemoteAgentGlyph';
import { getRemoteTaskOwnerStatus } from './remote-collaboration';
import {
  getConnectionBadgeLabel,
  getConnectionBannerText,
  getConnectionBannerTone,
  getConnectionTone,
  isRecoveringConnectionStatus,
  shouldShowConnectionSkeleton,
} from './status-helpers';
import { agents, getAgentLastActivityAt, getAgentPreview, status } from './ws';

interface AgentListProps {
  onEditSessionName: () => void;
  onSelect: (agentId: string, taskName: string) => void;
  sessionName: string;
}

interface AgentCardProps {
  agent: RemoteAgent;
  index: number;
  now: number;
  onSelect: (agentId: string, taskName: string) => void;
}

interface AgentSecondaryStatus {
  color: string;
  text: string | null;
}

function getConnectionIndicatorColor(tone: 'danger' | 'success' | 'warning'): string {
  switch (tone) {
    case 'success':
      return 'var(--success)';
    case 'warning':
      return 'var(--warning)';
    case 'danger':
      return 'var(--danger)';
  }
}

function getAgentTaskContext(agent: RemoteAgent): string | null {
  return formatRemoteTaskContext(
    agent.taskMeta?.branchName ?? null,
    agent.taskMeta?.folderName ?? null,
    agent.taskMeta?.directMode === true,
  );
}

function getAgentSecondaryStatus(agent: RemoteAgent): AgentSecondaryStatus {
  const ownerStatus = getRemoteTaskOwnerStatus(agent.taskId);
  if (ownerStatus) {
    return {
      color: ownerStatus.isSelf ? 'var(--accent)' : 'var(--warning)',
      text: ownerStatus.label,
    };
  }

  const lastPrompt = formatRemoteLastPrompt(agent.taskMeta?.lastPrompt ?? null);
  const text = getAgentTaskContext(agent) ?? (lastPrompt ? `Prompt: ${lastPrompt}` : null);

  return {
    color: 'var(--text-muted)',
    text,
  };
}

function getLoadingSkeletonWidth(row: number): string {
  if (row === 1) {
    return '62%';
  }
  if (row === 2) {
    return '74%';
  }
  return '68%';
}

function LoadingSkeleton() {
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '10px',
      }}
    >
      <For each={[0, 1, 2]}>
        {(row) => (
          <div
            style={{
              padding: '14px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              'border-radius': '14px',
              display: 'flex',
              gap: '10px',
              'align-items': 'center',
              animation: `cardIn 0.28s ease-out ${row * 0.05}s both`,
            }}
          >
            <div
              class="skeleton-block"
              style={{
                width: '22px',
                height: '22px',
                'border-radius': '5px',
                'flex-shrink': '0',
              }}
            />
            <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
              <div
                class="skeleton-block"
                style={{
                  width: getLoadingSkeletonWidth(row),
                  height: '13px',
                  'border-radius': '999px',
                }}
              />
              <div
                class="skeleton-block"
                style={{
                  width: row === 0 ? '44%' : '52%',
                  height: '10px',
                  'border-radius': '999px',
                  opacity: '0.75',
                }}
              />
            </div>
            <div
              class="skeleton-block"
              style={{
                width: '48px',
                height: '20px',
                'border-radius': '999px',
                'flex-shrink': '0',
              }}
            />
          </div>
        )}
      </For>
    </div>
  );
}

function ConnectedEmptyState() {
  return (
    <div
      style={{
        padding: '32px 20px',
        'text-align': 'center',
        animation: 'fadeIn 0.35s ease-out',
      }}
    >
      <div
        style={{
          width: '48px',
          height: '48px',
          margin: '0 auto 14px',
          'border-radius': '50%',
          background: 'rgba(46, 200, 255, 0.08)',
          border: '1px solid rgba(46, 200, 255, 0.16)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
        }}
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
            stroke="var(--accent)"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <p
        style={{
          'font-size': '14px',
          'font-weight': '600',
          color: 'var(--text-primary)',
          'margin-bottom': '6px',
        }}
      >
        No active agents
      </p>
      <p
        style={{
          'font-size': '13px',
          color: 'var(--text-muted)',
          'line-height': '1.5',
          'max-width': '260px',
          margin: '0 auto',
        }}
      >
        Start an agent from the desktop app to see it here.
      </p>
    </div>
  );
}

function AgentCard(props: AgentCardProps) {
  const [statusFlashClass, setStatusFlashClass] = createSignal('');
  const presentation = createMemo(() => getRemoteAgentStatusPresentation(props.agent.status));
  const secondaryStatus = createMemo(() => getAgentSecondaryStatus(props.agent));
  const preview = createMemo(() => {
    const livePreview = getAgentPreview(props.agent.agentId);
    if (livePreview.length > 0) {
      return livePreview;
    }

    return deriveRemoteAgentPreview(props.agent.lastLine, props.agent.status);
  });
  const activityLabel = createMemo(() =>
    formatRemoteAgentActivity(
      props.agent.status,
      getAgentLastActivityAt(props.agent.agentId),
      props.now,
    ),
  );
  createEffect(
    on(
      () => props.agent.status,
      (next, prev) => {
        if (prev && prev !== next) {
          setStatusFlashClass((current) =>
            current === 'status-flash-a' ? 'status-flash-b' : 'status-flash-a',
          );
        }
      },
    ),
  );

  return (
    <button
      type="button"
      class="card-btn tap-feedback"
      aria-label={`Open ${props.agent.taskName}. ${presentation().badgeLabel}. ${preview()}.`}
      onClick={() => props.onSelect(props.agent.agentId, props.agent.taskName)}
      style={{
        width: '100%',
        background:
          props.agent.status === 'running'
            ? 'linear-gradient(180deg, rgba(18, 24, 31, 0.98) 0%, rgba(14, 22, 28, 0.98) 100%)'
            : 'var(--bg-surface)',
        border: `1px solid ${presentation().badgeBorder}`,
        'border-radius': '14px',
        padding: '10px 12px',
        cursor: 'pointer',
        display: 'flex',
        'flex-direction': 'column',
        gap: '5px',
        'text-align': 'left',
        'touch-action': 'manipulation',
        animation: `cardIn 0.3s ease-out ${props.index * 0.05}s both`,
        'box-shadow':
          props.agent.status === 'running'
            ? '0 12px 28px rgba(5, 16, 21, 0.32)'
            : '0 6px 16px rgba(0, 0, 0, 0.14)',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
        }}
      >
        <div class={`status-indicator ${statusFlashClass()}`} style={{ 'flex-shrink': '0' }}>
          <RemoteAgentGlyph
            agentDefId={props.agent.taskMeta?.agentDefId ?? null}
            agentDefName={props.agent.taskMeta?.agentDefName ?? null}
            size={22}
          />
        </div>

        <span
          style={{
            flex: '1',
            'font-size': '14px',
            'font-weight': '600',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            'min-width': '0',
          }}
        >
          {props.agent.taskName}
        </span>

        <span
          style={{
            padding: '3px 8px',
            'border-radius': '999px',
            background: presentation().badgeBackground,
            border: `1px solid ${presentation().badgeBorder}`,
            color: presentation().accent,
            'font-size': '10px',
            'font-weight': '600',
            'letter-spacing': '0.02em',
            'flex-shrink': '0',
          }}
        >
          {presentation().badgeLabel}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '8px',
          'padding-left': '30px',
          'font-size': '11px',
        }}
      >
        <Show when={secondaryStatus().text} fallback={<span />}>
          <span
            style={{
              color: secondaryStatus().color,
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
              'min-width': '0',
            }}
          >
            {secondaryStatus().text}
          </span>
        </Show>
        <span
          style={{
            color: presentation().accent,
            'font-weight': '600',
            'flex-shrink': '0',
          }}
        >
          {activityLabel()}
        </span>
      </div>

      <p
        style={{
          'font-size': '12px',
          color: 'var(--text-secondary)',
          'line-height': '1.35',
          'padding-left': '30px',
          overflow: 'hidden',
          'text-overflow': 'ellipsis',
          'white-space': 'nowrap',
          margin: '0',
        }}
      >
        {preview()}
      </p>
    </button>
  );
}

export function AgentList(props: AgentListProps) {
  const [showTopFade, setShowTopFade] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const running = createMemo(
    () => agents().filter((agent) => isRunningRemoteAgentStatus(agent.status)).length,
  );
  const total = createMemo(() => agents().length);
  const connectionTone = createMemo(() => getConnectionTone(status()));
  const isRecoveringConnection = () => isRecoveringConnectionStatus(status());
  const showSkeleton = createMemo(() => total() === 0 && shouldShowConnectionSkeleton(status()));
  const connectionBannerText = createMemo(() => getConnectionBannerText(status()));
  const connectionBannerTone = createMemo(() => getConnectionBannerTone(status()));
  const connectionBadgeLabel = createMemo(() => getConnectionBadgeLabel(status()));

  onMount(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 15_000);

    onCleanup(() => window.clearInterval(timer));
  });

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: 'var(--bg-base)',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          'border-bottom': '1px solid rgba(34, 48, 64, 0.8)',
          background:
            'linear-gradient(180deg, rgba(18, 24, 31, 0.98) 0%, rgba(11, 15, 20, 0.98) 100%)',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '10px',
        }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            'min-width': '0',
            flex: '1',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: '26px',
              height: '26px',
              'border-radius': '7px',
              background: 'linear-gradient(135deg, var(--accent) 0%, #1a7a9e 100%)',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              'flex-shrink': '0',
            }}
          >
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path
                d="M2 4h10M2 7h10M2 10h10"
                stroke="#fff"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </div>

          <button
            type="button"
            class="surface-btn tap-feedback"
            aria-label="Edit mobile session name"
            onClick={() => props.onEditSessionName()}
            style={{
              background: 'none',
              border: 'none',
              padding: '0',
              cursor: 'pointer',
              'min-width': '0',
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
            }}
          >
            <span
              style={{
                'font-size': '15px',
                'font-weight': '600',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
              }}
            >
              {props.sessionName}
            </span>
            <svg
              aria-hidden="true"
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              style={{ 'flex-shrink': '0', opacity: '0.5' }}
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="var(--text-muted)"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'flex-shrink': '0' }}>
          <Show when={total() > 0}>
            <span
              style={{
                'font-size': '12px',
                color: 'var(--text-muted)',
                'font-weight': '500',
              }}
            >
              {running()}/{total()}
            </span>
          </Show>

          <div
            role="status"
            aria-live="polite"
            aria-label={`Connection ${status()}, ${running()} of ${total()} agents running.`}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '6px',
              padding: '5px 10px',
              'border-radius': '999px',
              background: 'rgba(26, 36, 48, 0.6)',
              border: '1px solid rgba(34, 48, 64, 0.6)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '8px',
                height: '8px',
                'border-radius': '50%',
                background: getConnectionIndicatorColor(connectionTone()),
                'box-shadow': `0 0 8px ${getConnectionIndicatorColor(connectionTone())}`,
              }}
            />
            <span
              style={{
                'font-size': '11px',
                color: connectionTone() === 'danger' ? 'var(--danger)' : 'var(--text-primary)',
                'font-weight': '600',
              }}
            >
              {connectionBadgeLabel()}
            </span>
          </div>
        </div>
      </div>

      <Show when={connectionBannerText()}>
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: '6px 14px',
            background: connectionBannerTone().background,
            color: connectionBannerTone().color,
            'font-size': '12px',
            'text-align': 'center',
          }}
        >
          {connectionBannerText()}
        </div>
      </Show>

      <div
        style={{
          position: 'relative',
          flex: '1',
          overflow: 'auto',
          padding: '10px 12px 18px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '10px',
        }}
        onScroll={(event) => setShowTopFade(event.currentTarget.scrollTop > 8)}
      >
        <Show when={showTopFade()}>
          <div
            style={{
              position: 'sticky',
              top: '-10px',
              height: '12px',
              'margin-bottom': '-12px',
              background:
                'linear-gradient(180deg, rgba(11, 15, 20, 0.98) 0%, rgba(11, 15, 20, 0) 100%)',
              'pointer-events': 'none',
              'z-index': '5',
            }}
          />
        </Show>

        <Show when={!showSkeleton()} fallback={<LoadingSkeleton />}>
          <Show when={total() > 0} fallback={<ConnectedEmptyState />}>
            <Show when={!isRecoveringConnection() || total() > 0}>
              <For each={agents()}>
                {(agent, index) => (
                  <AgentCard agent={agent} index={index()} now={now()} onSelect={props.onSelect} />
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
