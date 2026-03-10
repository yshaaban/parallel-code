import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import { agents, status } from './ws';
import type { RemoteAgent } from '../../electron/remote/protocol';

interface AgentListProps {
  onSelect: (agentId: string, taskName: string) => void;
}

interface AgentCardProps {
  agent: RemoteAgent;
  index: number;
  onSelect: (agentId: string, taskName: string) => void;
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
              padding: '14px 16px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              'border-radius': '16px',
              display: 'flex',
              gap: '12px',
              'align-items': 'center',
              animation: `cardIn 0.28s ease-out ${row * 0.05}s both`,
            }}
          >
            <div
              class="skeleton-block"
              style={{
                width: '10px',
                height: '10px',
                'border-radius': '999px',
                'flex-shrink': '0',
              }}
            />
            <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <div
                class="skeleton-block"
                style={{
                  width: row === 1 ? '62%' : row === 2 ? '74%' : '68%',
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
                width: '18px',
                height: '18px',
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
        padding: '22px 6px 6px',
        animation: 'fadeIn 0.35s ease-out',
      }}
    >
      <div
        style={{
          padding: '24px 18px',
          background:
            'linear-gradient(180deg, rgba(18, 24, 31, 0.94) 0%, rgba(12, 18, 25, 0.98) 100%)',
          border: '1px solid rgba(46, 200, 255, 0.14)',
          'border-radius': '18px',
          'text-align': 'center',
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
          }}
        >
          Ready for your next agent
        </p>
        <p
          style={{
            'font-size': '13px',
            color: 'var(--text-secondary)',
            'line-height': '1.6',
            'max-width': '280px',
            margin: '0 auto',
          }}
        >
          Start or resume an agent from the desktop app and it will appear here instantly.
        </p>
      </div>
    </div>
  );
}

function AgentCard(props: AgentCardProps) {
  const [statusFlashClass, setStatusFlashClass] = createSignal('');

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
      aria-label={`Open ${props.agent.taskName}. Status ${props.agent.status}.`}
      onClick={() => props.onSelect(props.agent.agentId, props.agent.taskName)}
      style={{
        width: '100%',
        background: 'var(--bg-surface)',
        border: `1px solid ${
          props.agent.status === 'running' ? 'rgba(47, 209, 152, 0.25)' : 'var(--border)'
        }`,
        'border-radius': '14px',
        padding: '14px 16px',
        cursor: 'pointer',
        display: 'flex',
        'align-items': 'center',
        gap: '12px',
        'text-align': 'left',
        'touch-action': 'manipulation',
        animation: `cardIn 0.3s ease-out ${props.index * 0.05}s both`,
        'box-shadow':
          props.agent.status === 'running'
            ? '0 10px 24px rgba(47, 209, 152, 0.06)'
            : '0 8px 20px rgba(0, 0, 0, 0.16)',
      }}
    >
      <div
        aria-hidden="true"
        class={`status-indicator ${statusFlashClass()}`}
        style={{
          width: '10px',
          height: '10px',
          'border-radius': '50%',
          background: props.agent.status === 'running' ? 'var(--success)' : 'var(--text-muted)',
          'box-shadow':
            props.agent.status === 'running'
              ? '0 0 10px rgba(47, 209, 152, 0.45)'
              : '0 0 0 rgba(47, 209, 152, 0)',
          transform: props.agent.status === 'running' ? 'scale(1)' : 'scale(0.84)',
          opacity: props.agent.status === 'running' ? '1' : '0.78',
          'flex-shrink': '0',
        }}
      />

      <div style={{ flex: '1', 'min-width': '0' }}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            'margin-bottom': '4px',
            gap: '8px',
          }}
        >
          <span
            style={{
              'font-size': '14px',
              'font-weight': '500',
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
              'font-size': '11px',
              'font-weight': '500',
              color: props.agent.status === 'running' ? 'var(--success)' : 'var(--text-muted)',
              'flex-shrink': '0',
              'text-transform': 'uppercase',
              'letter-spacing': '0.5px',
              transition: 'color 0.22s ease, opacity 0.22s ease',
              opacity: props.agent.status === 'running' ? '1' : '0.85',
            }}
          >
            {props.agent.status}
          </span>
        </div>
        <div
          style={{
            'font-size': '11px',
            'font-family': "'JetBrains Mono', 'Courier New', monospace",
            color: 'var(--text-muted)',
            'white-space': 'nowrap',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            opacity: '0.72',
          }}
        >
          {props.agent.agentId}
        </div>
      </div>

      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ 'flex-shrink': '0', opacity: '0.4' }}
      >
        <path
          d="M6 3l5 5-5 5"
          stroke="var(--text-muted)"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
}

export function AgentList(props: AgentListProps) {
  const [showTopFade, setShowTopFade] = createSignal(false);
  const running = createMemo(() => agents().filter((agent) => agent.status === 'running').length);
  const total = createMemo(() => agents().length);
  const isRecoveringConnection = () => status() === 'connecting' || status() === 'reconnecting';
  const showSkeleton = createMemo(() => total() === 0 && status() === 'connecting');
  const connectionBannerText = () => {
    if (status() === 'connecting') return 'Connecting...';
    if (status() === 'reconnecting') return 'Reconnecting...';
    return 'Disconnected - check your network';
  };

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
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '16px 18px 14px',
          'border-bottom': '1px solid var(--border)',
          background: 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <div
            aria-hidden="true"
            style={{
              width: '28px',
              height: '28px',
              'border-radius': '8px',
              background: 'linear-gradient(135deg, var(--accent) 0%, #1a7a9e 100%)',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M2 4h10M2 7h10M2 10h10"
                stroke="#fff"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </div>
          <span style={{ 'font-size': '17px', 'font-weight': '600', color: 'var(--text-primary)' }}>
            Parallel Code
          </span>
        </div>
        <div
          role="status"
          aria-live="polite"
          aria-label={`Connection ${status()}, ${running()} of ${total()} agents running.`}
          style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}
        >
          <div
            aria-hidden="true"
            class="status-indicator"
            style={{
              width: '8px',
              height: '8px',
              'border-radius': '50%',
              background:
                status() === 'connected'
                  ? 'var(--success)'
                  : isRecoveringConnection()
                    ? 'var(--warning)'
                    : 'var(--danger)',
              'box-shadow':
                status() === 'connected'
                  ? '0 0 8px rgba(47, 209, 152, 0.35)'
                  : isRecoveringConnection()
                    ? '0 0 8px rgba(255, 197, 105, 0.28)'
                    : '0 0 8px rgba(255, 95, 115, 0.2)',
              transform: status() === 'connected' ? 'scale(1)' : 'scale(0.9)',
              ...(isRecoveringConnection()
                ? { animation: 'breathe 1.5s ease-in-out infinite' }
                : {}),
            }}
          />
          <span
            style={{
              'font-size': '13px',
              color: 'var(--text-muted)',
              'font-variant-numeric': 'tabular-nums',
            }}
          >
            {running()}/{total()}
          </span>
        </div>
      </div>

      <Show when={status() !== 'connected'}>
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: '8px 16px',
            background: isRecoveringConnection() ? '#78350f' : '#7f1d1d',
            color: isRecoveringConnection() ? '#fde68a' : '#fca5a5',
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
            gap: '8px',
            '-webkit-overflow-scrolling': 'touch',
            'padding-bottom': 'max(12px, env(safe-area-inset-bottom))',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              'border-radius': '12px',
              'font-size': '12px',
              color: 'var(--text-secondary)',
              'text-align': 'center',
              'line-height': '1.5',
            }}
          >
            Experimental feature.{' '}
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

          <Show when={showSkeleton()}>
            <LoadingSkeleton />
          </Show>

          <Show when={!showSkeleton() && total() === 0 && status() === 'connected'}>
            <ConnectedEmptyState />
          </Show>

          <Show when={!showSkeleton() && total() === 0 && status() !== 'connected'}>
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
              <AgentCard agent={agent} index={index()} onSelect={props.onSelect} />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
