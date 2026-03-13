import { createSignal, onMount, Show } from 'solid-js';
import { initAuth } from './auth';
import { authRequired, connect } from './ws';
import { AgentList } from './AgentList';
import { AgentDetail } from './AgentDetail';

export function App() {
  const [view, setView] = createSignal<'list' | 'detail'>('list');
  const [detailAgentId, setDetailAgentId] = createSignal('');
  const [detailTaskName, setDetailTaskName] = createSignal('');
  const [transition, setTransition] = createSignal<'none' | 'slide-right' | 'slide-left'>('none');

  function selectAgent(id: string, name: string) {
    setDetailAgentId(id);
    setDetailTaskName(name);
    setTransition('slide-right');
    setView('detail');
  }

  function goBack() {
    setTransition('slide-left');
    setView('list');
  }

  onMount(() => {
    initAuth();
    connect();
  });

  const animStyle = () => {
    const t = transition();
    if (t === 'slide-right') return 'slideInRight 0.25s ease-out both';
    if (t === 'slide-left') return 'slideInLeft 0.25s ease-out both';
    return 'none';
  };

  return (
    <Show
      when={!authRequired()}
      fallback={
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            height: '100%',
            color: 'var(--text-muted)',
            'font-size': '16px',
            padding: '20px',
            'text-align': 'center',
            animation: 'fadeIn 0.5s ease-out',
          }}
        >
          <div>
            <div
              style={{
                width: '48px',
                height: '48px',
                margin: '0 auto 20px',
                'border-radius': '12px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'font-size': '24px',
              }}
            >
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z"
                  stroke="var(--text-muted)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </div>
            <p style={{ 'margin-bottom': '12px', color: 'var(--text-secondary)' }}>
              Not authenticated
            </p>
            <p style={{ 'font-size': '13px', color: 'var(--text-muted)' }}>
              Open the shared browser link again or rescan the QR code from Parallel Code.
            </p>
          </div>
        </div>
      }
    >
      <div style={{ width: '100%', height: '100%', animation: animStyle() }}>
        <Show when={view() === 'detail'} fallback={<AgentList onSelect={selectAgent} />}>
          <AgentDetail agentId={detailAgentId()} taskName={detailTaskName()} onBack={goBack} />
        </Show>
      </div>
    </Show>
  );
}
