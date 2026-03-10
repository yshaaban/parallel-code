import { For, Show, createMemo } from 'solid-js';
import { agents, status } from './ws';
import type { RemoteAgent } from '../../electron/remote/protocol';

interface AgentListProps {
  onSelect: (agentId: string, taskName: string) => void;
}

export function AgentList(props: AgentListProps) {
  const running = createMemo(() => agents().filter((a) => a.status === 'running').length);
  const total = createMemo(() => agents().length);
  const isRecoveringConnection = () => status() === 'connecting' || status() === 'reconnecting';
  const connectionBannerText = () => {
    if (status() === 'connecting') return 'Connecting...';
    if (status() === 'reconnecting') return 'Reconnecting...';
    return 'Disconnected — check your network';
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
      {/* Header */}
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
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
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
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <div
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

      {/* Connection status banner */}
      <Show when={status() !== 'connected'}>
        <div
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

      {/* Agent cards */}
      <div
        style={{
          flex: '1',
          overflow: 'auto',
          padding: '12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
          '-webkit-overflow-scrolling': 'touch',
          'padding-bottom': 'max(12px, env(safe-area-inset-bottom))',
        }}
      >
        <Show when={agents().length === 0}>
          <div
            style={{
              'text-align': 'center',
              color: 'var(--text-muted)',
              'padding-top': '60px',
              'font-size': '14px',
              animation: 'fadeIn 0.4s ease-out',
            }}
          >
            <Show when={status() === 'connected'} fallback={<span>Connecting...</span>}>
              <div>
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  style={{ margin: '0 auto 12px', opacity: '0.4' }}
                >
                  <path
                    d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
                    stroke="var(--text-muted)"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span>No active agents</span>
              </div>
            </Show>
          </div>
        </Show>

        {/* Experimental notice */}
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
            style={{ color: 'var(--accent)' }}
          >
            Report bugs
          </a>
        </div>

        <For each={agents()}>
          {(agent: RemoteAgent, i) => (
            <div
              onClick={() => props.onSelect(agent.agentId, agent.taskName)}
              style={{
                background: 'var(--bg-surface)',
                border: `1px solid ${agent.status === 'running' ? 'rgba(47, 209, 152, 0.25)' : 'var(--border)'}`,
                'border-radius': '14px',
                padding: '14px 16px',
                cursor: 'pointer',
                display: 'flex',
                'align-items': 'center',
                gap: '12px',
                'touch-action': 'manipulation',
                transition: 'background 0.16s ease, border-color 0.16s ease, transform 0.1s ease',
                animation: `cardIn 0.3s ease-out ${i() * 0.05}s both`,
              }}
            >
              {/* Status indicator */}
              <div
                style={{
                  width: '10px',
                  height: '10px',
                  'border-radius': '50%',
                  background: agent.status === 'running' ? 'var(--success)' : 'var(--text-muted)',
                  'flex-shrink': '0',
                  ...(agent.status === 'running'
                    ? { 'box-shadow': '0 0 8px rgba(47, 209, 152, 0.4)' }
                    : {}),
                }}
              />

              {/* Content */}
              <div style={{ flex: '1', 'min-width': '0' }}>
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'space-between',
                    'margin-bottom': '4px',
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
                    {agent.taskName}
                  </span>
                  <span
                    style={{
                      'font-size': '11px',
                      'font-weight': '500',
                      color: agent.status === 'running' ? 'var(--success)' : 'var(--text-muted)',
                      'flex-shrink': '0',
                      'text-transform': 'uppercase',
                      'letter-spacing': '0.5px',
                      'margin-left': '8px',
                    }}
                  >
                    {agent.status}
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
                    opacity: '0.7',
                  }}
                >
                  {agent.agentId}
                </div>
              </div>

              {/* Chevron */}
              <svg
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
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
