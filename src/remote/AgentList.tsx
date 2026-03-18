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
  formatRemoteAgentId,
  getRemoteAgentStatusPresentation,
} from './agent-presentation';
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

function getToneColors(tone: 'danger' | 'success' | 'warning'): {
  background: string;
  border: string;
  glow: string;
} {
  switch (tone) {
    case 'success':
      return {
        background: 'rgba(47, 209, 152, 0.12)',
        border: 'rgba(47, 209, 152, 0.24)',
        glow: '0 0 10px rgba(47, 209, 152, 0.32)',
      };
    case 'warning':
      return {
        background: 'rgba(255, 197, 105, 0.12)',
        border: 'rgba(255, 197, 105, 0.24)',
        glow: '0 0 10px rgba(255, 197, 105, 0.24)',
      };
    case 'danger':
      return {
        background: 'rgba(255, 95, 115, 0.12)',
        border: 'rgba(255, 95, 115, 0.24)',
        glow: '0 0 10px rgba(255, 95, 115, 0.2)',
      };
  }
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

function getAgentListHeroBody(totalCount: number, runningCount: number): string {
  if (totalCount === 0) {
    return 'Watch live agents, inspect their latest output, and jump into the terminal from your phone.';
  }
  if (runningCount > 0) {
    return 'Open any live card to jump straight into the terminal and respond without breaking your flow.';
  }
  return 'Review recent output, reconnect with finished agents, and keep long-running work in view from anywhere.';
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
              padding: '16px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              'border-radius': '18px',
              display: 'flex',
              gap: '12px',
              'align-items': 'center',
              animation: `cardIn 0.28s ease-out ${row * 0.05}s both`,
            }}
          >
            <div
              class="skeleton-block"
              style={{
                width: '12px',
                height: '12px',
                'border-radius': '999px',
                'flex-shrink': '0',
              }}
            />
            <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <div
                class="skeleton-block"
                style={{
                  width: getLoadingSkeletonWidth(row),
                  height: '14px',
                  'border-radius': '999px',
                }}
              />
              <div
                class="skeleton-block"
                style={{
                  width: row === 0 ? '44%' : '52%',
                  height: '11px',
                  'border-radius': '999px',
                  opacity: '0.75',
                }}
              />
            </div>
            <div
              class="skeleton-block"
              style={{
                width: '56px',
                height: '22px',
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
        padding: '6px 6px 10px',
        animation: 'fadeIn 0.35s ease-out',
      }}
    >
      <div
        style={{
          padding: '26px 18px 20px',
          background:
            'linear-gradient(180deg, rgba(18, 24, 31, 0.94) 0%, rgba(12, 18, 25, 0.98) 100%)',
          border: '1px solid rgba(46, 200, 255, 0.14)',
          'border-radius': '20px',
          overflow: 'hidden',
          position: 'relative',
          'box-shadow': '0 18px 36px rgba(0, 0, 0, 0.22)',
        }}
      >
        <div
          class="empty-state-pulse"
          style={{
            position: 'absolute',
            top: '-70px',
            left: '50%',
            width: '160px',
            height: '160px',
            transform: 'translateX(-50%)',
            background:
              'radial-gradient(circle, rgba(46, 200, 255, 0.18) 0%, rgba(46, 200, 255, 0) 70%)',
            'pointer-events': 'none',
          }}
        />
        <div
          style={{
            position: 'relative',
            width: '68px',
            height: '68px',
            margin: '0 auto 16px',
          }}
        >
          <div
            class="empty-state-pulse"
            style={{
              position: 'absolute',
              inset: '0',
              'border-radius': '50%',
              border: '1px solid rgba(46, 200, 255, 0.22)',
              background: 'rgba(46, 200, 255, 0.06)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: '10px',
              'border-radius': '50%',
              background:
                'linear-gradient(135deg, rgba(46, 200, 255, 0.2) 0%, rgba(46, 200, 255, 0.05) 100%)',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              'backdrop-filter': 'blur(8px)',
            }}
          >
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                stroke="var(--accent)"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>
        <p
          style={{
            'font-size': '16px',
            'font-weight': '600',
            color: 'var(--text-primary)',
            'margin-bottom': '8px',
            'text-align': 'center',
          }}
        >
          Your live agent inbox is ready
        </p>
        <p
          style={{
            'font-size': '13px',
            color: 'var(--text-secondary)',
            'line-height': '1.6',
            'max-width': '280px',
            margin: '0 auto 16px',
            'text-align': 'center',
          }}
        >
          Start or resume an agent from the desktop app and this screen turns into a live control
          surface instantly.
        </p>
        <div
          style={{
            display: 'grid',
            gap: '8px',
          }}
        >
          <div
            style={{
              padding: '11px 12px',
              background: 'rgba(26, 36, 48, 0.7)',
              border: '1px solid rgba(46, 200, 255, 0.14)',
              'border-radius': '14px',
              'font-size': '12px',
              color: 'var(--text-secondary)',
            }}
          >
            Watch live terminal output without opening a laptop.
          </div>
          <div
            style={{
              padding: '11px 12px',
              background: 'rgba(26, 36, 48, 0.7)',
              border: '1px solid rgba(46, 200, 255, 0.14)',
              'border-radius': '14px',
              'font-size': '12px',
              color: 'var(--text-secondary)',
            }}
          >
            Jump straight into prompts, blockers, and recovery states.
          </div>
          <div
            style={{
              padding: '11px 12px',
              background: 'rgba(26, 36, 48, 0.7)',
              border: '1px solid rgba(46, 200, 255, 0.14)',
              'border-radius': '14px',
              'font-size': '12px',
              color: 'var(--text-secondary)',
            }}
          >
            Send terminal input, navigation keys, and kill signals from your phone.
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentCard(props: AgentCardProps) {
  const [statusFlashClass, setStatusFlashClass] = createSignal('');
  const presentation = createMemo(() => getRemoteAgentStatusPresentation(props.agent.status));
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
        'border-radius': '18px',
        padding: '16px',
        cursor: 'pointer',
        display: 'flex',
        'flex-direction': 'column',
        gap: '12px',
        'text-align': 'left',
        'touch-action': 'manipulation',
        animation: `cardIn 0.3s ease-out ${props.index * 0.05}s both`,
        'box-shadow':
          props.agent.status === 'running'
            ? '0 16px 34px rgba(5, 16, 21, 0.36)'
            : '0 10px 24px rgba(0, 0, 0, 0.18)',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'flex-start',
          gap: '12px',
        }}
      >
        <div
          aria-hidden="true"
          class={`status-indicator ${statusFlashClass()}`}
          style={{
            width: '12px',
            height: '12px',
            'border-radius': '50%',
            background: presentation().accent,
            'box-shadow': `0 0 12px ${presentation().accent}`,
            transform: props.agent.status === 'running' ? 'scale(1)' : 'scale(0.9)',
            opacity: '0.95',
            'flex-shrink': '0',
            'margin-top': '4px',
          }}
        />

        <div style={{ flex: '1', 'min-width': '0', display: 'grid', gap: '8px' }}>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: '10px',
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
              {props.agent.taskName}
            </span>
            <span
              style={{
                padding: '5px 10px',
                'border-radius': '999px',
                background: presentation().badgeBackground,
                border: `1px solid ${presentation().badgeBorder}`,
                color: presentation().accent,
                'font-size': '11px',
                'font-weight': '600',
                'letter-spacing': '0.02em',
                'flex-shrink': '0',
              }}
            >
              {presentation().badgeLabel}
            </span>
          </div>

          <p
            style={{
              'font-size': '13px',
              color: 'var(--text-secondary)',
              'line-height': '1.5',
              display: '-webkit-box',
              '-webkit-line-clamp': '2',
              '-webkit-box-orient': 'vertical',
              overflow: 'hidden',
              'min-height': '39px',
            }}
          >
            {preview()}
          </p>

          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: '10px',
              'font-size': '11px',
            }}
          >
            <span
              style={{
                color: 'var(--text-muted)',
                'font-family': "'JetBrains Mono', 'Courier New', monospace",
              }}
            >
              {formatRemoteAgentId(props.agent.agentId)}
            </span>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-width': '0' }}>
              <span
                style={{
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'white-space': 'nowrap',
                }}
              >
                {presentation().description}
              </span>
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
          </div>
        </div>

        <div
          aria-hidden="true"
          style={{
            width: '28px',
            height: '28px',
            'border-radius': '50%',
            background: 'rgba(26, 36, 48, 0.7)',
            border: '1px solid rgba(46, 200, 255, 0.12)',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'flex-shrink': '0',
            'margin-top': '2px',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: '0.72' }}>
            <path
              d="M6 3l5 5-5 5"
              stroke="var(--text-muted)"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
      </div>
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
  const heroBody = createMemo(() => getAgentListHeroBody(total(), running()));
  const connectionColors = createMemo(() => getToneColors(connectionTone()));

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
          padding: '18px 18px 14px',
          'border-bottom': '1px solid rgba(34, 48, 64, 0.8)',
          background:
            'linear-gradient(180deg, rgba(18, 24, 31, 0.98) 0%, rgba(11, 15, 20, 0.98) 100%)',
          display: 'grid',
          gap: '14px',
        }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
            <div
              aria-hidden="true"
              style={{
                width: '32px',
                height: '32px',
                'border-radius': '10px',
                background: 'linear-gradient(135deg, var(--accent) 0%, #1a7a9e 100%)',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'box-shadow': '0 10px 24px rgba(46, 200, 255, 0.2)',
              }}
            >
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 14 14" fill="none">
                <path
                  d="M2 4h10M2 7h10M2 10h10"
                  stroke="#fff"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </div>
            <div>
              <div
                style={{ 'font-size': '17px', 'font-weight': '700', color: 'var(--text-primary)' }}
              >
                Parallel Code
              </div>
              <div style={{ 'font-size': '12px', color: 'var(--text-muted)' }}>
                Live agents on your phone
              </div>
            </div>
          </div>

          <div
            role="status"
            aria-live="polite"
            aria-label={`Connection ${status()}, ${running()} of ${total()} agents running.`}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              padding: '8px 12px',
              'border-radius': '999px',
              background: connectionColors().background,
              border: `1px solid ${connectionColors().border}`,
            }}
          >
            <div
              aria-hidden="true"
              class="status-indicator"
              style={{
                width: '8px',
                height: '8px',
                'border-radius': '50%',
                background: getConnectionIndicatorColor(connectionTone()),
                'box-shadow': connectionColors().glow,
                transform: connectionTone() === 'success' ? 'scale(1)' : 'scale(0.92)',
                ...(isRecoveringConnection()
                  ? { animation: 'breathe 1.5s ease-in-out infinite' }
                  : {}),
              }}
            />
            <span
              style={{ 'font-size': '12px', 'font-weight': '600', color: 'var(--text-primary)' }}
            >
              {connectionBadgeLabel()}
            </span>
          </div>
        </div>

        <div
          style={{
            padding: '16px',
            'border-radius': '20px',
            background:
              'linear-gradient(180deg, rgba(19, 27, 35, 0.98) 0%, rgba(14, 20, 27, 0.98) 100%)',
            border: '1px solid rgba(46, 200, 255, 0.14)',
            'box-shadow': '0 18px 40px rgba(0, 0, 0, 0.24)',
            display: 'grid',
            gap: '14px',
          }}
        >
          <div style={{ display: 'grid', gap: '10px' }}>
            <div style={{ display: 'grid', gap: '6px' }}>
              <div
                style={{ 'font-size': '18px', 'font-weight': '700', color: 'var(--text-primary)' }}
              >
                Keep important work within thumb reach
              </div>
              <p
                style={{
                  'font-size': '13px',
                  color: 'var(--text-secondary)',
                  'line-height': '1.6',
                }}
              >
                {heroBody()}
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                gap: '10px',
                padding: '10px 12px',
                'border-radius': '14px',
                background: 'rgba(26, 36, 48, 0.72)',
                border: '1px solid rgba(46, 200, 255, 0.12)',
              }}
            >
              <div style={{ display: 'grid', gap: '3px', 'min-width': '0' }}>
                <span style={{ 'font-size': '11px', color: 'var(--text-muted)' }}>
                  Session name
                </span>
                <span
                  style={{
                    'font-size': '13px',
                    'font-weight': '600',
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {props.sessionName}
                </span>
              </div>
              <button
                type="button"
                class="surface-btn tap-feedback"
                aria-label="Edit mobile session name"
                onClick={() => props.onEditSessionName()}
                style={{
                  border: '1px solid rgba(46, 200, 255, 0.16)',
                  'border-radius': '999px',
                  background: 'rgba(46, 200, 255, 0.08)',
                  color: 'var(--accent)',
                  padding: '7px 12px',
                  'font-size': '12px',
                  'font-weight': '600',
                  cursor: 'pointer',
                  'flex-shrink': '0',
                }}
              >
                Rename
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <div
              style={{
                flex: '1',
                padding: '12px',
                'border-radius': '16px',
                background: 'rgba(46, 200, 255, 0.08)',
                border: '1px solid rgba(46, 200, 255, 0.14)',
              }}
            >
              <div
                style={{ 'font-size': '11px', color: 'var(--text-muted)', 'margin-bottom': '6px' }}
              >
                Running now
              </div>
              <div
                style={{ 'font-size': '20px', 'font-weight': '700', color: 'var(--text-primary)' }}
              >
                {running()}
              </div>
            </div>
            <div
              style={{
                flex: '1',
                padding: '12px',
                'border-radius': '16px',
                background: 'rgba(47, 209, 152, 0.08)',
                border: '1px solid rgba(47, 209, 152, 0.14)',
              }}
            >
              <div
                style={{ 'font-size': '11px', color: 'var(--text-muted)', 'margin-bottom': '6px' }}
              >
                Visible tasks
              </div>
              <div
                style={{ 'font-size': '20px', 'font-weight': '700', color: 'var(--text-primary)' }}
              >
                {total()}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Show when={connectionBannerText()}>
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: '8px 16px',
            background: connectionBannerTone().background,
            color: connectionBannerTone().color,
            'font-size': '13px',
            'text-align': 'center',
            'flex-shrink': '0',
            animation: 'slideUp 0.2s ease-out',
          }}
        >
          {connectionBannerText()}
        </div>
      </Show>

      <div
        style={{
          flex: '1',
          position: 'relative',
          'min-height': '0',
        }}
      >
        <Show when={showTopFade()}>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '0',
              left: '12px',
              right: '12px',
              height: '26px',
              background:
                'linear-gradient(180deg, rgba(11, 15, 20, 0.96) 0%, rgba(11, 15, 20, 0) 100%)',
              'pointer-events': 'none',
              'z-index': '2',
            }}
          />
        </Show>

        <div
          onScroll={(event) => setShowTopFade(event.currentTarget.scrollTop > 6)}
          style={{
            height: '100%',
            overflow: 'auto',
            padding: '12px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '10px',
            '-webkit-overflow-scrolling': 'touch',
            'padding-bottom': 'max(12px, env(safe-area-inset-bottom))',
          }}
        >
          <Show when={showSkeleton()}>
            <LoadingSkeleton />
          </Show>

          <Show when={!showSkeleton() && total() === 0 && connectionBannerText() === null}>
            <ConnectedEmptyState />
          </Show>

          <Show when={!showSkeleton() && total() === 0 && connectionBannerText() !== null}>
            <div
              role="status"
              aria-live="polite"
              style={{
                'text-align': 'center',
                color: 'var(--text-muted)',
                'padding-top': '54px',
                'font-size': '14px',
                animation: 'fadeIn 0.3s ease-out',
              }}
            >
              Waiting for the remote session to reconnect.
            </div>
          </Show>

          <For each={agents()}>
            {(agent, index) => (
              <AgentCard agent={agent} index={index()} now={now()} onSelect={props.onSelect} />
            )}
          </For>

          <div
            style={{
              padding: '12px 14px',
              background: 'rgba(18, 24, 31, 0.75)',
              border: '1px solid rgba(34, 48, 64, 0.7)',
              'border-radius': '14px',
              'font-size': '12px',
              color: 'var(--text-muted)',
              'text-align': 'center',
              'line-height': '1.5',
              'margin-top': '4px',
            }}
          >
            Remote mobile is still evolving.{' '}
            <a
              href="https://github.com/johannesjo/parallel-code/issues"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Report bugs for the remote mobile app on GitHub"
              style={{ color: 'var(--accent)' }}
            >
              Report bugs
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
